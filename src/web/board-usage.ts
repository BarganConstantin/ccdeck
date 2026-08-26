// What the deck's aggregate money and token figures are summed over, and what
// they are allowed to be called. One module, because those two things must
// never be changed apart.
//
// #687. The usage panel's headline said "total spend" and the topbar's chip
// beside it said "cost", and neither was a total of anything anyone had spent.
// Both walked `state.agents` — the agents on the canvas right now — and the
// canvas evicts finished sessions on a two-minute timer with a cap of six
// (`DONE_SESSION_CAP` / `DONE_SESSION_GRACE_MS` in App.tsx, driving
// `pruneDoneSessions`). So the figure goes DOWN. Measured on the shipped
// constants: ten finished sessions on `claude-opus-5` at 1M in / 100K out each
// read $75.00 and 11.00M tokens; one 250ms tick later, with nothing having
// changed and nothing refunded, they read $45.00 and 6.60M. One level further
// down, `pruneOldAgents` (cap 200, five-minute grace) evicts finished subagents
// out of sessions that are STILL LIVE — a live root with 261 agents under it
// went from 286.00M tokens to 218.90M in one sweep — so a per-session roll-up
// carries the same defect as the board-wide one.
//
// Every number in all of that was correct. What was wrong was the word over it:
// "total" is a claim about a whole, and this number's whole is "however much of
// the recent past has not been evicted yet".
//
// WHY THE LABEL MOVED AND NOT THE NUMBER. The other repair — accumulate the
// evicted sessions' cost into the state so the headline survives the prune —
// was considered and rejected on three counts, and the first is fatal on its
// own:
//
//   * It would over-report. `pruneDoneSessions` evicts on `endedAt`, which is
//     written by `Stop`, and `Stop` is a TURN boundary on both providers — its
//     own doc comment records that a replay of two real event logs evicted 20
//     sessions and 7 of them went on to produce more events, coming back with
//     the same session id. An accumulator would bank such a session's dollars
//     at eviction and then count them again as the reborn session re-reports
//     its cumulative usage. A total that double-counts is worse than one that
//     under-counts, because nothing on screen can contradict it.
//   * It would still not be a total. The accumulator resets when the tab
//     reloads, and what replays into it is whatever the server's event ring
//     still holds — so the honest label would become "since this tab connected,
//     less whatever the ring dropped", which is another unqualified claim the
//     deck cannot keep.
//   * It would re-open #575. That issue made the "By session" table track the
//     pruner so the tables and the headline agree. A headline of $75 over six
//     rows summing $45 is that disagreement again, with the missing $30
//     accounted for nowhere on a 280px panel.
//
// And the deck already answers "what has today cost me" properly: the usage
// history modal (H) is backed by `/api/ccusage`, which reads the logs on disk,
// covers sessions this deck never watched, and does not forget. A canvas-scoped
// number beside an authoritative one is useful; two competing totals are not.
// So the board figure says it is the board's, and points at the durable one.
import { costForUsage, type CostBreakdown } from "./pricing";
import type { TokenUsage } from "./types";

/** Anything the deck can price: an agent, or a test's stand-in for one. */
export interface Billable {
  usage: TokenUsage;
  model?: string;
}

/** Every token and every dollar on the board right now, in one pass. */
export interface BoardTotals {
  cost: CostBreakdown;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** input + output — the one figure the topbar prints, and the gate the usage
   *  panel opens its money block on. Cache traffic is deliberately outside it:
   *  it is reported beside these two and is an order of magnitude larger, so
   *  folding it in would make the headline unreadable as "how much work". */
  sum: number;
}

/**
 * The board-wide roll-up, over exactly the agents it is handed.
 *
 * Handed an iterable rather than reaching for the graph itself, which is what
 * makes it callable from a suite with no DOM and no React: the defect this file
 * is named for is a claim about WHICH agents are summed, and a function that
 * fetched its own input could not be shown summing a different set before and
 * after a prune.
 *
 * It used to be two copies — one accumulator in App.tsx's topbar memo and a
 * second inside UsagePanel's, spelled with different variable names and summing
 * the same map. They never disagreed, and they were never checked against each
 * other either; `duplicated-helpers.test.ts` is this repo's record of what that
 * costs. Now the two surfaces that print a board figure print the same
 * arithmetic, under labels declared in the same file as the arithmetic.
 */
export function boardTotals(agents: Iterable<Billable>): BoardTotals {
  const cost: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0;
  for (const a of agents) {
    const c = costForUsage(a.usage, a.model);
    cost.input += c.input;
    cost.output += c.output;
    cost.cacheRead += c.cacheRead;
    cost.cacheWrite += c.cacheWrite;
    cost.total += c.total;
    inputTokens += a.usage.inputTokens;
    outputTokens += a.usage.outputTokens;
    cacheReadTokens += a.usage.cacheReadTokens;
    cacheCreateTokens += a.usage.cacheCreateTokens;
  }
  return {
    cost,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    sum: inputTokens + outputTokens,
  };
}

/** The usage panel's headline, under the dollar figure. "board" is this repo's
 *  own word for the canvas — `pruneDoneSessions` has said "on the board" since
 *  it was written — and it is the word the reporter of #687 reached for too. */
export const BOARD_SPEND_LABEL = "spend on this board";

/** The same scope, as a bare qualifier. The panel prints this beside the token
 *  strip on a deck where every model is unpriced: there is no headline on that
 *  deck — the money block is gated on cost — so the strip is the only aggregate
 *  on screen and would otherwise stand with no scope stated anywhere. */
export const BOARD_SCOPE_LABEL = "on this board";

/** The topbar chips. Terse because the strip is a fixed-width row that four
 *  readouts already share, and one word is enough to stop the figure reading as
 *  a claim about the day. */
export const BOARD_TOKENS_LABEL = "board tokens";
export const BOARD_COST_LABEL = "board cost";

/**
 * The tooltip every board-wide figure carries, on both surfaces.
 *
 * Three sentences, in the order a reader needs them: what is counted, why it
 * can fall, and where the durable answer lives. The last one is the reason this
 * is a scope statement rather than an apology — the deck does know the real
 * total, it is one keystroke away, and it is not this number.
 *
 * No CLI is named in it. The board sums Claude and Codex agents alike, and
 * `codex-copy.test.ts` holds the topbar to that: a provider-blind figure must
 * not carry one product's name.
 */
export const BOARD_SCOPE_TITLE =
  "Everything on the board right now, and only that.\n"
  + "Finished sessions are evicted from the canvas a couple of minutes after they end, "
  + "and their tokens and dollars leave with them — so this figure falls on its own.\n"
  + "Press H for the totals ccusage reads off the logs on disk, which do not forget.";

/**
 * What one session's roll-up is called, on the sidebar row and on the end-of-
 * session recap.
 *
 * Both of those said "total spend" as well, and both are sums over the agents
 * of one session that are still on the board — `pruneOldAgents` takes finished
 * subagents out from under a live session once the map passes 200. So the word
 * "total" was wrong here too, in the same way and for the same reason; what
 * these two surfaces can honestly claim is a scope, which is the session named
 * beside the figure.
 */
export const SESSION_SPEND_LABEL = "session spend";
