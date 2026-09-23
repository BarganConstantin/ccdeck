// What the deck's aggregate money and token figures are summed over, and what
// they are allowed to be called. One module, because those two things must
// never be changed apart.
//
// #687. The usage panel's headline said "total spend" and the topbar's chip
// beside it said "cost", and neither was a total of anything anyone had spent.
// (The topbar chips were later dropped outright, for the reason the labels were
// added: a figure that needs a qualifier and a three-line tooltip to be honest
// was not worth the width, with ccusage answering the same question properly
// one panel over. The scope constants that survive are the panel's.)
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
import { costForUsage, ratesForModel, type CostBreakdown } from "./pricing";
import type { AgentState } from "./types";
// Tokens are priced at the model that produced them, not at the last model the
// agent was seen on (#686). This module is the seventh surface that multiplied
// one by the other, and the reason it is the seventh rather than a survivor is
// that it was written to be the ONE place the board arithmetic lives — so it is
// also the one place the board arithmetic can be wrong.
import { agentCost, agentUnpricedTokens, usageByModelEntries, type UsageBearing } from "./usage-models";

/** Anything the deck can price: an agent, or a test's stand-in for one.
 *
 *  `UsageBearing` rather than `{usage, model}`, because those two fields are no
 *  longer enough to price anything: a session that switched model carries its
 *  split beside them, and a `Billable` that could not hold one would quietly
 *  send every mixed session back to last-wins on this surface alone. */
export type Billable = UsageBearing;

/** Every token and every dollar on the board right now, in one pass. */
export interface BoardTotals {
  cost: CostBreakdown;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** input + output — the gate the usage panel opens its money block on, and
   *  the figure its token strip prints. Cache traffic is deliberately outside it:
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
 * costs. The topbar's copy has since gone with its chips, and the one caller
 * left prints this arithmetic under labels declared in the same file as it.
 */
export function boardTotals(agents: Iterable<Billable>): BoardTotals {
  const cost: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0;
  for (const a of agents) {
    const c = agentCost(a);
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

/**
 * The tooltip every board-wide figure carries. One surface now — the usage
 * panel — where it was two before the topbar chips were dropped.
 *
 * Three sentences, in the order a reader needs them: what is counted, why it
 * can fall, and where the durable answer lives. The last one is the reason this
 * is a scope statement rather than an apology — the deck does know the real
 * total, it is one keystroke away, and it is not this number.
 *
 * No CLI is named in it. The board sums Claude and Codex agents alike, and
 * `codex-copy.test.ts` holds the deck's copy to that: a provider-blind figure
 * must not carry one product's name.
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

// ── the usage panel's two tables, when ccusage has not answered ─────────────
//
// ccusage is optional (AGENTS_DECK_NO_INSTALL, or no npm at all), and without
// it the "by model" and "by session" tables are folded from the board. The two
// folds lived inline in UsagePanel's memos, where nothing could run them: the
// tests that checked them re-typed the loops, and a re-typed loop goes on
// passing after the real one changes (#1175). They are here, beside the
// headline they have to agree with, and the panel calls them.

/** The model key for an agent that has not reported one yet. Kept out of the
 *  display: the map needs a key and the reader needs a word, and `__unknown__`
 *  is only the first of those. */
export const UNKNOWN_MODEL = "__unknown__";

/** One row of the board's "by model" table. */
export interface BoardModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: CostBreakdown;
  agentCount: number;
  /** False when this build holds no rate for the model — the row's tokens are
   *  real and its dollars are unknowable, which is not the same as zero. */
  priced: boolean;
}

/** One row of the board's "by session" table. */
export interface BoardSessionRow {
  sessionId: string;
  label: string;
  state: AgentState;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens on this session that no rate could be applied to. Non-zero and a
   *  `cost` of zero is a session nothing here can price; non-zero beside a
   *  non-zero cost is a mixed session whose figure is a floor, not a total. */
  unpricedTokens: number;
}

/** What the session table reads off an agent, beyond what prices it. */
export interface SessionBillable extends Billable {
  kind: string;
  sessionId: string;
  label?: string;
  cwdBasename?: string;
  state: AgentState;
}

/** How many sessions the board's table keeps. */
export const BOARD_SESSION_ROWS = 12;

/**
 * The board's "by model" table: one row per model the board's tokens came
 * from, cost first and tokens as the tiebreak.
 *
 * One pass per MODEL SHARE, not one per agent (#686). An agent whose session
 * switched model contributes a share to each row it actually spent on, with the
 * tokens that model produced and the dollars those tokens cost — so a
 * mostly-Opus session that ended on Sonnet is an Opus row AND a Sonnet row
 * rather than one Sonnet row holding the whole 1.1M. The rows sum to the
 * headline, because `boardTotals` prices the same shares through the same
 * helper.
 *
 * `now` reaches the price table, whose rates move on dates of their own.
 */
export function boardModelTable(agents: Iterable<Billable>, now: number = Date.now()): BoardModelRow[] {
  const modelMap = new Map<string, BoardModelRow>();
  for (const a of agents) {
    for (const e of usageByModelEntries(a)) {
      const key = e.model ?? UNKNOWN_MODEL;
      const c = costForUsage(e.usage, e.model, now);
      const row = modelMap.get(key);
      if (row) {
        row.inputTokens        += e.usage.inputTokens;
        row.outputTokens       += e.usage.outputTokens;
        row.cacheReadTokens    += e.usage.cacheReadTokens;
        row.cacheCreateTokens  += e.usage.cacheCreateTokens;
        row.cost.total         += c.total;
        row.cost.input         += c.input;
        row.cost.output        += c.output;
        row.cost.cacheRead     += c.cacheRead;
        row.cost.cacheWrite    += c.cacheWrite;
        row.agentCount++;
      } else {
        modelMap.set(key, {
          model: key,
          inputTokens:       e.usage.inputTokens,
          outputTokens:      e.usage.outputTokens,
          cacheReadTokens:   e.usage.cacheReadTokens,
          cacheCreateTokens: e.usage.cacheCreateTokens,
          cost: { ...c },
          agentCount: 1,
          priced: ratesForModel(e.model, now) != null,
        });
      }
    }
  }
  // Cost first, then tokens. Every unpriced row costs exactly zero, so without
  // the tiebreak they arrive at the bottom of the table in Map insertion order
  // — which is the order their agents happened to be observed in, and reads as
  // no order at all. Tokens are the only magnitude those rows have.
  return Array.from(modelMap.values()).sort((a, b) =>
    (b.cost.total - a.cost.total)
    || ((b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)));
}

/**
 * The board's "by session" table: one row per root, carrying its own figures
 * and every same-session subagent's, the top BOARD_SESSION_ROWS by cost then
 * tokens.
 *
 * Unpriced tokens are counted per agent because a session can mix providers — a
 * Claude root that spawned a Codex subagent prices one and not the other — and,
 * since #686, per MODEL inside each agent as well: a root that ran on a priced
 * model and then on one this build has never heard of prints its priced
 * dollars with the floor marker beside them, rather than swinging between fully
 * priced and fully unpriced depending on which model wrote its last line.
 *
 * Roots only, which is the one place this can fall short of the headline: a
 * subagent left on the board after its root was evicted is in `boardTotals` and
 * in no row here.
 */
export function boardSessionTable(agents: Iterable<SessionBillable>, now: number = Date.now()): BoardSessionRow[] {
  const all = [...agents];
  const roots: BoardSessionRow[] = [];
  for (const a of all) {
    if (a.kind !== "root") continue;
    let cost = agentCost(a, now).total;
    let inT = a.usage.inputTokens, outT = a.usage.outputTokens;
    let unpricedT = agentUnpricedTokens(a, now);
    for (const sub of all) {
      if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
      cost += agentCost(sub, now).total;
      inT  += sub.usage.inputTokens;
      outT += sub.usage.outputTokens;
      unpricedT += agentUnpricedTokens(sub, now);
    }
    roots.push({
      sessionId: a.sessionId,
      label: a.label || a.cwdBasename || "session",
      state: a.state,
      cost,
      inputTokens: inT,
      outputTokens: outT,
      unpricedTokens: unpricedT,
    });
  }
  // Same tiebreak as the model table, and it matters more here: this list is
  // cut, so before the tiebreak an unpriced session — however large — sat at
  // cost zero among every other zero and could be cut for a row with fewer
  // tokens than it.
  return roots
    .sort((a, b) => (b.cost - a.cost)
      || ((b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)))
    .slice(0, BOARD_SESSION_ROWS);
}
