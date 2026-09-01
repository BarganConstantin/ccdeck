// Multi-account Claude usage, read out of claude-swap's store.
//
// Anthropic has no endpoint that reports usage for an account you are not
// logged into: the only way is to hold that account's OAuth token and call
// /api/oauth/usage once per account. claude-swap already does exactly that,
// and pays the whole cost of it — credential custody, one-time refresh tokens
// (double-spending one permanently kills an account), macOS Keychain access,
// and a request budget of roughly 28-30 calls per rolling hour PER ACCOUNT
// that is shared across every tool on the machine.
//
// So agents-deck does not fetch. It reads what claude-swap already fetched and
// renders it. Nothing here makes a network call or writes a credential, which
// means the deck cannot 429 the user's account, cannot burn a refresh token,
// and cannot lose a login. Switching shells out to `cswap` rather than
// reimplementing the lock protocol its correctness depends on.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cswapBin, cswapVersion, installHint } from "./cswap-install.mjs";
import { run, runDetached } from "./exec.mjs";
// The CLI identity oracle, already written and already trusted by the account
// admin routes. #721 needs the same answer, so it reuses the same function
// rather than shelling out a second way to ask one question.
import { currentIdentity } from "./cswap-admin.mjs";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";

// claude-swap keeps its store under XDG on Linux and in the home directory
// everywhere else (paths.py get_backup_root).
//
// A relative XDG_DATA_HOME is ignored, per the XDG base-dir spec: those paths
// must be absolute, and the alternative is a store root resolved against
// whatever directory the deck happened to be launched from — a different one
// per terminal. `/` is the whole test because this branch only runs on Linux.
//
// Exported because cswap-admin.mjs reads sequence.json out of the same root to
// work out which slot `cswap add` just created. Two copies of this rule that
// disagree means the reader and the writer look at two different stores, and
// the panel reports a successful add as having produced nothing.
export function backupRoot() {
  if (process.env.CLAUDE_SWAP_BACKUP) return process.env.CLAUDE_SWAP_BACKUP;
  if (platform() === "linux") {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && xdg.startsWith("/")) return join(xdg, "claude-swap");
    return join(homedir(), ".local/share/claude-swap");
  }
  return join(homedir(), ".claude-swap-backup");
}

let _cache   = null;
let _cacheAt = 0;
// Short: these are local file reads, and the point of the panel is that it
// tracks what claude-swap is doing. No network cost to amortise.
const CACHE_MS = 5_000;

// ── what a forced read may cost ──────────────────────────────────────────────
//
// Until #604 the cache above was the whole of the admission control here, and
// `force` walked straight past it. `handleClaudeAccounts` reads `refresh=1` off
// the query string and passes it through, and reads on this server are
// deliberately open — `isTrustedRead` does not apply the `Sec-Fetch-Site` test
// that `isTrustedMutation` does, because a cross-site read of
// `http://127.0.0.1:4317` is an ordinary top-level navigation — so any page the
// user had open could run a `?refresh=1` loop and get one roster read per
// request, concurrently.
//
// What that buys is the cheapest of the six forcible routes and it is worth
// saying so plainly rather than dressing it up: two small local JSON reads,
// sequence.json and cache/usage.json, plus a call into nudgeCollector that is
// throttled on its own terms and spawns nothing when nothing is due. There is no
// network here by design — see the note at the top of this file — and no
// subprocess per request. This is the SHAPE the four routes before it were fixed
// for, not a cost anyone would have noticed.
//
// The reason to fix it anyway is the second half. This is the only one of the
// six whose cache is invalidated from elsewhere — nine call sites in four
// modules: six mutations in cswap-admin.mjs, an auto-switch in cswap-auto.mjs, a
// manual one in index.mjs, and the first `cswap add` below — and #582 has
// already shown what a read that started before an invalidation does when it
// lands after one. So the in-flight slot this route was missing arrives with the
// generation guard that makes it safe, rather than after the next bug report.
const FORCE_POLL_MS = 60_000;

// A read in progress, offered to callers that arrive while it is running.
let _inflight = null;
// Stamped when a read STARTS rather than when it lands: what the floor rations
// is the trip to disk, and one that is still running has already been paid for.
let _lastReadAt = 0;
// Which roster the reading below is about — as a counter, because the answer is
// about whichever account claude-swap's store says is active, and that can move
// under a read that is already running. invalidateClaudeAccountsCache bumps it;
// every write is stamped with the value that was current when the read STARTED.
// quota.mjs's `_generation`, for quota.mjs's reason (#582).
let _generation = 0;

/**
 * Whether we may go to disk for the roster again.
 *
 * The same shape and the same minute as quota.mjs's `maySelfPoll`, and exported
 * for the same reason it is: this is the rule, it is pure, and it belongs
 * somewhere a test can point at it.
 *
 * Two intervals, like `maySelfPoll`'s. A forced read may beat the cache, but not
 * turn into a poll loop when the button is held down, so it takes the minute the
 * other four forcible routes use. An unforced read takes the cache's own
 * interval — it is the panel's ordinary poll, the cache above has already
 * answered it, and measuring from the START of the last read rather than from
 * its end is the only difference between the two rules.
 */
export function mayReadAccounts({ now, force, lastReadAt }) {
  return now - lastReadAt >= (force ? FORCE_POLL_MS : CACHE_MS);
}

/**
 * The answer to a read the floor refused.
 *
 * A reading, not an error. AccountsPanel renders `data.accounts`, and an
 * `{ ok: false }` refusal would empty the roster for a minute — the deck
 * teaching itself a new failure mode in order to defend against a loop nobody
 * ran. `stale` is the flag quota.mjs, codex-quota.mjs and codex-usage.mjs all
 * use for exactly this, and every account row already carries its own
 * `fetchedAt` from claude-swap's store, which is the age the panel draws and
 * which nothing here touches.
 */
function heldReading(now) {
  if (_cache) return { ..._cache, stale: true };
  // Unreachable in practice, and spelled the way codex-quota.mjs and
  // codex-usage.mjs spell the same state. Every outcome below is cached, a read
  // still running is served by `_inflight`, and the one moment `_cache` is empty
  // with a recent stamp — just after an invalidation — is exactly the moment
  // invalidateClaudeAccountsCache clears the stamp as well.
  return { ok: false, reason: "waiting", fetchedAt: now };
}

// Past this, claude-swap's own numbers are old enough that showing them
// without a marker would misrepresent them (its own trust ceiling is 3600s).
const STALE_AFTER_MS = 15 * 60_000;

// Nudging the collector.
//
// Two throttles, because the cost of asking is not the cost of fetching. When
// claude-swap's plan says nothing is due, `cswap list` fetches nothing — the
// spawn rate is bounded by the plan (one per 180-600s), not by how often we
// ask. So asking often is cheap in requests and only costs a subprocess, and
// asking often is exactly how `cswap watch` stays current: it re-asks every
// three seconds and therefore collects the moment a plan comes due.
//
// The exception is an ask that changes nothing — a claim held by another
// collector, a backoff, a plan that stays overdue. Repeating that every few
// seconds is pure spawn churn, so a second, slower throttle applies until the
// store actually moves.
const NUDGE_EVERY_MS = 15_000;         // when the last ask produced new data
const NUDGE_QUIET_MS = 60_000;         // when it did not
let _lastNudge = 0;
let _lastSeenFetch = 0;                // newest fetchedAt observed, in seconds

// claude-swap's SERVE_TTL_S (180s) plus slack: below this age it serves from
// the store and fetches nothing, so asking earlier only costs a subprocess.
const FRESH_MIN_AGE_MS = 190_000;

// claude-swap's RECENT_429_WINDOW_S. While a 429 is this recent, its own
// congestion control is deliberately holding back, and so do we.
const RECENT_429_MS = 3_600_000;

/**
 * Whether anything is waiting to be collected.
 *
 * Judged per account that actually exists, and an account counts as waiting in
 * three cases:
 *
 *   - it has no usage row at all;
 *   - it has a row whose fetchedAt is not a number. claude-swap writes a row
 *     when an account is added and fills in the numbers when it first polls,
 *     so "row exists" is not the same as "has been fetched" — and that is the
 *     state a freshly added account sits in. Treating the row's existence as
 *     proof of a fetch left a new account reading "never fetched" forever;
 *   - its own schedule says the next poll is due.
 *
 * Rows are consulted only for accounts in the store. A removed account leaves
 * its row behind, permanently overdue and impossible to collect because the
 * account is gone — counting those meant something was always due and the
 * collector was asked every minute for the rest of the session.
 */
export function collectionDue(rows, slots, now) {
  for (const slot of slots) {
    const r = rows[slot];
    if (!r) return true;                                                  // never seen
    if (typeof r.fetchedAt !== "number") return true;                     // seen, never fetched
    if (typeof r.nextPollAt === "number" && r.nextPollAt * 1000 <= now) return true;
  }
  return false;
}

/**
 * Whether the engine path may be used to refresh this row now.
 *
 * claude-swap gates fetches two different ways (usage_store._row_eligible).
 * On-demand surfaces — `cswap list`, status, switch — need the row to be BOTH
 * stale and past its planned poll time. The auto engine needs it to be stale
 * OR due, and stale means older than SERVE_TTL_S, which is 180 seconds. That
 * OR is the whole difference: it is why a plan stretched out to 30 minutes
 * still yields three-minute-old numbers to the engine, and why `cswap list`
 * cannot do the same however often it is called.
 *
 * The plan is stretched for a reason, though, and one of those reasons must be
 * respected rather than routed around: claude-swap runs AIMD congestion
 * control on a budget it shares with every other machine holding the same
 * account (POST_429_BACKOFF_MULT, RECENT_429_WINDOW_S). While an account is
 * recovering from a 429, backing off IS the correct behaviour, and polling
 * every 180 seconds through it would re-saturate exactly the window that needs
 * to drain. So the engine path is used only for a healthy row: no live
 * backoff, no failures, and no 429 seen within claude-swap's own recovery
 * window.
 *
 * Exported for tests.
 */
export function freshenAllowed(row, now, recent429Ms = RECENT_429_MS) {
  if (!row || typeof row.fetchedAt !== "number") return false;   // the list path owns this case
  if (process.env.AGENTS_DECK_NO_FRESHEN === "1") return false;
  if (typeof row.backoffUntil === "number" && row.backoffUntil * 1000 > now) return false;
  if ((row.consecutiveFailures ?? 0) > 0) return false;
  if (typeof row.last429At === "number" && now - row.last429At * 1000 < recent429Ms) return false;
  return true;
}

/** freshenAllowed, plus old enough that asking would actually fetch. */
export function freshenDue(row, now, { minAgeMs = FRESH_MIN_AGE_MS, recent429Ms = RECENT_429_MS } = {}) {
  if (!freshenAllowed(row, now, recent429Ms)) return false;
  // Younger than the serve TTL: claude-swap would answer from the store
  // without fetching, so asking achieves nothing but a subprocess.
  return now - row.fetchedAt * 1000 >= minAgeMs;
}

/**
 * When this account's numbers will next be refreshed, in epoch ms.
 *
 * claude-swap's plan, except for a healthy active account, where the deck's
 * own freshen tick gets there first. Exported for tests.
 */
export function nextReadAt(row, matches, fetchedAtMs, isActive, now) {
  const planned = matches && typeof row?.nextPollAt === "number"
    ? Math.round(row.nextPollAt * 1000)
    : null;
  const freshenAt = (isActive && fetchedAtMs != null && freshenAllowed(row, now))
    ? fetchedAtMs + FRESH_MIN_AGE_MS
    : null;
  if (planned == null) return freshenAt;
  if (freshenAt == null) return planned;
  return Math.min(planned, freshenAt);
}

/**
 * Keep the store moving while someone is looking at it.
 *
 * Without this the panel is only as live as whatever else is running: with no
 * `cswap watch`/`auto`/TUI open, nothing ever writes the store and the panel
 * shows frozen numbers while looking current.
 *
 * Two ways to ask, and the cheaper one is preferred:
 *   - something is due by claude-swap's own plan → `cswap list`, the ordinary
 *     on-demand pass every surface uses;
 *   - nothing is due but the active account's numbers have aged past the serve
 *     TTL → one `cswap auto --once --dry-run`, which is the engine path and so
 *     is judged on staleness rather than on the plan.
 *
 * What dry run guarantees is narrower than the name suggests, and worth stating
 * exactly: it never switches accounts and never writes autoswitch state — the
 * switch call is unreachable behind its dry-run return. Its collect pass, on
 * the other hand, runs unconditionally, which is the point: it fetches, writes
 * usage rows, and can rotate and persist an OAuth token exactly as `cswap list`
 * does. So this is not a read-only call; it is the same collection every other
 * surface performs, minus the switch.
 *
 * Either way claude-swap decides whether a network call actually happens, and
 * this is throttled on top of that.
 */
function nudgeCollector(rows, slots, now, activeNum) {
  // Did the last ask accomplish anything? Cheap proxy: the newest collection
  // timestamp in the store.
  let newest = 0;
  for (const slot of slots) {
    const f = rows[slot]?.fetchedAt;
    if (typeof f === "number" && f > newest) newest = f;
  }
  const moved = newest > _lastSeenFetch;
  _lastSeenFetch = Math.max(_lastSeenFetch, newest);

  if (now - _lastNudge < (moved ? NUDGE_EVERY_MS : NUDGE_QUIET_MS)) return;

  const due = collectionDue(rows, slots, now);
  const freshen = !due && freshenDue(rows[String(activeNum)], now);
  if (!due && !freshen) return;

  _lastNudge = now;
  const args = due ? ["list"] : ["auto", "--once", "--dry-run", "--json"];
  // Fire-and-forget: this function is deliberately synchronous so callers never
  // wait on it, and resolving the binary is the only async part.
  cswapBin().then(bin => runDetached(bin, args)).catch(() => {});
}

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

function pctOf(win) {
  const p = win?.pct;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

/** One lane, in the shape the panel's bars already speak. */
function lane(id, label, win) {
  const pct = pctOf(win);
  if (pct == null) return null;
  const resetAt = win?.resets_at ? Date.parse(win.resets_at) : NaN;
  return {
    id,
    label,
    pct,
    // claude-swap stores a countdown string too, but it was computed when the
    // row was written and drifts — the client recomputes from the timestamp.
    resetAt: isNaN(resetAt) ? null : Math.floor(resetAt / 1000),
  };
}

/**
 * Every managed account with whatever usage claude-swap last saw for it.
 *
 * When there is nothing to show, says which of the two reasons it is:
 * "no_cswap" (the tool is not installed, and here is the command for this
 * machine) or "no_accounts" (it is installed but nothing has been added yet).
 * They need different things from the user, and reporting both as one empty
 * panel leaves whichever one they are in with nowhere to go.
 */
export async function fetchClaudeAccounts({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;
  // Offered before the floor: a read that has not finished yet is a reading
  // newer than the cache, which is what refresh asked for, and joining it costs
  // nothing.
  if (_inflight) return _inflight;
  if (!mayReadAccounts({ now, force, lastReadAt: _lastReadAt })) return heldReading(now);
  _lastReadAt = now;

  // `_inflight === mine` rather than a bare clear, which is quota.mjs's guard
  // and is here for quota.mjs's reason: invalidateClaudeAccountsCache drops
  // `_inflight` so the next caller starts a read that knows the roster moved,
  // and that read installs its own promise here. A read from before the switch
  // finishing afterwards would otherwise clear the NEW one on its way out.
  const mine = readRoster(now, _generation)
    .finally(() => { if (_inflight === mine) _inflight = null; });
  _inflight = mine;
  return mine;
}

/**
 * The read itself, split out from the admission control above it so the guard is
 * readable as the four lines it is.
 *
 * `gen` is the generation that was current when this read STARTED, and finish()
 * refuses to write anything under it once that has moved.
 *
 * Every write here happens after at least one await, and
 * invalidateClaudeAccountsCache clears variables — which does nothing to a
 * function that is already running and still holds the old roster in a local. So
 * a switch landing mid-read was followed, milliseconds later, by the pre-switch
 * roster being written straight back over the cleared cache: the invalidation
 * looked like it worked and was undone before the next poll could observe it,
 * and the panel went on showing the account the user had just switched away
 * from. That is #582's defect, in the module #582 did not touch.
 *
 * The read is deliberately not cancelled. Whoever asked for it is still owed an
 * answer, and the answer is not wrong — it is about a roster that has since
 * moved, which makes it a fine return value and a bad cached one.
 */
async function readRoster(now, gen) {
  const finish = (r) => {
    if (gen !== _generation) return r;
    _cache = r;
    _cacheAt = Date.now();
    return r;
  };

  const root = backupRoot();
  const seq  = await readJson(join(root, "sequence.json"));
  if (!seq?.accounts) {
    const version = await cswapVersion();
    return finish(version
      ? { ok: false, reason: "no_accounts", version, fetchedAt: now }
      : { ok: false, reason: "no_cswap", hint: await installHint(), fetchedAt: now });
  }

  const usage = await readJson(join(root, "cache", "usage.json"));
  // A schema bump means the rows may not mean what this code thinks they do.
  const rows = usage?.schemaVersion === 2 ? (usage.accounts ?? {}) : {};

  // Kick a collection for the NEXT poll if anything is due — either because
  // claude-swap's schedule says so, or because an account has never been
  // fetched at all.
  nudgeCollector(rows, Object.keys(seq.accounts), now, seq.activeAccountNumber);

  // Who the CLI says is signed in, asked ONLY when the store claims the active
  // account is in trouble — see authTrouble. That is the one case where the
  // stored verdict and the live truth can disagree, and it is rare: a healthy
  // machine never spends this subprocess. Never fatal, because a CLI that
  // cannot be reached is not evidence either way.
  const activeNum = seq.activeAccountNumber != null ? String(seq.activeAccountNumber) : null;
  const activeRow = activeNum ? rows[activeNum] : null;
  const identity = (activeRow?.consecutiveFailures ?? 0) > 0
    ? await currentIdentity().catch(() => null)
    : null;

  const order = Array.isArray(seq.sequence) && seq.sequence.length
    ? seq.sequence.map(String)
    : Object.keys(seq.accounts).sort((a, b) => Number(a) - Number(b));

  const accounts = [];
  for (const num of order) {
    const acct = seq.accounts[num];
    if (!acct) continue;                       // sequence lists a slot that no longer exists

    const row = rows[num];
    // claude-swap keys usage rows by slot but guards them on identity, because
    // a removed account leaves its row behind and slots get reused. Without
    // the same check the panel would show the previous occupant's numbers.
    const matches = row
      && row.email === acct.email
      && (row.organizationUuid ?? "") === (acct.organizationUuid ?? "");
    const good = matches ? row.lastGood : null;

    const fetchedAtMs = matches && typeof row.fetchedAt === "number" ? row.fetchedAt * 1000 : null;
    const isActive = String(seq.activeAccountNumber) === num;
    const trouble = authTrouble(row, { matches, isActive, identity, email: acct.email });

    const lanes = [
      lane("five_hour", "5h", good?.five_hour),
      lane("seven_day", "7d", good?.seven_day),
      ...(Array.isArray(good?.scoped) ? good.scoped : [])
        .map((s, i) => lane(`scoped-${i}`, s?.name ?? "model", s))
        .filter(Boolean),
    ].filter(Boolean);

    accounts.push({
      num:      Number(num),
      email:    acct.email ?? null,
      alias:    acct.alias ?? null,
      org:      acct.organizationName ?? null,
      active:   String(seq.activeAccountNumber) === num,
      disabled: acct.disabled === true,
      lanes,
      // Headroom against the tightest lane — the number that decides whether
      // this account is worth switching to.
      headroom: lanes.length ? Math.max(0, 100 - Math.max(...lanes.map(l => l.pct))) : null,
      fetchedAt: fetchedAtMs,
      // When this account will next be read — the earlier of claude-swap's own
      // plan and, for a healthy active account, the deck's freshen tick. The
      // plan alone would promise "next in 15m" while the panel actually
      // updates in three.
      nextAt: nextReadAt(row, matches, fetchedAtMs, isActive, now),
      stale:     fetchedAtMs == null || now - fetchedAtMs > STALE_AFTER_MS,
      // Surfaced rather than hidden: a rate-limited or re-login-needed account
      // is exactly the one the user is about to try switching to.
      //
      // Through authTrouble rather than read straight off the row: see #721.
      // consecutiveFailures says the COLLECTOR is failing, which for the active
      // account is not the same claim as the user being signed out — and the
      // CLI can settle that.
      error: trouble?.error ?? null,
      // True when the collector cannot read this account but the user is signed
      // in as it anyway. The panel says so quietly instead of offering to log
      // them in again.
      staleCopy: trouble?.kind === "stale-copy",
    });
  }

  return finish({ ok: true, accounts, activeNum: seq.activeAccountNumber ?? null, fetchedAt: now });
}

/**
 * What to say about an account whose collector is failing — which is not the
 * same question as whether the user is signed out.
 *
 * TWO FACTS, AND #721 SHIPPED THEM AS ONE. claude-swap keeps its own copy of
 * each account's credentials, taken when `cswap add` captured the slot. When
 * that copy's refresh token dies, claude-swap can no longer collect usage for
 * the row and says `relogin_required`. That is true, and it is about the COPY.
 *
 * It says nothing about whether the user is signed in. Measured on the machine
 * that reported this, at the same instant:
 *
 *   claude auth status --json  ->  loggedIn: true, claude3@sapec.md
 *   cswap list --json          ->  claude3@sapec.md: relogin_required
 *   GET /api/quota             ->  source: cli, 5h 33%, 7d 37%
 *
 * The user had signed in again in a terminal, which refreshes the LIVE
 * credentials and leaves claude-swap's stored copy exactly as dead as it was.
 * The deck held live quota numbers for that account and printed "login expired"
 * beside them, and the button it offered ran `claude auth login` — a full
 * re-login of the account the user was mid-session in, to fix a problem they
 * did not have.
 *
 * So: for the ACTIVE account the CLI is the authority, because it is the one
 * thing that can answer about the live credentials rather than about a copy.
 * When it says the user is signed in as this account, there is no login
 * failure to report — only a collector that cannot see it, which is quieter,
 * true, and fixed by re-capturing the slot rather than by signing in again.
 *
 * `identity` is null when the CLI could not be asked at all. That is not
 * evidence of anything, so the stored verdict stands: refusing to show a real
 * expiry because a subprocess failed is the opposite mistake.
 */
export function authTrouble(row, { matches, isActive, identity, email } = {}) {
  if (!matches || !((row?.consecutiveFailures ?? 0) > 0)) return null;

  const signedInHere = isActive
    && identity
    && typeof identity.email === "string"
    && email
    && identity.email.toLowerCase() === String(email).toLowerCase();

  if (signedInHere) {
    // Deliberately not the `error` field: this is not the user's problem to
    // fix under a red badge, and it must not offer to sign them in again.
    return { kind: "stale-copy", error: null };
  }
  return { kind: "auth", error: row.lastError ?? "error" };
}

/**
 * claude-swap's last good usage for whichever account is active right now.
 *
 * The Usage panel wants the same numbers for one account that this panel shows
 * for all of them, and claude-swap has already paid for them. Reading its row
 * instead of asking Anthropic again is the difference between one collector on
 * this machine and two competing for the same per-token budget — the second
 * one is what was 429ing the first.
 *
 * Returns null rather than a partial when anything about the row is unsure:
 * the caller's fallback is to fetch for itself, and a wrong number is worse
 * than a slow one.
 */
export async function activeAccountUsage() {
  const root = backupRoot();
  const seq  = await readJson(join(root, "sequence.json"));
  const num  = seq?.activeAccountNumber != null ? String(seq.activeAccountNumber) : null;
  const acct = num ? seq?.accounts?.[num] : null;
  if (!acct) return null;

  const usage = await readJson(join(root, "cache", "usage.json"));
  if (usage?.schemaVersion !== 2) return null;

  const row = usage.accounts?.[num];
  // Same identity guard the panel uses: rows are keyed by slot, and slots are
  // reused, so a row can outlive the account it was written for.
  if (!row?.lastGood
      || row.email !== acct.email
      || (row.organizationUuid ?? "") !== (acct.organizationUuid ?? "")
      || typeof row.fetchedAt !== "number") return null;

  return {
    num:       Number(num),
    email:     acct.email ?? null,
    lastGood:  row.lastGood,
    fetchedAt: Math.round(row.fetchedAt * 1000),
  };
}

/**
 * Ask claude-swap to collect now, if its own schedule agrees.
 *
 * Exported for the Usage panel's refresh button, which has no other way to ask
 * for fresher numbers once it stopped fetching them itself. Goes through the
 * same throttle and the same `cswap list` as the accounts panel, so pressing
 * refresh cannot outrun the request budget either.
 */
export async function requestCollection() {
  const root  = backupRoot();
  const seq   = await readJson(join(root, "sequence.json"));
  if (!seq?.accounts) return false;
  const usage = await readJson(join(root, "cache", "usage.json"));
  const rows  = usage?.schemaVersion === 2 ? (usage.accounts ?? {}) : {};
  const before = _lastNudge;
  nudgeCollector(rows, Object.keys(seq.accounts), Date.now(), seq.activeAccountNumber);
  return _lastNudge !== before;
}

/**
 * Forget the roster, because something just made it wrong.
 *
 * Called from nine places in four modules — every `cswap` mutation the deck
 * performs — and every one of them is behind a POST that `isTrustedMutation`
 * guards, so nothing a page can send in a loop reaches this.
 *
 * Three things go besides the reading itself:
 *
 *   `_generation`  so a read that STARTED before this call cannot write its
 *                  answer into the cache afterwards. See finish() in readRoster.
 *   `_inflight`    so a caller arriving after the switch is not handed the read
 *                  that began before it — joining a run is only free when the
 *                  run is still about the right thing.
 *   `_lastReadAt`  so the very next read is real work rather than a refusal.
 *                  Every one of these call sites is followed by the panel
 *                  reloading with ?refresh=1, and a floor that answered THAT
 *                  with the pre-switch roster would make the guard the bug.
 */
export function invalidateClaudeAccountsCache() {
  _cache = null;
  _cacheAt = 0;
  _generation++;
  _inflight = null;
  _lastReadAt = 0;
}

/**
 * Switch the active Claude account by delegating to `cswap`.
 *
 * Not reimplemented here on purpose. A correct switch has to hold three of
 * Claude Code's own lock files, in its order, with its staleness values, or it
 * can interleave with Claude Code's token refresh and clobber it. cswap does
 * that; a second implementation racing it would be worse than useless.
 */
export function switchClaudeAccount(accountNum) {
  // Straight into an exec argument, so nothing but a slot number gets through.
  const num = Number(accountNum);
  if (!Number.isInteger(num) || num < 1 || num > 999) {
    return Promise.resolve({ ok: false, reason: "bad_account" });
  }

  // Argument vector, never a shell — and resolved through exec.mjs so the
  // Windows `.exe`/`.cmd` shim is found too.
  return cswapBin()
    .then(bin => run(bin, ["switch", String(num)], { timeout: 30_000 }))
    .then(r => {
      if (r.ok) return { ok: true, output: r.stdout.trim() };
      const reason = r.code === "ENOENT" ? "no_cswap" : r.killed ? "timeout" : "switch_failed";
      return { ok: false, reason, output: (r.stderr || r.stdout).trim().slice(0, 500) };
    });
}


/**
 * Register the account already signed in, the first time and only the first
 * time.
 *
 * A fresh install leaves claude-swap with an empty store, so the panel comes up
 * saying "no accounts added yet" and telling the user to run `cswap add`
 * themselves — for the account they are already using, on the machine they are
 * already on. Running it for them is the difference between the panel working
 * and the panel being a to-do item.
 *
 * `cswap add` takes no arguments, prompts for nothing, and does not sign
 * anyone in: it records the Claude Code session that already exists. Even so it
 * is bounded tightly, because it writes to a credential store:
 *
 *   - only when the store holds no accounts at all, so nothing can be
 *     overwritten or reordered;
 *   - only once ever, marked on disk, so a user who deliberately removes their
 *     last account does not get it added back on the next launch;
 *   - never when AGENTS_DECK_NO_INSTALL=1.
 *
 * Failure is normal and quiet: on a machine where Claude Code has never signed
 * in there is nothing to record.
 */
const SEED_MARKER = join(homedir(), ".agents-deck", ".cswap-seeded");

/**
 * How many accounts a sequence.json holds.
 *
 * claude-swap writes `accounts` as an object keyed by slot number — {"2": {…},
 * "3": {…}} — not as a list. An Array.isArray guard here read that as "no
 * accounts" and ran `cswap add` against a populated store, which is exactly
 * what the guard existed to prevent. Both shapes are accepted now, and
 * anything unrecognised counts as -1: unknown is not the same as empty, and
 * only a confident zero may lead to a write.
 */
export function accountCount(seq) {
  const a = seq?.accounts;
  if (Array.isArray(a)) return a.length;
  if (a && typeof a === "object") return Object.keys(a).length;
  if (a == null && seq && typeof seq === "object") return 0;   // store exists, no accounts yet
  return -1;                                                    // unreadable — do nothing
}

export async function seedFirstAccount() {
  if (process.env.AGENTS_DECK_NO_INSTALL === "1") return { state: "skipped" };
  if (existsSync(SEED_MARKER)) return { state: "already-tried" };

  // Empty store only. A store with accounts in it is the user's, not ours, and
  // a store we cannot parse is treated the same way.
  // No file at all is the fresh install this exists for; a file that will not
  // parse is a store in an unknown state. readJson answers null to both, so
  // they are told apart before deciding, because they call for opposite
  // decisions — seed, and keep well away.
  const seqPath = join(backupRoot(), "sequence.json");
  const before = existsSync(seqPath) ? accountCount(await readJson(seqPath)) : 0;
  if (before > 0) return { state: "has-accounts", count: before };
  if (before < 0) return { state: "unreadable-store" };

  // Mark before running, not after: if `cswap add` half-succeeds or the process
  // dies mid-way, the retry-forever loop is the worse outcome.
  try {
    await mkdir(dirname(SEED_MARKER), { recursive: true });
    await writeFile(SEED_MARKER, new Date().toISOString());
  } catch { /* best-effort — worst case it is attempted again */ }

  const r = await run(await cswapBin(), ["add"], { timeout: 60_000 });
  if (!r.ok) {
    return { state: "failed", detail: (r.stderr || r.stdout).trim().slice(0, 200) };
  }

  invalidateClaudeAccountsCache();
  const count = existsSync(seqPath) ? accountCount(await readJson(seqPath)) : 0;
  if (count > 0) {
    // Collect straight away. Otherwise the first thing the user sees is their
    // account listed with "never fetched" beside it, waiting on a poll cycle
    // for numbers that are the reason the panel exists.
    runDetached(await cswapBin(), ["list"]);
  }
  return count > 0 ? { state: "added", count } : { state: "nothing-to-add" };
}
