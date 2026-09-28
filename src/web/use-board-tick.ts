// Tick clock so elapsed-time fields refresh smoothly + exit animations
// clean up. Same tick also reaps in-flight tools whose PostToolUse never
// arrived (e.g. the session was killed mid-call) so they don't pulse
// forever in the burst layer.
//
// Moved out of App.tsx unchanged, with the `now` it keeps: nothing else sets
// it. The sweeps themselves are prune.ts's sweepTick; this is the timer, what
// it tells the server, and the selection and modals it closes behind them.
import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { sweepTick } from "./prune";
import type { GraphState } from "./reducer";

export function useBoardTick({ stateRef, rerender, pruneSelectionToBoard, setContextFor, setSummaryFor }: {
  stateRef: MutableRefObject<GraphState>;
  rerender: () => void;
  pruneSelectionToBoard: () => void;
  /** The context modal's agent id, closed once that agent is evicted (#781). */
  setContextFor: Dispatch<SetStateAction<string | null>>;
  /** The session summary's session id, closed the same way. */
  setSummaryFor: Dispatch<SetStateAction<string | null>>;
}): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      // Every sweep this tick runs, on the shipped constants, with the whole
      // sessions they evicted collected — see sweepTick in prune.ts, which is
      // where the order, the constants and the #1024 collection can be run by
      // a test (#1175).
      const { changed, forgotten } = sweepTick(stateRef.current, t);
      if (forgotten.length > 0) {
        // The server drops its change-gated name and model caches for these,
        // or a session evicted while idle and then resumed shows as unnamed for
        // the rest of the day (#1024). Failure is not worth reporting and not
        // worth retrying: the worst it costs is the state this fixes, which is
        // what every deck had before.
        fetch("/api/forget", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: forgotten }),
        }).catch(() => {});
      }
      // And the selection along with them, so it never names an agent that has
      // been evicted (#576). Run unconditionally rather than under `changed`:
      // a `__clear` over SSE empties the map through applyEvent, which this
      // tick never hears about. See the operation for why it costs nothing
      // when there is nothing to drop.
      pruneSelectionToBoard();
      // AND THE TWO MODALS THAT NAME AN AGENT, for a reason worse than the
      // selection's (#781). Both render nothing once their subject is gone —
      // the context modal returns null on `if (!root)`, and buildSummary
      // returns null on the same `agents.get(sessionId)` — but `modalOpenRef`
      // is computed from the ID rather than from what rendered, so it stayed
      // true with no dialog on screen. From there `shortcutBlocked` refused
      // every key but `?` and `clearActionFor` answered "ignore" for both the
      // trash button and C: every shortcut in the deck dead for the life of the
      // tab, recoverable only by reloading. A session finishing and being
      // evicted two minutes later is all it took.
      //
      // Cleared here rather than fixing the flag to match the render, because a
      // modal whose subject has been evicted should CLOSE rather than sit there
      // invisible-but-counted. `summaryFor` is a session id and `contextFor` an
      // agent id, and both resolve through `agents.get`, so one test serves.
      setContextFor(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));
      setSummaryFor(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));
      if (changed) rerender();
    }, 250);
    return () => clearInterval(id);
  }, [rerender]);
  return now;
}
