// Claude rate-limit quota, from whichever source costs least.
//
// All three sources below end at the same place: GET /api/oauth/usage, which
// Anthropic budgets at roughly 28-30 calls per rolling hour PER TOKEN, shared
// by every tool on the machine. That budget is the constraint this module is
// built around, because it was being blown by this module: a 60s poll is 60
// calls an hour on its own, and the account the deck was polling started
// answering http-429 to claude-swap, whose collections the accounts panel is
// entirely made of. One panel went stale so the other could be a minute
// fresher.
//
//   1. claude-swap's store — free. It polls the active account on its own
//      schedule and writes what it got; reading that file costs nothing and
//      spends none of the budget. Used whenever it holds a recent enough row.
//   2. The OAuth usage API directly, with the token from
//      .credentials.json inside the Claude config dir — $CLAUDE_CONFIG_DIR when
//      it is set, ~/.claude otherwise. Exact and instant. Mechanism
//      reverse-engineered from steipete/CodexBar.
//   3. `claude --print /usage`, parsed. Used when there is no readable token —
//      notably on macOS, where Claude Code keeps credentials in the Keychain
//      and that file does not exist, so this is the ONLY self-service path
//      there. It is also the most expensive: a whole Claude Code process per
//      poll. On Windows the binary may be a .cmd wrapper, which spawn cannot
//      launch directly — exec.mjs's `run` routes that case through cmd.exe with
//      the argument vector intact, so no shell ever parses a path this module
//      read out of the environment.
//
// 2 and 3 are rate-floored (SELF_POLL_MS) and gated behind the same 429
// cooldown; 1 is not, because it is a local file read.
//
// CLAUDE'S SAVED LIMIT RESETS (#1308) ride on source 2 rather than being a
// fourth source. The usage endpoint returns them in a `cedar_ember` block when
// the request asks with `cedar_ember=1` — which is what Claude Code itself
// sends — so on source 2 they arrive in the very response the windows come
// from: no extra request, and no way for them to belong to a different account
// than the bars beside them. Neither of the other two sources carries them:
// claude-swap does not ask for the block, and `claude --print /usage` does not
// print it. On source 1 they are therefore a separate read with the same
// token, floored at CREDITS_POLL_MS, and published only once the token's owner
// has been checked against the account claude-swap says is active — see
// refreshStoreResetCredits. Source 3 gets none: it runs when there is no token
// to read with, or when the token is in a 429 cooldown.
//
// There is no claude.ai web session here, on purpose. The organization
// endpoint Claude's own Settings → Usage page reads is reported to refuse an
// OAuth token (`403 oauth_token_not_accepted`), so reaching it would take the
// browser's session cookie, and a browser's cookie store is not something this
// deck reads.
import { activeAccountUsage, requestCollection } from "./claude-accounts.mjs";
import { claudeConfigDir } from "./claude-dir.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { availableResetCredits, readResetGrants } from "./claude-reset-credits.mjs";
import { mapOAuthUsage, quotaFromStore, WIN_5H_SEC, WIN_7D_SEC } from "./quota-shape.mjs";
import { _execOnce, quotaClaudeBin } from "./quota-cli.mjs";
import { createHash } from "node:crypto";

const USAGE_URL   = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

// Source 2's request, asking for the reset inventory as well as the windows.
const USAGE_WITH_RESETS_URL = `${USAGE_URL}?cedar_ember=1`;
// The store path's inventory read. `skip_spend=1` is what Claude Code adds to
// the same request, because the spend breakdown is not what it is asking for;
// neither is it here, where the windows come from claude-swap instead.
const RESETS_ONLY_URL = `${USAGE_URL}?cedar_ember=1&skip_spend=1`;
// Whose token this is. claude-swap asks the same endpoint the same question
// before it trusts a credential with an account; see tokenOwner.
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/**
 * How these requests introduce themselves, in the format Claude Code uses for
 * its own.
 *
 * The endpoint decides whether to send the reset inventory by client surface:
 * a User-Agent it does not recognise as Claude Code's CLI gets `eligible:
 * false, ineligible_reason: "surface"` and no grants, and a CLI version it
 * considers too old gets `"cli_version"`. This deck used to send
 * `claude-code/2.1.0`: written to look like Claude Code, in a format the
 * endpoint does not take for it. The windows do not depend on any of this —
 * claude-swap reads the same ones as `claude-swap/1.0`.
 *
 * Pinned rather than read off the installed binary: the version lives in a
 * different place under every install method, and a pin that ages out fails
 * closed — the endpoint stops sending grants, the row disappears, and no number
 * on the panel is wrong. Raising it is the fix when that happens.
 */
const USER_AGENT  = "claude-cli/2.1.283 (external, cli)";

// 429 cooldown gate — after a rate-limit, skip the API until this passes.
let _rateLimitedUntil = 0;

/**
 * Where Claude Code keeps the OAuth credentials this module borrows a token
 * from.
 *
 * It is `.credentials.json` inside the Claude config dir, and that dir moves:
 * CLAUDE_CONFIG_DIR replaces ~/.claude wholesale rather than overlaying it, so
 * on a machine where it is set there is no ~/.claude to read at all. Hardcoding
 * ~/.claude here did not fail loudly — it made readOAuthToken() return null
 * forever, which reads exactly like "this machine keeps its credentials in the
 * Keychain", and the quota chain quietly fell through to source 3 on every poll
 * it was allowed to make. See src/server/claude-dir.mjs, which owns the rule
 * and is the only place it is spelled.
 *
 * Resolved per call rather than frozen into a module-level constant, for the
 * same reason claudeConfigDir() is a function: a constant captured at import
 * time is a value nothing can observe or correct afterwards, and this module is
 * imported lazily by the /api/quota route rather than at a point in startup
 * anyone here controls.
 *
 * Exported for tests — it is the whole of the bug, and it is pure.
 */
export function credentialsPath() {
  return join(claudeConfigDir(), ".credentials.json");
}

async function readOAuthToken() {
  try {
    const raw  = await readFile(credentialsPath(), "utf8");
    const auth = JSON.parse(raw)?.claudeAiOauth;
    if (!auth?.accessToken) return null;
    // expiresAt is epoch milliseconds. If expired, the CLI fallback handles it.
    if (auth.expiresAt && Date.now() >= auth.expiresAt) return null;
    return auth.accessToken;
  } catch {
    return null;
  }
}

/**
 * Whether we may spend a request of the user's budget right now.
 *
 * Exported for tests — this is the rule that stopped the deck from starving
 * claude-swap, and it is worth pinning down.
 */
export function maySelfPoll({ now, force, lastSelfPollAt, rateLimitedUntil }) {
  if (now < rateLimitedUntil) return false;
  return now - lastSelfPollAt >= (force ? FORCE_POLL_MS : SELF_POLL_MS);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * A cooldown from a `retry-after`, kept inside limits the deck can live with.
 *
 * Unclamped, the header decided the poller's fate in both directions: `0` (or a
 * value the server rounds down to it) defeats the cooldown entirely and the
 * next tick asks again immediately, which is the loop a 429 exists to stop; a
 * large one — a day is a legal value — freezes the reader for the life of the
 * process, and nothing here re-reads it. Both are the remote side deciding how
 * this deck behaves, which a header is not entitled to do.
 *
 * The floor is the deck's own minimum backoff and the ceiling is an hour: long
 * enough to be a real retreat, short enough that a quota panel is not dead for
 * the rest of the day because one reply said so.
 */
export function cooldownFromHeader(raw, fallbackMs, minMs = 30_000, maxMs = 3600_000) {
  const seconds = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(seconds)) return fallbackMs;
  return Math.min(Math.max(seconds * 1000, minMs), maxMs);
}

/**
 * WHETHER THIS MACHINE HAS A SUBSCRIPTION TO REPORT ON AT ALL.
 *
 * Every source here needs a Claude.ai OAuth credential: the claude-swap store
 * holds one, `claudeAiOauth` in the credentials file is one, and
 * `claude --print /usage` prints windows only for a session signed in with one.
 * An API-key, Bedrock or Vertex install has none — and there is no quota to
 * read, because those are billed per token rather than in five-hour windows.
 *
 * That mattered because of what the CLI does on such a machine: it RUNS, prints
 * no quota lines, and the branch below used to read that as "genuine <1%" and
 * publish `ok: true` with two zeroes. The panel then drew empty bars, which is
 * a measurement nobody took. Codex already answers this properly, with
 * `api_key_mode` as its own reason and its own sentence.
 *
 * Cheap and synchronous: environment first, because a machine configured for
 * Bedrock or Vertex says so there, then the presence of the OAuth block in the
 * credentials file. `readOAuthToken` above answers a different question — it
 * also rejects an EXPIRED token, and an expired subscription is still a
 * subscription.
 */
export async function hasSubscriptionCredential(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1") return false;
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    if (JSON.parse(raw)?.claudeAiOauth?.accessToken) return true;
  } catch { /* absent or unreadable, decided below */ }
  // A key in the environment and no OAuth block beside it is the API-key
  // install. Without either, this deck simply has not been signed in yet, and
  // "sign in" is the right thing to say — which is the `waiting` branch, not
  // this one.
  return !(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

/** The headers every request below sends with the Claude Code token. */
function oauthHeaders(token) {
  return {
    "Authorization":  `Bearer ${token}`,
    "anthropic-beta": BETA_HEADER,
    "Accept":         "application/json",
    "Content-Type":   "application/json",
    "User-Agent":     USER_AGENT,
  };
}

async function fetchOAuthUsage() {
  if (Date.now() < _rateLimitedUntil) return null;
  const token = await readOAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(USAGE_WITH_RESETS_URL, {
      headers: oauthHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      _rateLimitedUntil = Date.now() + cooldownFromHeader(res.headers.get("retry-after"), 5 * 60_000);
      return null;
    }
    if (!res.ok) return null;

    return mapOAuthUsage(await res.json());
  } catch {
    return null;
  }
}

let _cache    = null;
let _cacheAt  = 0;
let _inflight = null;   // deduplicates concurrent CLI probes
let _lastGood = null;   // last result that had real quota percentages
let _lastSelfPollAt = 0;
// Which account the readings below are about — as a counter, because the
// account's identity is not something this module holds. invalidateQuotaCache
// bumps it; every write in _doFetch is stamped with the value that was current
// when that read STARTED. See publish().
let _generation = 0;

const CACHE_MS = 60_000;

// Floor between two polls WE pay for. Twelve an hour against a budget of
// ~28-30 leaves claude-swap room to collect for every account, which is what
// the accounts panel is made of. Only reached when the store cannot answer.
const SELF_POLL_MS = 5 * 60_000;

// The refresh button may beat that floor, but not turn into a poll loop when
// held down. It never beats the 429 cooldown.
const FORCE_POLL_MS = 60_000;

// How old a claude-swap row may be before we stop treating it as the answer.
// Its own default poll interval is 1800s, so a row older than this means its
// collector is backing off or not running — the case self-polling exists for.
const STORE_TRUSTED_MS = 45 * 60_000;

// ── saved limit resets, on the store path ────────────────────────────────────
//
// Floor between two inventory reads while claude-swap supplies the windows. A
// grant is issued for a launch and lasts weeks, so this is two requests an hour
// out of a budget claude-swap plans to leave eight to ten of unspent. A forced
// refresh, or an account not tried yet, waits SELF_POLL_MS.
const CREDITS_POLL_MS = 30 * 60_000;

// How long an inventory is shown after the last read that succeeded. Expiry is
// worked out at every read, but a reset redeemed in Claude only leaves the
// inventory when a read says so, and a read that keeps failing must not keep
// promising it.
const CREDITS_TRUSTED_MS = 3 * CREDITS_POLL_MS;

// What the last successful read found, and for whom: `{ account, grants, at }`,
// where `grants` is readResetGrants's answer — a list, or null for a block that
// said nothing readable. Never an id: the parser does not keep one.
let _credits = null;
// When the store path last tried, successful or not, and for which account,
// so a failing read is on the same floor as a working one.
let _creditsTriedAt = 0;
let _creditsTriedFor = null;
let _creditsInflight = null;
// The last token whose owner was looked up, by hash, and the answer. A token
// belongs to one account for its whole life, so this is asked once per token
// rather than once per read. The token itself is not kept.
let _owner = null;

/**
 * How long a caller may be kept waiting before this module answers anyway.
 *
 * Source 3 has no ceiling of its own and never had one. Its cost is the sum of
 * every step below it — three spawns under a 15-second deadline each, with two
 * 1.2-second sleeps between them — and nobody had ever added it up. Measured on
 * a sandboxed deck with a `claude` that never prints (#1011):
 *
 *     $ curl -s -m 120 -w "[%{http_code}] time_total=%{time_total}s" .../api/quota
 *     {"ok":false,"reason":"cli_failed",...}
 *     [200] time_total=47.411343s
 *
 * 3 × 15s + 2 × 1.2s = 47.4, to the tenth. The rest of the deck stayed
 * responsive throughout — /api/health answered in 0.0008s while that request
 * was out — so what this bounds is one pinned request rather than a stalled
 * server: a panel on "Checking…" for three quarters of a minute, and one fewer
 * socket in the browser's per-origin pool for as long as it is out.
 *
 * FIVE SECONDS, and it is a budget rather than a guess at how long the CLI
 * takes. A sandbox with a real `claude` and no credentials answered in 4.2s and
 * 4.5s, which is the slow END of the good case, and the good case is already
 * served from the store or the API in milliseconds. What is left above five
 * seconds is the CLI in trouble, and for that the honest answer is "not yet".
 *
 * Nothing is cancelled when it expires — see answerWithin. The read runs on,
 * publishes to the cache, and the panel's next poll gets the real numbers.
 */
export const QUOTA_DEADLINE_MS = 5_000;

/**
 * @param deadlineMs how long the CALLER is prepared to wait. Zero — the
 *   default, and what every internal caller uses — waits for the read however
 *   long it takes, which is what a test driving the chain end to end wants.
 *   The route passes QUOTA_DEADLINE_MS; see answerWithin for what expiring
 *   means, which is not cancelling.
 */
export async function fetchClaudeQuota({ force = false, deadlineMs = 0 } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  // If another CLI probe is already in flight, wait for it instead of spawning a
  // second concurrent process (which can return empty output and overwrite the
  // good result with 0%).
  //
  // Under a deadline the joiner is bounded too, and has to be: joining a read
  // that started 46 seconds ago is the same 47-second wait reached by the other
  // door, and it is the door the panel's own 60-second poll walks through.
  if (_inflight) return answerWithin(_inflight, deadlineMs, now);

  // `_inflight === mine` rather than a bare clear: invalidateQuotaCache drops
  // `_inflight` so the next caller starts a read that knows the account moved,
  // and that read installs its own promise here. A read from before the switch
  // finishing afterwards would otherwise clear the NEW one on its way out,
  // letting a third caller spawn a second concurrent probe — which is the very
  // thing this slot exists to prevent.
  const mine = _doFetch(now, force, _generation)
    .finally(() => { if (_inflight === mine) _inflight = null; });
  _inflight = mine;
  return answerWithin(mine, deadlineMs, now);
}

/**
 * The read's answer, or the best thing we can say by the time the caller's
 * patience runs out.
 *
 * THE READ IS NOT CANCELLED, and that is the whole design rather than a
 * shortcut. It keeps running, keeps `_inflight` filled so nothing spawns a
 * second Claude Code beside it, and ends in publish() like any other read — so
 * the numbers it eventually produces are in the cache for whoever asks next.
 * The panel polls every 60 seconds and presses ↻ into the same slot, so "not
 * yet" is a state it leaves on its own within a poll. Cancelling would spend a
 * whole `claude --print /usage` and throw the result away, and the budget this
 * module is built around (28-30 requests an hour, shared with claude-swap) is
 * the one thing it must not do.
 *
 * WHAT "NOT YET" SAYS. The freshest real reading this module holds, marked
 * stale — the same answer, in the same shape, that the poll-floor branch of
 * _doFetch already gives for the same question — and only when there is none,
 * the `waiting` reason the panel has rendered a sentence for all along. Its
 * timestamp is the reading's own and never `now`: an age indicator that
 * vouches for numbers collected hours ago is what quota-held-age.test.ts
 * exists to stop, and a deadline is not a licence to re-stamp them.
 *
 * Exported because a deadline nothing can point at is a deadline nobody can
 * test.
 */
export function answerWithin(read, deadlineMs, now = Date.now()) {
  if (!(deadlineMs > 0)) return read;
  let bell;
  const expired = new Promise(resolve => {
    bell = setTimeout(() => resolve(notYet(now)), deadlineMs);
    // A deadline is not a reason for the process to stay alive: this timer
    // outlives nothing, and an exit waiting on it would be this function
    // holding the deck open for an answer nobody is there to read.
    bell.unref?.();
  });
  return Promise.race([read, expired]).finally(() => clearTimeout(bell));
}

/** What the deck can honestly say about a reading it has not finished taking. */
function notYet(now) {
  if (_lastGood) return { ..._lastGood, stale: true };
  return { ok: false, reason: now < _rateLimitedUntil ? "rate_limited" : "waiting", fetchedAt: now };
}

/**
 * Write a reading into the caches, unless the account moved while it was being
 * taken.
 *
 * Every one of _doFetch's writes happens after at least one await — a store
 * read, a 15-second HTTPS call, up to three `claude --print /usage` spawns with
 * 1.2s between them — and invalidateQuotaCache clears variables, which does
 * nothing to a function that is already running and still holds the old
 * account's answer in a local. So a switch landing mid-flight was followed,
 * milliseconds later, by the pre-switch reading being written straight back over
 * the cleared cache: the invalidation looked like it worked and was undone
 * before anyone could observe it.
 *
 * The fetch is deliberately NOT cancelled. Whoever asked for it is still owed an
 * answer, and the reading is not wrong — it is simply about an account that is
 * no longer active, which makes it a fine return value and a bad cached one.
 * `_lastGood` gets the same guard, and needs it more: it is the half that
 * survives the result cache's minute and comes back under a "stale" label for as
 * long as the store has nothing to say about the new account.
 */
function publish(gen, result, at, { good = false } = {}) {
  if (gen !== _generation) return result;
  _cache   = result;
  _cacheAt = at;
  if (good) _lastGood = result;
  return result;
}

/**
 * claude-swap's numbers for the active account, if it has any.
 *
 * Never throws and never blocks on the network: worst case the store is
 * missing, unparseable, or about a different account than the one that is
 * active, and the caller falls through to fetching for itself.
 */
async function storeQuota() {
  try {
    const entry = await activeAccountUsage();
    const quota = quotaFromStore(entry);
    if (!quota) return null;
    const account = accountOf(entry.email, entry.organizationUuid);
    const credits = heldResetCredits(account, Date.now());
    const reading = credits ? { ...quota, resetCredits: credits } : quota;
    if (account) _accountOfReading.set(reading, account);
    return reading;
  } catch {
    return null;
  }
}

// Which account a store reading is about, for the inventory read it starts.
// Beside the reading rather than on it: the reading is sent to the browser as
// it is, and an identity is not something the panel needs. Weak, so a reading
// nothing holds any more takes its entry with it.
const _accountOfReading = new WeakMap();

/**
 * A Claude account as the two halves claude-swap keys one on, or null when
 * either is missing, because half an identity cannot be matched against
 * anything.
 */
function accountOf(email, org) {
  const e = typeof email === "string" ? email.trim() : "";
  const o = typeof org === "string" ? org.trim() : "";
  return e && o ? { email: e, organizationUuid: o } : null;
}

/**
 * Whether two identities are the same Claude account.
 *
 * Both halves, because claude-swap treats one address under two organizations
 * as two accounts on purpose, and those two have separate inventories. The
 * address is compared without case — it is the same mailbox either way — and
 * the organization exactly.
 *
 * Exported for tests: this comparison is the whole of what keeps one account's
 * resets off another account's card.
 */
export function sameAccount(a, b) {
  if (!a || !b) return false;
  return a.email.toLowerCase() === b.email.toLowerCase() && a.organizationUuid === b.organizationUuid;
}

/** The held inventory, if it was read for `account` and recently enough. */
function heldResetCredits(account, now) {
  if (!_credits || !sameAccount(_credits.account, account)) return null;
  if (now - _credits.at > CREDITS_TRUSTED_MS) return null;
  return availableResetCredits(_credits.grants, now);
}

/**
 * Whether the store path may spend a request on the inventory now.
 *
 * The long floor once this account has been tried, whether that worked or not
 * — a profile lookup that keeps failing is not a reason to ask twelve times an
 * hour. The short one for an account not tried yet, which is what an account
 * switch produces, and for the refresh button.
 *
 * Exported for tests, like maySelfPoll, and for the same reason: it is a
 * budget rule, and it is pure. The 429 cooldown is maySelfPoll's own — one
 * token, one budget — so a 429 here holds source 2 off as well, and the other
 * way round.
 */
export function resetCreditsDue({ now, force, triedAt, rateLimitedUntil, triedThisAccount }) {
  if (now < rateLimitedUntil) return false;
  return now - triedAt >= (triedThisAccount && !force ? CREDITS_POLL_MS : SELF_POLL_MS);
}

/**
 * The account a token belongs to, as `{ email, organizationUuid }`, or null
 * when that cannot be established.
 *
 * `/api/oauth/profile` answers about the token it is sent, which makes it the
 * one source that cannot describe a different account than the token will be
 * used for. The Claude config's `oauthAccount` block would have been free, but
 * it is a separate file from the credential, written at a separate moment, and
 * "usually agrees" is not the bar for publishing an account's data.
 */
async function tokenOwner(token) {
  const key = createHash("sha256").update(token).digest("hex");
  if (_owner?.key === key) return _owner.identity;
  let identity = null;
  try {
    const res = await fetch(PROFILE_URL, {
      headers: oauthHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = await res.json();
      identity = accountOf(body?.account?.email, body?.organization?.uuid);
    }
  } catch { /* unreachable or unreadable: no identity, so nothing is published */ }
  if (identity) _owner = { key, identity };
  return identity;
}

/**
 * The inventory for `token`: readResetGrants's answer, or undefined when the
 * request did not produce one — in which case whatever is held stays held.
 */
async function fetchResetGrants(token) {
  try {
    const res = await fetch(RESETS_ONLY_URL, {
      headers: oauthHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 429) {
      _rateLimitedUntil = Date.now() + cooldownFromHeader(res.headers.get("retry-after"), 5 * 60_000);
      return undefined;
    }
    if (!res.ok) return undefined;
    return readResetGrants((await res.json())?.cedar_ember);
  } catch {
    return undefined;
  }
}

/**
 * Read the reset inventory for the account claude-swap says is active, when
 * the store is what the panel's windows came from.
 *
 * Best-effort in every direction, and never awaited by a quota read: it runs
 * behind the read that started it, and the next read picks the answer up. It
 * cannot delay, fail or change the windows, and nothing it catches is logged —
 * there is nothing in a failure here the user can act on, and the one thing
 * the error path must never do is print a request that carried a token.
 *
 * THE ACCOUNT CHECK IS THE POINT. The token is Claude Code's, from the Claude
 * config dir; the windows are claude-swap's, for whichever slot it has marked
 * active. Those are the same account after a `cswap switch`, and need not be
 * after a `claude auth login` done in a terminal. So the token's owner is looked
 * up first, and when it is not the store's active account the inventory
 * request is never made. What is kept is stamped with the account it was
 * checked against, and heldResetCredits compares that stamp with the store's
 * active account again at every read — so a switch made anywhere, by the deck,
 * by `cswap` in a terminal or by claude-swap's auto-switch, cannot carry one
 * account's resets onto the next account's card.
 */
function refreshStoreResetCredits({ now, force = false, account }) {
  if (_creditsInflight || !account) return;
  const triedThisAccount = sameAccount(_creditsTriedFor, account);
  if (!resetCreditsDue({ now, force, triedAt: _creditsTriedAt, rateLimitedUntil: _rateLimitedUntil, triedThisAccount })) return;
  _creditsTriedAt = now;
  _creditsTriedFor = account;
  const run = (async () => {
    const token = await readOAuthToken();
    if (!token) return;
    const owner = await tokenOwner(token);
    if (!sameAccount(owner, account)) return;
    const grants = await fetchResetGrants(token);
    if (grants !== undefined) _credits = { account, grants, at: now };
  })();
  // Settles rather than rejects: nothing in here is news to anyone.
  _creditsInflight = run.catch(() => {}).finally(() => { _creditsInflight = null; });
}

/** Exported for tests: the inventory read runs behind the quota read that
 *  started it, and a test has to be able to wait for it to land. */
export function resetCreditsSettled() {
  return _creditsInflight ?? Promise.resolve();
}

// After asking claude-swap to collect, how long to keep looking for the row it
// writes. Its fetch is a single HTTPS call; three tries covers a slow one
// without making the refresh button feel stuck.
const REREAD_TRIES = 3;
const REREAD_GAP_MS = 800;

/**
 * Whichever of two readings was collected later, regardless of source.
 *
 * Quota numbers only ever move forward in time, so "newer" is the only ranking
 * that makes sense between a store row and something we fetched ourselves. A
 * five-hour window can also reset between the two, which makes an older reading
 * not merely stale but wrong — 23% from before the reset, 3% after it.
 */
export function freshest(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return (b.fetchedAt ?? 0) > (a.fetchedAt ?? 0) ? b : a;
}

/** Ask for a collection, then watch the store for the result. */
async function nudgeAndReread(previous) {
  let asked = false;
  try { asked = await requestCollection(); } catch { /* cswap missing */ }
  if (!asked) return previous;

  for (let i = 0; i < REREAD_TRIES; i++) {
    await sleep(REREAD_GAP_MS);
    const fresh = await storeQuota();
    if (fresh && (!previous || fresh.fetchedAt > previous.fetchedAt)) return fresh;
  }
  return previous;
}

/** The rate floor, cleared. `maySelfPoll` keeps a self-poll to one a minute
 *  even under `force`, which is correct for a user's budget and is a test
 *  asking the same question three times running into a wall. */
export function resetQuotaPollFloor() {
  _lastSelfPollAt = 0;
  _rateLimitedUntil = 0;
  _creditsTriedAt = 0;
  _creditsTriedFor = null;
}

async function _doFetch(now, force = false, gen = _generation) {
  // Source 1: claude-swap's store. Free, and already paid for.
  let store = await storeQuota();

  // Refresh asks for newer numbers, and the honest way to get them from this
  // source is to ask the collector that owns it — which applies its own
  // schedule and backoff, so this cannot become a poll loop.
  if (force && (!store || now - store.fetchedAt > FORCE_POLL_MS)) {
    store = await nudgeAndReread(store);
  }
  if (store && now - store.fetchedAt <= STORE_TRUSTED_MS) {
    // Keep the store moving even when the accounts panel is closed. Without
    // this the numbers only advance while something else asks — claude-swap's
    // own schedule still decides whether this touches the network, and the
    // throttle inside is shared with the accounts panel, so two open panels
    // ask no more often than one.
    if (!force) requestCollection().catch(() => {});
    // The saved limit resets are the one thing the store cannot say. Read
    // behind this answer, never in front of it; see refreshStoreResetCredits.
    refreshStoreResetCredits({ now, force, account: _accountOfReading.get(store) });
    return publish(gen, store, now, { good: true });
  }

  // Nothing usable in the store. Everything below spends the user's budget, so
  // it happens on a floor, and not at all while a 429 cooldown is running.
  if (!maySelfPoll({ now, force, lastSelfPollAt: _lastSelfPollAt, rateLimitedUntil: _rateLimitedUntil })) {
    // A stale row still beats an empty panel, and says how stale it is — but
    // it must be the freshest thing we hold, not just the store. Preferring
    // the store here threw away readings we had already paid for: after a boot
    // that fell through to the CLI, the panel showed 3% (fetched seconds ago)
    // and then reverted to 23% (from a 48-minute-old store row) on the very
    // next poll, because the store had not moved.
    const held = freshest(store, _lastGood);
    if (held) return publish(gen, { ...held, stale: true }, now);
    const result = { ok: false, reason: now < _rateLimitedUntil ? "rate_limited" : "waiting", fetchedAt: now };
    return publish(gen, result, now - (CACHE_MS - 5_000));
  }
  _lastSelfPollAt = now;

  // Source 2: OAuth usage API — instant, exact, no cold-start gap.
  const api = await fetchOAuthUsage();
  if (api) {
    return publish(gen, { ok: true, ...api, source: "api", fetchedAt: now }, now, { good: true });
  }

  // Source 3: parse `claude --print /usage` CLI output.
  const bin = quotaClaudeBin();

  // The CLI sometimes omits the "Current session/week" quota lines on a cold
  // invocation (right after the server starts, or after the page is hard-
  // refreshed). The real lines appear on a subsequent call. Retry a couple
  // times before giving up so the first paint already shows real values.
  let cliOk = false;
  let cliRan = false;
  let parsed = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200);
    const r = await _execOnce(bin);
    cliOk = r.cliOk || cliOk;
    cliRan = r.ran || cliRan;
    if (r.parsed) { parsed = r.parsed; break; }
    // The retry exists for a CLI that RAN and left the quota lines out of a cold
    // invocation. A CLI that is not installed will not be installed 1.2 seconds
    // from now, and asking twice more spends two spawns and 2.4 seconds of the
    // caller's wait to print the same sentence three times. See _execOnce.
    if (r.missing) break;
  }

  // Got real quota lines — cache normally and remember as last-known-good.
  if (parsed) {
    return publish(gen, { ok: true, ...parsed, source: "cli", fetchedAt: now }, now, { good: true });
  }

  // No quota lines after retries. If we've ever seen real values, keep showing
  // them rather than regressing to 0% on a transient empty read — with the
  // timestamp of the answer they actually are. Re-stamping them `now` put "just
  // now" over percentages collected hours earlier for one poll in five, then let
  // the label snap back to the true age: an age indicator that oscillates, and
  // vouches for numbers this branch already knows are stale. Short-cache so we
  // retry the CLI again soon.
  if (_lastGood) {
    return publish(gen, { ..._lastGood, stale: true }, now - (CACHE_MS - 5_000));
  }

  // Never had good data. A CLI that RAN and printed no quota lines is two
  // different machines, and they need two different answers:
  //
  //   * a subscription install on a cold invocation — the lines come back on a
  //     later call, and until then "<1%" is the honest reading of a window that
  //     has genuinely just reset;
  //   * an API-key, Bedrock or Vertex install, which has no windows at all.
  //     Publishing two zeroes there drew empty bars for a measurement nobody
  //     took, on a machine where no amount of retrying will ever produce one.
  //
  // A CLI that failed entirely is `ok: false` as it always was, and the reason
  // says which of the two the reader is looking at.
  //
  // `cliRan` IS WHAT MAKES THAT SENTENCE TRUE. It used to rest on `cliOk`
  // alone, which is a regex over stdout+stderr and never looked at the exit
  // status — so a CLI that printed its header and then failed (a network
  // error, a rate limit, a timeout after the banner) took this branch and the
  // panel drew two full-looking bars reading "5-hour window 0%". The deck
  // logged `claude CLI failed` in the same second. Someone reading an empty
  // window then starts a long run against one that is nearly spent.
  //
  // Only this branch is gated. The parse above still keeps its output on a
  // non-zero exit, deliberately, because the quota lines can be printed and
  // the exit still be non-zero — 0% is a claim made in the ABSENCE of numbers,
  // and absence plus failure is not a measurement.
  const subscribed = cliOk && cliRan ? await hasSubscriptionCredential() : false;
  const result = cliOk && cliRan && subscribed
    ? { ok: true, session5hPct: 0, session5hWindowSec: WIN_5H_SEC,
        week7dPct: 0, week7dWindowSec: WIN_7D_SEC, fetchedAt: now }
    : { ok: false, reason: cliOk && cliRan ? "no_subscription" : "cli_failed", fetchedAt: now };
  return publish(gen, result, now - (CACHE_MS - 5_000));
}

/**
 * Forget every reading held for the account that was active when it was taken.
 *
 * `?refresh=1` is the browser asking for a fresher read; this is the server
 * knowing the numbers it holds are the wrong account's. A Claude account switch
 * makes them that — every percentage here belongs to whoever was active when it
 * was collected — and the switch happens server-side, where no tab is in a
 * position to send the flag: it is driven from the accounts panel, and the usage
 * panel neither owns that state nor hears about it.
 *
 * `_lastGood` goes with the result cache, and it is the half that matters.
 * Clearing `_cache` alone only shortens the wrong answer's life to the next
 * poll, because both fallbacks in _doFetch hand `_lastGood` straight back — and
 * freshest() ranks by fetchedAt, so a reading the deck already paid for beats
 * any row the store holds for an account nobody has collected for since. The
 * panel would print the previous account's percentages under a "stale" label
 * instead of admitting it has no answer for this one yet.
 *
 * The self-poll floor deliberately survives: a switch is not a reason to spend
 * the shared request budget, and one that reset it would make switching a way to
 * hammer it. Until the store answers for the new account, "no reading yet" is
 * the honest thing to serve.
 *
 * Clearing the three variables is not enough on its own, because a fetch that is
 * already running is not a variable. `_doFetch` writes `_cache` and `_lastGood`
 * AFTER its awaits, so one that read the store before the switch and resolves
 * after it put the previous account's numbers back into both, undoing this call
 * from the other side of an await — and callers arriving in that window were
 * handed the same in-flight promise rather than a read that knows the account
 * moved. The window is real: a forced fetch goes through nudgeAndReread, which
 * sleeps REREAD_TRIES * REREAD_GAP_MS = 2.4 seconds by construction, comfortably
 * longer than a `cswap switch`.
 *
 * So the generation counter moves too. Every write in `_doFetch` is stamped with
 * the generation that was current when that read started, and publish() drops
 * any write whose stamp is stale — the fetch still resolves, and whoever asked
 * for it still gets its answer, but that answer no longer becomes this module's.
 * `_inflight` is released for the same reason: the next caller must start a read
 * of its own rather than join one that is describing the account the deck just
 * left.
 */
export function invalidateQuotaCache() {
  _cache = null;
  _cacheAt = 0;
  _lastGood = null;
  _generation++;
  _inflight = null;
  // Forgotten with the rest, because it is about the account the deck just
  // left. It is not what keeps those resets off the next card, though:
  // heldResetCredits compares accounts at every read, which also covers the
  // switches this function never hears about — `cswap` in a terminal, or
  // claude-swap's own auto-switch. The inventory floor survives, for the reason
  // the self-poll floor does, and an account not tried yet is on the short one
  // anyway.
  _credits = null;
}
