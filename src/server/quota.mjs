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
import { quotaFromStore, WIN_5H_SEC, WIN_7D_SEC } from "./quota-shape.mjs";
import {
  SELF_POLL_MS, clearCooldown, coolingDown, cooldownUntil, fetchOAuthUsage, hasSubscriptionCredential,
} from "./quota-oauth.mjs";
import {
  accountOf, clearResetCreditsFloor, forgetResetCredits, heldResetCredits, refreshStoreResetCredits,
} from "./quota-store-resets.mjs";
import { runUsageOnce, quotaClaudeBin } from "./quota-cli.mjs";

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

// The retry-after clamp moved to quota-oauth.mjs with the requests it bounds;
// codex-quota.mjs imports it from this module, so it is still answered here.
export { cooldownFromHeader } from "./quota-oauth.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// How long an answer with no fresh numbers in it stays cached: the "no reading
// yet" of the poll-floor branch, and both answers _doFetch gives when the CLI
// printed no windows — the last good reading held over, or the zero or failure
// when there never was one. A whole CACHE_MS would keep the panel on one of
// those for a minute when the next attempt may well succeed, so they are
// stamped CACHE_MS - SHORT_CACHE_MS in the past and expire this long after they
// were written.
const SHORT_CACHE_MS = 5_000;

/** The cache stamp that makes an answer published at `now` expire
 *  SHORT_CACHE_MS later. */
const shortLived = (now) => now - (CACHE_MS - SHORT_CACHE_MS);

// The refresh button may beat SELF_POLL_MS — the floor for polls we pay for,
// kept in quota-oauth.mjs beside the cooldown — but not turn into a poll loop
// when held down. It never beats the 429 cooldown.
const FORCE_POLL_MS = 60_000;

// How old a claude-swap row may be before we stop treating it as the answer.
// Its own default poll interval is 1800s, so a row older than this means its
// collector is backing off or not running — the case self-polling exists for.
const STORE_TRUSTED_MS = 45 * 60_000;

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

/** What the deck says when it holds no reading at all: that a 429 is being
 *  waited out, or simply that the first reading has not arrived. */
function noReading(now) {
  return { ok: false, reason: coolingDown(now) ? "rate_limited" : "waiting", fetchedAt: now };
}

/** What the deck can honestly say about a reading it has not finished taking. */
function notYet(now) {
  if (_lastGood) return { ..._lastGood, stale: true };
  return noReading(now);
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
  clearCooldown();
  clearResetCreditsFloor();
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
  if (!maySelfPoll({ now, force, lastSelfPollAt: _lastSelfPollAt, rateLimitedUntil: cooldownUntil() })) {
    // A stale row still beats an empty panel, and says how stale it is — but
    // it must be the freshest thing we hold, not just the store. Preferring
    // the store here threw away readings we had already paid for: after a boot
    // that fell through to the CLI, the panel showed 3% (fetched seconds ago)
    // and then reverted to 23% (from a 48-minute-old store row) on the very
    // next poll, because the store had not moved.
    const held = freshest(store, _lastGood);
    if (held) return publish(gen, { ...held, stale: true }, now);
    const result = noReading(now);
    return publish(gen, result, shortLived(now));
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
    const r = await runUsageOnce(bin);
    cliOk = r.cliOk || cliOk;
    cliRan = r.ran || cliRan;
    if (r.parsed) { parsed = r.parsed; break; }
    // The retry exists for a CLI that RAN and left the quota lines out of a cold
    // invocation. A CLI that is not installed will not be installed 1.2 seconds
    // from now, and asking twice more spends two spawns and 2.4 seconds of the
    // caller's wait to print the same sentence three times. See runUsageOnce.
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
    return publish(gen, { ..._lastGood, stale: true }, shortLived(now));
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
  return publish(gen, result, shortLived(now));
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
  forgetResetCredits();
}
