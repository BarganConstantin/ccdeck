// Never put a dead login under every session on the machine (#2184).
//
// Every Claude Code session on a machine shares one login. `cswap switch N`
// writes slot N's stored copy over it, and when that copy's refresh token is
// already dead every running session fails within seconds with "Login expired ·
// Please run /login". On the owner's machine that was three of the seven login
// interruptions in the month before this was written.
//
// claude-swap's own `auto` engine refreshes a target before it activates it and
// quarantines one whose refresh is refused. A plain `cswap switch` does neither,
// and that is the command the deck runs. So the deck asks claude-swap's store
// first, and refuses only on evidence: a dead-login error on the slot's own
// usage row, newer than the last good read and the last sign-in. Anything it
// cannot tell — no row, a row for somebody else, a store it cannot read — lets
// the switch go ahead exactly as it did before.
//
// WHY NOT ASK CLAUDE-SWAP ABOUT ONE SLOT. 0.26.0 has no command that checks a
// single account. `cswap list --json` is the nearest: a collection over every
// account that is due, under claude-swap's own locks, which refreshes an
// expired stored token through its one-time-grant gate and strikes the slot
// when the refresh is refused. It never re-reads a slot it has already struck,
// and it skips one its plan says is not due. So the deck asks for one only when
// it would actually read the target (collectionWouldRead) — the 2026-10-12
// incident was exactly that case: slot 5 last read ten minutes earlier, its
// poll overdue, and the refusal that proved its login dead recorded one second
// AFTER the switch had put it live.
//
// Pure: no file, no clock, no subprocess. claude-accounts.mjs reads the store
// and asks these, and account-routes.mjs hands removeLeavingLiveLogin its three
// steps.

/** claude-swap's two words for a stored refresh token only a sign-in can
 *  replace — its PERMANENT_AUTH_ERRORS. The panel says "login expired". */
export const DEAD_LOGIN_ERRORS = new Set(["invalid_grant", "no_refresh_token"]);

/** claude-swap's SERVE_TTL_S: younger than this, an on-demand collection
 *  serves the row from the store and fetches nothing. */
const SERVE_TTL_MS = 180_000;

/** A claude-swap timestamp (epoch seconds) in ms, or null. */
function ms(seconds) {
  const v = typeof seconds === "number" ? seconds * 1000 : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Whether a slot's stored login is KNOWN dead, from its usage row.
 *
 * `matches` is rowIsFor's answer — a row left by the slot's previous occupant
 * says nothing about this one. `signedInAt` is when the deck last signed this
 * account in, in ms, or null.
 *
 * Dead is claude-swap's strike (`authDeadStrikes`, set by an `invalid_grant` or
 * `no_refresh_token` and lifted by a good read or by any write of a new
 * credential — add, import, a sign-in) or that error on a failing row, from a
 * store that predates the strike count. And only when the refusal is the newest
 * thing known about the login: a good read or a sign-in after it is about a
 * login that has since worked. Transient errors — a 429, a timeout, a network
 * that is not there — are never evidence either way.
 *
 * Answers `{ error, since }`, `since` being when the refusal was recorded (ms,
 * or null when the row does not say), or null.
 */
export function deadLoginOf(row, { matches = false, signedInAt = null } = {}) {
  if (!matches || !row || typeof row !== "object") return null;
  const struck = Number(row.authDeadStrikes) >= 1;
  const refused = Number(row.consecutiveFailures) > 0 && DEAD_LOGIN_ERRORS.has(row.lastError);
  if (!struck && !refused) return null;
  const failedAt = ms(row.lastAttemptAt);
  const goodAt = ms(row.fetchedAt);
  if (failedAt != null && goodAt != null && goodAt > failedAt) return null;
  if (failedAt != null && Number.isFinite(signedInAt) && signedInAt > failedAt) return null;
  return { error: DEAD_LOGIN_ERRORS.has(row.lastError) ? row.lastError : "invalid_grant", since: failedAt };
}

/**
 * Whether a `cswap list` asked for right now would read this row — claude-swap's
 * own on-demand rule (usage_store._row_eligible with respect_plans), so the deck
 * spends a collection on a switch only when it can change the answer.
 *
 * No row, or one for somebody else, is read on the first pass. A struck row is
 * never read again, a row in backoff or claimed by another collector waits, and
 * otherwise it must be both older than the serve TTL and past its planned poll.
 */
export function collectionWouldRead(row, { matches = false, now }) {
  if (!matches || !row || typeof row !== "object") return true;
  if (Number(row.authDeadStrikes) >= 1) return false;
  const backoff = ms(row.backoffUntil);
  if (backoff != null && backoff > now) return false;
  const claim = ms(row.claimUntil);
  if (claim != null && claim > now) return false;
  const fetched = ms(row.fetchedAt);
  const next = ms(row.nextPollAt);
  return (fetched == null || now - fetched > SERVE_TTL_MS) && (next == null || now >= next);
}

// ── removing the active account ─────────────────────────────────────────────
//
// `cswap remove` deletes the slot's stored copy and its entry, and nothing else:
// it does not activate another slot, and Claude Code stays signed in as the
// account that was removed. When that login works, that is the right thing to
// leave alone — every session goes on running. When it is the expired one, the
// sessions are already failing and nothing would ever move them: auto-switch
// will not touch a login claude-swap no longer manages. So then, and only then,
// the deck moves Claude Code to a working account once the removal has landed.
// After it, the dead login belongs to no slot, so `cswap switch` activates the
// target directly instead of refusing to back up the empty login first.

/** The roster's active row when its login is one only a sign-in brings back —
 *  the panel's "Login expired" on the live account. Never a stale copy (#721):
 *  there the user IS signed in, and only claude-swap's copy is dead. */
export function activeLoginExpired(row) {
  if (!row?.active || row.staleCopy) return false;
  if (row.stopped) return row.collector === "relogin_required";
  return DEAD_LOGIN_ERRORS.has(row.error);
}

/** The accounts Claude Code may be moved to, best first: working, not held
 *  out, and with nothing wrong on the row — the freshest reading first, then the
 *  most room. */
export function liveTargets(accounts, leaving) {
  return (Array.isArray(accounts) ? accounts : [])
    .filter(a => a && a.num !== leaving && !a.active && !a.disabled && a.alive === true
      && !a.staleCopy && !a.stopped && !a.error)
    .sort((a, b) => Number(a.stale === true) - Number(b.stale === true) || (b.headroom ?? -1) - (a.headroom ?? -1));
}

/** How many accounts a removal tries before it says none would take over. Each
 *  try can wait on a collection, and a store full of dead logins is a sign-in's
 *  job, not a walk through every slot. */
const MOVE_TRIES = 3;

/**
 * Remove an account, and when it was the active one with its login expired,
 * move Claude Code to a working account afterwards.
 *
 * `roster()` is the roster as it stood before the removal, `remove(num)` is
 * cswap-admin's removeAccount and `switchTo(num)` the switch route's own path,
 * guard included. Answers the removal's own answer, plus `movedTo` (the account
 * now active) or `stillExpired` (nothing could take over).
 */
export async function removeLeavingLiveLogin(num, { roster, remove, switchTo }) {
  const before = await Promise.resolve().then(roster).catch(() => null);
  const removed = await remove(num);
  if (!removed?.ok) return removed;
  const accounts = before?.ok && Array.isArray(before.accounts) ? before.accounts : [];
  const row = accounts.find(a => a?.num === Number(num));
  if (!activeLoginExpired(row)) return removed;
  for (const target of liveTargets(accounts, row.num).slice(0, MOVE_TRIES)) {
    const moved = await Promise.resolve().then(() => switchTo(target.num)).catch(() => null);
    if (moved?.ok) return { ...removed, movedTo: { num: target.num, email: target.email ?? null, alias: target.alias ?? null } };
    // Only a target refused for its own login is a reason to try the next one.
    // Anything else — no claude-swap, a timeout — would refuse the next as well.
    if (moved?.reason !== "login_expired") break;
  }
  return { ...removed, stillExpired: true };
}
