// Settings › General's "Hide finished sessions after", applied to the board:
// the delay, the look over the board every HIDE_CHECK_MS, and the turns already
// acted on. The rules are hide-finished.ts's; the hiding is Remove from
// board's (use-removals.ts).
import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import {
  HIDE_CHECK_MS, hideFinishedAfter, markBroughtBack, readHandledTurns, saveHandledTurns, sessionsToHide,
  subscribeHideFinishedAfter,
} from "./hide-finished";
import type { GraphState } from "./reducer";
import { localStore } from "./storage";

/** The delay in minutes, re-rendering whoever asks when it changes; 0 is Never. */
export function useHideFinishedAfter(): number {
  return useSyncExternalStore(subscribeHideFinishedAfter, hideFinishedAfter, hideFinishedAfter);
}

export function useHideFinished({ stateRef, removedNodes, hideSessions, keepSessionId, ready }: {
  stateRef: MutableRefObject<GraphState>;
  removedNodes: ReadonlySet<string>;
  hideSessions: (ids: Iterable<string>) => void;
  /** The selected card's session: the one the reader is looking at stays. */
  keepSessionId: string | null;
  /** The history has been replayed. Before that a session can look finished
   *  that the rest of the replay shows working, and its work would predate the
   *  hide, so it would not bring it back (removalsLiftedByWork). */
  ready: boolean;
}): void {
  const afterMinutes = useHideFinishedAfter();
  // Read once, through the state initialiser: a ref's seed is evaluated on
  // every render (render-path-cost-612-613.test.ts).
  const [storedTurns] = useState(() => readHandledTurns(localStore()));
  const handledRef = useRef<ReadonlyMap<string, number>>(storedTurns);

  // A session that leaves the removal set has been brought back — by hand, or
  // by working again — and the turn it had finished is not hidden twice.
  const beforeRef = useRef(removedNodes);
  useEffect(() => {
    const next = markBroughtBack(handledRef.current, beforeRef.current, removedNodes, stateRef.current.agents.values());
    beforeRef.current = removedNodes;
    if (next === handledRef.current) return;
    handledRef.current = next;
    saveHandledTurns(localStore(), next);
  }, [removedNodes]);

  useEffect(() => {
    if (!ready || afterMinutes === 0) return;
    const look = () => {
      const due = sessionsToHide(stateRef.current.agents.values(), {
        afterMs: afterMinutes * 60_000,
        now: Date.now(),
        removed: removedNodes,
        handled: handledRef.current,
        keep: keepSessionId,
      });
      if (due.length === 0) return;
      const next = new Map(handledRef.current);
      for (const { id, endedAt } of due) next.set(id, endedAt);
      handledRef.current = next;
      saveHandledTurns(localStore(), next);
      hideSessions(due.map(d => d.id));
    };
    look();
    const timer = window.setInterval(look, HIDE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [ready, afterMinutes, removedNodes, keepSessionId, hideSessions]);
}
