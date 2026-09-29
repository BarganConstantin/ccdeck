// The board's half of the usage panel's figures: the By model rows, the total
// the headline prints when ccusage has not answered, and the $/min in the
// header — with the samples that rate is measured from.
//
// Lifted out of components/UsagePanel.tsx. The two refs holding the rate's
// history were the panel's, readable and writable from anywhere in its render;
// they are this hook's alone now, so the memo that reads and extends them is
// the only code that can touch them.
import { useMemo, useRef } from "react";
import { boardModelTable, boardTotals } from "./board-usage";
import { boardBySession } from "./live-delta";
import { fmtCostRate } from "./pricing";
import type { GraphState } from "./reducer";
import { recordSpend, spendRate, NO_SPEND_HISTORY, type SpendHistory } from "./spend-rate";

/**
 * @param liveSince When the stream's replay landed, or null while there is
 *   none — the $/min counts only from here (#821).
 */
export function useBoardSpend(state: GraphState, now: number, liveSince: number | null) {
  /** Per-session spend against the clock, for the header's $/min (#821). A ref,
   *  because the samples are history the memo below reads and extends — not
   *  state, which would re-render the panel for every sample it takes. */
  const spendSamples = useRef<SpendHistory>(NO_SPEND_HISTORY);
  /** The replay the samples above were taken after. A new one — a reconnect —
   *  starts them again, since it re-applies the ring the board was built from. */
  const spendSince = useRef<number | null>(null);

  // Keyed on `state.revision`, not on `state.lastSeq` — and so is the panel's
  // `bySessions`, for the same reason. The `state` prop is `stateRef.current`
  // and `applyEvent` mutates it in place, so its identity never moves after
  // mount and the second dep is the whole of what decides whether this
  // recomputes. `lastSeq` answers "when did the last envelope arrive", which is
  // a different question from "has anything in here changed": the four
  // periodic sweeps mutate this same object every 250ms tick and move only
  // `revision` — see the note on GraphState.
  //
  // It carries `now` as well, because `burnRate` samples the board total
  // against the clock (spend-rate.ts, #821) and has to keep moving while nothing
  // arrives. That third dep is
  // also what hid the wrong second one: `now` is a fresh Date.now() every tick,
  // so this recomputed four times a second whatever `lastSeq` said, and the
  // headline strip stayed honest through a prune by luck rather than by rule.
  // The panel's `bySessions` has no clock in it, and it is the one that went
  // stale.
  return useMemo(() => {
    // The headline's own arithmetic is `boardTotals`, called once below rather
    // than accumulated here (#687). It was a second copy of the topbar's, and
    // the file it moved to is the file that declares what the figure may be
    // called — which is the whole of the fix: the sum walks the agents on the
    // canvas, the pruners take agents off the canvas, and the only honest label
    // for such a number names the canvas. Splitting the label from the sum is
    // how "total spend" came to stand over a figure that falls by a third on a
    // quiet tick.
    //
    // The table is one pass per MODEL SHARE (#686), in board-usage.ts beside
    // `boardTotals` so the rows and the headline price the same shares through
    // the same helper — see boardModelTable.
    const byModel = boardModelTable(state.agents.values());

    const board = boardTotals(state.agents.values());
    // How fast the board is spending: its total's rise over the last ten minutes
    // (#821), not live agents' cost over the longest one's age — see
    // spend-rate.ts for why that swung eightfold between two tabs of one deck.
    // And only once the replay has landed: before that the board total is
    // history arriving, not spending (see liveSince in App.tsx).
    if (spendSince.current !== liveSince) {
      spendSince.current = liveSince;
      spendSamples.current = NO_SPEND_HISTORY;
    }
    // PER SESSION, not the board total (#987). The board gains a session's whole
    // accumulated cost the moment it first reaches the canvas, and against one
    // total that is indistinguishable from spending: a joining session carrying
    // $15 of history took a true $0.20/min to $1.70/min and held it for the
    // full ten-minute window. This is the same map the panel's live delta is
    // built on, and the same rule — only work the deck watched happen counts.
    const bySession = boardBySession(state.agents.values(), now);
    if (liveSince != null) spendSamples.current = recordSpend(spendSamples.current, now, bySession);
    const rate = liveSince == null ? null : spendRate(spendSamples.current, now, bySession);
    const burnRate = rate ? { label: fmtCostRate(rate.spent, rate.spanSec), spanMin: rate.spanMin } : null;
    return {
      byModel,
      totalCost: board.cost,
      totalTokens: board,
      burnRate,
    };
  }, [state, state.revision, now, liveSince]);
}
