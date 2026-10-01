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
import { cswapBin, cswapInstalling, cswapRefusal, cswapVersion, installHint } from "./cswap-install.mjs";
import { run, runDetached } from "./exec.mjs";
import { failureDetail } from "./exec-output.mjs";
import { storedCopyAlive } from "./account-health.mjs";
// The CLI identity oracle, already written and already trusted by the account
// admin routes. #721 needs the same answer, so it reuses the same function
// rather than shelling out a second way to ask one question.
//
// FROM claude-identity.mjs, NOT FROM cswap-admin.mjs. This one import was the
// single edge that closed the only static import cycle in src/server —
// cswap-admin.mjs imports this file back for `backupRoot`,
// `invalidateClaudeAccountsCache` and `verdictNow` — and a cycle is not merely
// untidy: two dynamic imports entering one concurrently are each handed the
// other module's half-built namespace, which has no exports on it at all. The
// boot wires `repairStaleCopyWith` across exactly that pair, and on CI it was
// handed two empty namespaces and wired nothing, silently. The oracle lives in
// a module that imports only leaves now, so both sides can reach it and neither
// closes a loop.
import { currentIdentity } from "./claude-identity.mjs";
// The one mutex, from the module that exists so that both halves of the
// accounts surface can reach it. Not from cswap-admin.mjs, which imports THIS
// file: the dependency has to go the other way, and a lock imported over a
// cycle is a lock that may not be there yet when a mutation wants it.
import { withStoreLock } from "./store-lock.mjs";
// claude-swap's own per-slot verdicts, which have to be ASKED for rather than
// read off the store. The roster puts them on each row; verdictNow and
// verdictsNow are re-exported because cswap-admin.mjs and lan-deck.mjs reach
// them through this module.
import { verdictFor } from "./claude-verdicts.mjs";
export { verdictNow, verdictsNow } from "./claude-verdicts.mjs";
// Asking claude-swap to collect, which every roster read does when something is
// due, and when each account will next be read.
import { nextReadAt, nudgeCollector } from "./claude-collector.mjs";
// Which accounts the deck signed in itself, and the incident one of them is in
// (#1893). Pure, and keyed the way LAN sync keys accounts.
import { hasRecovered, reauthFor } from "./account-origins.mjs";
import { accountKey } from "./lan-copies.mjs";
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
    // `~` IS EXPANDED BEFORE THE ABSOLUTENESS TEST (#796), which is what
    // claude-swap's own paths.py does: `Path(os.path.expanduser(xdg))` and then
    // `is_absolute()`, under a docstring saying it exists so that "values like
    // `~/data` set via systemd unit files or Dockerfiles (which don't get shell
    // expansion) still work". This function claims to mirror that and did not.
    //
    // Unexpanded, `XDG_DATA_HOME=~/data` failed `startsWith("/")` and the deck
    // read ~/.local/share/claude-swap while cswap read and wrote
    // ~/data/claude-swap. The Accounts panel then reported `no_accounts` while
    // `cswap list` showed the roster — and the damaging part is
    // `seedFirstAccount`, which reads a missing sequence file as zero accounts,
    // passes its `before > 0` guard, and runs `cswap add` against a populated
    // store, re-pointing activeAccountNumber with nothing here to restore it.
    const raw = process.env.XDG_DATA_HOME;
    const xdg = raw === "~" ? homedir()
      : raw?.startsWith("~/") ? join(homedir(), raw.slice(2))
      : raw;
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
// six whose cache is invalidated from elsewhere — by every mutation in
// cswap-admin.mjs, the auto-switch tick in cswap-auto-loop.mjs, the rotation
// flag in cswap-auto.mjs, the manual switch in account-routes.mjs and the first
// `cswap add` below, and by lan-deck.mjs once it has asked claude-swap for
// fresh verdicts — and #582 has already shown what a read that started before
// an invalidation does when it lands after one. So the in-flight slot this
// route was missing arrives with the generation guard that makes it safe,
// rather than after the next bug report.
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
 * The same shape as quota.mjs's `maySelfPoll`, and exported for the same reason
 * it is: this is the rule, it is pure, and it belongs somewhere a test can
 * point at it.
 *
 * An unforced read takes the cache's own interval — it is the panel's ordinary
 * poll, the cache above has already answered it, and measuring from the START
 * of the last read rather than from its end is the only difference between the
 * two rules.
 *
 * A forced read takes the SHORTER of the minute the other forcible routes use
 * and that same interval, which is the cache's (#1798). It had the minute on its
 * own, and the panel's fifteen-second poll stamps `_lastReadAt` every time, so
 * while the panel was open ↻ was always inside its floor and was handed the held
 * reading — even at a moment when an ordinary poll would have gone to disk. The
 * deck's own mutations got past that by invalidating; a `cswap switch` typed in
 * a terminal, or the user's own engine moving the account, has nothing to
 * invalidate with, and the press did nothing exactly when it was wanted. What
 * #604 was protecting still holds: a button held down or a page looping on
 * `?refresh=1` costs one pair of small JSON reads per five seconds, which is
 * what the unforced poll was already allowed.
 */
export function mayReadAccounts({ now, force, lastReadAt }) {
  return now - lastReadAt >= (force ? Math.min(FORCE_POLL_MS, CACHE_MS) : CACHE_MS);
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

/**
 * How long a collector may produce nothing before that is a fault rather than a
 * cadence.
 *
 * TWELVE HOURS, and the number is chosen from what the failure actually looks
 * like rather than from taste. Measured on the machine that reported this: three
 * accounts last collected 21 hours, 40 hours and 28 days ago, every one of them
 * with `consecutiveFailures: 0` — because the thing stopping them was
 * `keychain_unavailable`, which is claude-swap failing to OPEN the credential
 * rather than having it rejected, and which never touches that counter.
 *
 * Long enough that a laptop closed overnight does not trip it. Short enough that
 * an account nobody can read stops being advertised to the group as one they
 * can. And the cost of being wrong is deliberately lopsided: a false "not
 * collecting" asks a peer for a blob that `cswap import` then declines, because
 * a plain import skips an account that is present and healthy — while the false
 * negative this replaces is an account that is never repaired by anything, ever,
 * and is published to every paired deck as good.
 */
const COLLECTION_STOPPED_AFTER_MS = 12 * 60 * 60_000;

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

/** claude-swap's sequence.json — the accounts, their order and which slot is
 *  active — or null when it is missing or will not parse. seedFirstAccount
 *  tells those two apart first, so it reads the file itself. */
async function readSequence(root) {
  return readJson(join(root, "sequence.json"));
}

/** The slot a sequence.json names as active, as the string its `accounts` are
 *  keyed by, or null when it names none. */
function activeSlot(seq) {
  return seq?.activeAccountNumber != null ? String(seq.activeAccountNumber) : null;
}

/** The usage rows in claude-swap's cache/usage.json, keyed by slot — see
 *  usageRows for which of them may be believed. */
async function readUsageRows(root) {
  return usageRows(await readJson(join(root, "cache", "usage.json")));
}

/**
 * The rows of a parsed usage.json, or none at all.
 *
 * A schema bump means the rows may not mean what this code thinks they do, so
 * a file in any schema but 2 has no rows. Three readers go through this — the
 * roster, the Usage panel's active account and the refresh button's collection
 * request — and a rule spelled three times is three places for one of them to
 * trust a row the other two refuse. Exported for its test.
 */
export function usageRows(usage) {
  return usage?.schemaVersion === 2 ? (usage.accounts ?? {}) : {};
}

/**
 * Whether a usage row was written for this account.
 *
 * claude-swap keys usage rows by slot but guards them on identity, because a
 * removed account leaves its row behind and slots get reused. Without the same
 * check the panel would show the previous occupant's numbers, and the Usage
 * panel — which reads the active account's row through activeAccountUsage —
 * would put them under this account's name. Both readers ask here, so they
 * cannot disagree about whose row it is. Exported for its test.
 */
export function rowIsFor(row, acct) {
  return Boolean(row)
    && row.email === acct.email
    && (row.organizationUuid ?? "") === (acct.organizationUuid ?? "");
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
 * When there is nothing to show, says which of the four reasons it is:
 * "cswap_installing" (the deck is installing the tool and there is nothing to
 * do), "no_cswap" (the tool is not installed, and here is the command for this
 * machine), "no_accounts" (it is installed but nothing has been added yet) or
 * "cswap_refused" (the copy that answers is one the deck installed and refused
 * to drive). They need different things from the user, and reporting them as
 * one empty panel leaves whichever one they are in with nowhere to go.
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

// ── the repair nobody should have to press ───────────────────────────────────
//
// A `stale-copy` row — claude-swap's stored copy of the signed-in account's
// login was rejected, while the login itself works — has exactly one repair,
// and it asks the user nothing: re-capture the copy from the login they already
// have (cswap-admin's recaptureActive). It was a button, `resume`, which asked a
// person to confirm the only answer there is. So the read that finds the state
// starts the repair, and the row carries how it is going instead of a button.
//
// HANDED IN, NOT IMPORTED. The repair writes a credential into claude-swap's
// store, and this module is read by dozens of tests against fixture stores. The
// server hands it in when it starts listening (wireStaleCopyRepair, in
// account-routes.mjs) and nothing else does, so no test run can reach
// `cswap add` through a read.
let _repairStaleCopy = null;

/** Called with `{ num, email, now }` for a `stale-copy` row, and returns that
 *  row's `repair`. Null unregisters. */
export function repairStaleCopyWith(fn) {
  _repairStaleCopy = typeof fn === "function" ? fn : null;
}

/** The registered repair's state for one row. A repair that throws costs the
 *  row its state, never the read. */
function repairFor(num, email, now) {
  if (!_repairStaleCopy) return null;
  try { return _repairStaleCopy({ num, email, now }) ?? null; } catch { return null; }
}

// ── which accounts the deck signed in (#1893) ────────────────────────────────
//
// HANDED IN, NOT IMPORTED, for the stale-copy repair's reason: what the deck
// remembers lives in prefs.json, and this module is read by dozens of tests
// against fixture stores that must never reach the user's own settings. The
// server hands it in when it starts listening (wireAccountOrigins, in
// account-routes.mjs); with nothing handed in, no row has an origin.
let _origins = null;

/**
 * `{ entries, recovered }`: `entries()` answers prefs.json's `accounts` map as
 * held in memory, and `recovered(keys)` is told which accounts were read well
 * after an incident somebody put off. Null unregisters.
 */
export function accountOriginsWith(source) {
  _origins = source && typeof source.entries === "function" ? source : null;
}

/** The map as it stands. One that throws costs the roster its origins, never
 *  the read. */
function originsNow() {
  try { return _origins?.entries() ?? {}; } catch { return {}; }
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

  // A COPY THE DECK REFUSED (#1799), before the store is even read. Its roster
  // would be a panel whose every button — Add, Switch, Remove — runs that copy,
  // and its empty store read as `no_accounts`, which is "installed, add one".
  const refused = await cswapRefusal();
  if (refused) {
    return finish({ ok: false, reason: "cswap_refused", version: refused.version, want: refused.want ?? null, fetchedAt: now });
  }

  const root = backupRoot();
  const seq  = await readSequence(root);
  if (!seq?.accounts) {
    // Asked before the tool is probed: while the deck's own install is running
    // there is nothing a `--version` spawn or installHint's interpreter checks
    // could add, and the one thing the panel must not say is "install it
    // yourself" — see cswapInstalling.
    if (cswapInstalling()) return finish({ ok: false, reason: "cswap_installing", fetchedAt: now });
    const version = await cswapVersion();
    return finish(version
      ? { ok: false, reason: "no_accounts", version, fetchedAt: now }
      : { ok: false, reason: "no_cswap", hint: await installHint(), fetchedAt: now });
  }

  const rows = await readUsageRows(root);

  // Kick a collection for the NEXT poll if anything is due — either because
  // claude-swap's schedule says so, or because an account has never been
  // fetched at all.
  nudgeCollector(rows, Object.keys(seq.accounts), now, seq.activeAccountNumber);

  // Who the CLI says is signed in, asked ONLY when the store claims the active
  // account is in trouble — see authTrouble. That is the one case where the
  // stored verdict and the live truth can disagree, and it is rare: a healthy
  // machine never spends this subprocess. Never fatal, because a CLI that
  // cannot be reached is not evidence either way.
  const activeNum = activeSlot(seq);
  const activeRow = activeNum ? rows[activeNum] : null;
  const identity = (activeRow?.consecutiveFailures ?? 0) > 0
    ? await currentIdentity().catch(() => null)
    : null;

  const order = Array.isArray(seq.sequence) && seq.sequence.length
    ? seq.sequence.map(String)
    : Object.keys(seq.accounts).sort((a, b) => Number(a) - Number(b));

  const origins = originsNow();
  const accounts = [];
  const recovered = [];
  for (const num of order) {
    const acct = seq.accounts[num];
    if (!acct) continue;                       // sequence lists a slot that no longer exists

    const row = rows[num];
    const shown = rosterRow({ seq, num, acct, row, identity, now, origins });
    accounts.push(shown);
    // A put-off incident is over once a read succeeds after it, and the
    // put-off goes with it (#1893) — said here, where the read is, rather than
    // left for the page to notice.
    const key = accountKey(acct.email, acct.organizationUuid);
    if (Object.hasOwn(origins, key) && hasRecovered(origins[key], shown.fetchedAt)) recovered.push(key);
  }
  if (recovered.length) {
    try { _origins?.recovered?.(recovered); } catch { /* the next read says it again */ }
  }

  return finish({ ok: true, accounts, activeNum: seq.activeAccountNumber ?? null, fetchedAt: now });
}

/**
 * One account's row on the roster: who it is, what claude-swap last saw for it,
 * and what is wrong with it, if anything.
 *
 * `row` is the usage row stored under this account's slot, which may belong to
 * whoever held the slot before (see rowIsFor); `identity` is who the CLI says
 * is signed in, or null when readRoster did not need to ask. It reads the
 * verdict cache, and asks the registered repair about a `stale-copy` row —
 * which is what starts that repair (see repairStaleCopyWith).
 */
function rosterRow({ seq, num, acct, row, identity, now, origins = {} }) {
  const matches = rowIsFor(row, acct);
  const good = matches ? row.lastGood : null;

  const fetchedAtMs = matches && typeof row.fetchedAt === "number" ? row.fetchedAt * 1000 : null;
  // When claude-swap last TRIED, well or not. A refusal counts against a login
  // only when it came after the deck last signed that login in (#1893).
  const attemptedAtMs = matches && typeof row.lastAttemptAt === "number" ? row.lastAttemptAt * 1000 : null;
  const isActive = String(seq.activeAccountNumber) === num;
  const trouble = authTrouble(row, {
    matches, isActive, identity, email: acct.email, fetchedAt: fetchedAtMs, now,
  });

  const lanes = [
    lane("five_hour", "5h", good?.five_hour),
    lane("seven_day", "7d", good?.seven_day),
    ...(Array.isArray(good?.scoped) ? good.scoped : [])
      .map((s, i) => lane(`scoped-${i}`, s?.name ?? "model", s))
      .filter(Boolean),
  ].filter(Boolean);

  const collector = verdictFor(num, now, acct.email, acct.organizationUuid);
  const key = accountKey(acct.email, acct.organizationUuid);
  const origin = Object.hasOwn(origins, key) ? origins[key] : null;
  const reauth = reauthFor({ entry: origin, trouble, collector, fetchedAt: fetchedAtMs, attemptedAt: attemptedAtMs });
  return {
    num:      Number(num),
    email:    acct.email ?? null,
    alias:    acct.alias ?? null,
    org:      acct.organizationName ?? null,
    // The other half of an account's identity, and the reason a slot number
    // is not one: claude-swap keys on `(email, organizationUuid)` — the same
    // email under two orgs is two accounts on purpose — and assigns slots
    // max+1 per store, so the account that is 4 here is 2 on another machine.
    // Surfaced for LAN sync, which has to match accounts across two stores
    // that grew in a different order.
    orgUuid:  acct.organizationUuid ?? null,
    // Whether CLAUDE-SWAP'S STORED COPY works — not whether the user is
    // signed in. The two differ, and #721 is the whole argument: a
    // `stale-copy` row means the live session is fine while the copy in the
    // store is dead, and the copy is what a share would carry and what a
    // peer's copy would heal. So both kinds of trouble read as not alive.
    alive:    storedCopyAlive(trouble == null, collector),
    active:   isActive,
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
    // How the deck's own repair of that is going — `{ state: "running" }` or
    // `{ state: "failed", reason, retryAt }` — and null on every other row.
    // Asking is what starts it; see repairStaleCopyWith.
    repair: trouble?.kind === "stale-copy" ? repairFor(Number(num), acct.email ?? null, now) : null,
    // Nothing has been collected for this account in half a day, and nothing
    // says why. Its own word because the two existing ones would both be
    // wrong: `error` claims a rejection that was never reported, and
    // `staleCopy` promises the user is signed in as it, which is only
    // knowable for the active account.
    stopped:   trouble?.kind === "stopped",
    // claude-swap's own verdict for this slot, when there is a fresh one:
    // "no_credentials", "relogin_required", "keychain_unavailable", … It is
    // what turns "not collecting" into a sentence with a next step in it, and
    // it is null on every machine where the collector has not been asked yet.
    collector,
    // "ccdeck_signin" when the deck's own `+ → Sign in` added this account,
    // and null for every other way an account arrives (#1893).
    origin: origin?.origin ?? null,
    // The incident this account is in, when it is one the deck signed in and
    // claude-swap has refused its login since: `{ key, since, dismissed }`.
    // `key` and `since` together name it, for "Not now" to send back.
    reauth: reauth ? { key, ...reauth } : null,
  };
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
export function authTrouble(row, {
  matches, isActive, identity, email,
  fetchedAt = null, now = Date.now(), stoppedAfterMs = COLLECTION_STOPPED_AFTER_MS,
} = {}) {
  if (!matches) return null;
  const failing = (row?.consecutiveFailures ?? 0) > 0;
  // A COLLECTOR THAT HAS PRODUCED NOTHING IN HALF A DAY IS FAILING, whatever
  // its counter says — see COLLECTION_STOPPED_AFTER_MS. `consecutiveFailures`
  // counts rejections, and the failure found on the reporting machine was not a
  // rejection: `cswap list` answered `usageStatus: keychain_unavailable` for
  // three accounts whose counters all read zero.
  //
  // `fetchedAt == null` is deliberately NOT this. That is an account nobody has
  // ever collected — usually one added a minute ago — and the panel already has
  // a word for it. Calling a new account broken is a worse first impression than
  // saying nothing.
  const stopped = !failing && fetchedAt != null && now - fetchedAt > stoppedAfterMs;
  if (!failing && !stopped) return null;

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
  // A SILENCE, NOT A DIAGNOSIS. All that is known is that nothing has been
  // collected for half a day; the reason lives in claude-swap and may be a dead
  // login, a keychain it cannot open, or a machine that was off. Putting
  // `invalid_grant` on it would be inventing evidence, and the panel would then
  // offer "sign in again" for a problem that may not be a sign-in at all.
  if (stopped) return { kind: "stopped", error: null };
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
  const seq  = await readSequence(root);
  const num  = activeSlot(seq);
  const acct = num ? seq?.accounts?.[num] : null;
  if (!acct) return null;

  const row = (await readUsageRows(root))[num];
  // Same identity guard the panel uses: rows are keyed by slot, and slots are
  // reused, so a row can outlive the account it was written for.
  if (!row?.lastGood || !rowIsFor(row, acct) || typeof row.fetchedAt !== "number") return null;

  return {
    num:       Number(num),
    email:     acct.email ?? null,
    // The other half of the account's identity. quota.mjs matches the saved
    // limit resets it reads with Claude Code's token against both halves
    // before it puts them beside these numbers (#1308).
    organizationUuid: acct.organizationUuid ?? null,
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
  const seq   = await readSequence(root);
  if (!seq?.accounts) return false;
  const rows  = await readUsageRows(root);
  return nudgeCollector(rows, Object.keys(seq.accounts), Date.now(), seq.activeAccountNumber);
}

/**
 * Forget the roster, because something just made it wrong.
 *
 * Called after every `cswap` mutation the deck performs, and by lan-deck.mjs's
 * verdict refresh. The mutations a page can ask for are POSTs that
 * `isTrustedMutation` guards; the rest — the auto-switch tick, the first-run
 * seed, the verdict refresh — run on the deck's own schedule. So nothing a page
 * can send in a loop reaches this.
 *
 * Three things go besides the reading itself:
 *
 *   `_generation`  so a read that STARTED before this call cannot write its
 *                  answer into the cache afterwards. See finish() in readRoster.
 *   `_inflight`    so a caller arriving after the switch is not handed the read
 *                  that began before it — joining a run is only free when the
 *                  run is still about the right thing.
 *   `_lastReadAt`  so the very next read is real work rather than a refusal.
 *                  A mutation the panel asked for is followed by its reloading
 *                  with ?refresh=1, and a floor that answered THAT with the
 *                  pre-switch roster would make the guard the bug.
 */
export function invalidateClaudeAccountsCache() {
  _cache = null;
  _cacheAt = 0;
  _generation++;
  _inflight = null;
  _lastReadAt = 0;
}

/**
 * The slot an account argument names, as a number, or null when it names none.
 *
 * A slot number goes straight into an exec argument as `String(n)`, so the
 * bound is what keeps a value there from being read as anything but a slot:
 * `String(-1)` is "-1", which a child's parser takes for an option, and a
 * fraction or NaN names no slot at all. Whole numbers from 1 to 999 only. The
 * account switch here and the rotation flag in cswap-auto.mjs both ask this
 * rather than restating it. Exported for that caller and for its test.
 */
export function slotNumber(accountNum) {
  const num = Number(accountNum);
  return Number.isInteger(num) && num >= 1 && num <= 999 ? num : null;
}

/**
 * Switch the active Claude account by delegating to `cswap`.
 *
 * Not reimplemented here on purpose. A correct switch has to hold three of
 * Claude Code's own lock files, in its order, with its staleness values, or it
 * can interleave with Claude Code's token refresh and clobber it. cswap does
 * that; a second implementation racing it would be worse than useless.
 *
 * AND IT TAKES THE DECK'S OWN MUTEX (#1039). Holding Claude Code's lock files
 * says nothing about claude-swap's sequence.json, which `cswap switch` reads
 * and writes with no file lock of its own — the same unlocked read-modify-write
 * cswap-admin.mjs's header opens by explaining. `cancelLogin` already queues
 * ITS `cswap switch` behind this lock and spells out why: running one beside an
 * in-flight `cswap add` means whichever write lands second drops the other's
 * record, so the account just signed in is registered and immediately lost, or
 * the rotation is silently undone. This route is the same hazard with a click
 * instead of a cancel, and it ran outside the lock entirely.
 *
 * The validation stays OUTSIDE the lock. A slot number that is not one is not a
 * mutation and must not wait behind somebody else's sixty-second `cswap add`
 * to be told so.
 */
export function switchClaudeAccount(accountNum) {
  // Straight into an exec argument, so nothing but a slot number gets through.
  const num = slotNumber(accountNum);
  if (num == null) {
    return Promise.resolve({ ok: false, reason: "bad_account" });
  }

  // Argument vector, never a shell — and resolved through exec.mjs so the
  // Windows `.exe`/`.cmd` shim is found too.
  return withStoreLock(() => cswapBin()
    .then(bin => run(bin, ["switch", String(num)], { timeout: 30_000 }))
    .then(r => {
      if (r.ok) return { ok: true, output: r.stdout.trim() };
      const reason = r.code === "ENOENT" ? "no_cswap" : r.killed ? "timeout" : "switch_failed";
      return { ok: false, reason, output: failureDetail(r, 500) };
    }));
}

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

const SEED_MARKER = join(homedir(), ".agents-deck", ".cswap-seeded");

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
export async function seedFirstAccount() {
  if (process.env.AGENTS_DECK_NO_INSTALL === "1") return { state: "skipped" };
  if (existsSync(SEED_MARKER)) return { state: "already-tried" };
  // Before the marker, so a refused copy does not also spend the one attempt
  // (#1799). The boot does not seed one either; this is the seed saying so.
  if (await cswapRefusal()) return { state: "refused" };

  // THE TEST AND THE WRITE ARE ONE CRITICAL SECTION (#1039). The whole guard
  // below is a read of sequence.json — "only when the store holds no accounts
  // at all, so nothing can be overwritten or reordered" — followed by a `cswap
  // add` that assigns a slot as max+1 with no file lock of its own. Outside the
  // mutex that pair is exactly the read-modify-write cswap-admin.mjs's header
  // says every mutation must go through, and #796 is what it costs when the
  // read and the write disagree about what is in the store: an add against a
  // populated store, re-pointing activeAccountNumber with nothing here to put
  // it back. This runs unawaited at boot, so there is no user to notice.
  //
  // The two refusals above stay outside: neither touches the store, and a deck
  // that has already seeded must not wait behind a stranger's mutation to say
  // so on every start.
  return withStoreLock(async () => {
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
      return { state: "failed", detail: failureDetail(r, 200) };
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
  });
}
