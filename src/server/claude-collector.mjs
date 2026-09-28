// Keeping claude-swap's store moving while the deck is looking at it.
//
// The accounts panel reads what claude-swap has already collected and fetches
// nothing itself (claude-accounts.mjs). Left at that, the panel is only as live
// as whatever else happens to be running, so each roster read — and the Usage
// panel's refresh button, through requestCollection — asks claude-swap to
// collect when its own plan says something is due, or when the active account's
// numbers have aged past the point where the engine path would refresh them.
// This module decides whether to ask, throttles the asking, and says when each
// account will next be read.
import { cswapBin } from "./cswap-install.mjs";
import { runDetached } from "./exec.mjs";
import { verdictQueue, verdictsNow } from "./claude-verdicts.mjs";

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
 *
 * Answers whether it asked — true from the moment the throttle is spent, even
 * when the ask joins a collection already running — which is what
 * requestCollection reports to the refresh button.
 */
export function nudgeCollector(rows, slots, now, activeNum) {
  // Did the last ask accomplish anything? Cheap proxy: the newest collection
  // timestamp in the store.
  let newest = 0;
  for (const slot of slots) {
    const f = rows[slot]?.fetchedAt;
    if (typeof f === "number" && f > newest) newest = f;
  }
  const moved = newest > _lastSeenFetch;
  _lastSeenFetch = Math.max(_lastSeenFetch, newest);

  if (now - _lastNudge < (moved ? NUDGE_EVERY_MS : NUDGE_QUIET_MS)) return false;

  const due = collectionDue(rows, slots, now);
  const freshen = !due && freshenDue(rows[String(activeNum)], now);
  if (!due && !freshen) return false;

  _lastNudge = now;
  // The due path asks for JSON and KEEPS it — see _verdicts, in
  // claude-verdicts.mjs. The dry-run path stays detached: it is the engine's own
  // collect pass, its JSON is a different shape, and nothing here reads it.
  if (!due) {
    cswapBin().then(bin => runDetached(bin, ["auto", "--once", "--dry-run", "--json"])).catch(() => {});
    return true;
  }
  if (verdictQueue.busy()) return true;
  // Fire-and-forget: this function is deliberately synchronous so callers never
  // wait on it, and resolving the binary is the only async part. `run` rather
  // than `runDetached` only so the output can be read; the caller is no more
  // aware of it than before.
  void verdictsNow();
  return true;
}
