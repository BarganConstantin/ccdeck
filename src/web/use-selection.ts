// Which agents are selected, and which one of them is primary.
//
// Lifted out of App.tsx's `Inner`. The two pieces of state had three writers:
// a selection, a clear, and the clock's tick dropping ids whose agents had been
// evicted (#576). The first two were already named operations; the third was
// two setter calls in the middle of the tick. It is `pruneSelectionToBoard`
// now, and with it every write is one of the three below, and the setters are
// this file's alone.
//
// The detail panel is not this hook's. Selecting opens it (#814), so the
// panel's setter comes in as a parameter, under the name it has in App.tsx.
import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { pruneSelection } from "./prune";
import type { GraphState } from "./reducer";

export function useSelection(stateRef: MutableRefObject<GraphState>, setDetailOpen: Dispatch<SetStateAction<boolean>>) {
  // Selection model: a set of agent ids contributes to spotlight lineage.
  // The primary selection (last clicked) drives the right-hand detail
  // panel and the topbar ribbon — multi-select extends the spotlight but
  // doesn't try to show N agents in the side panel at once.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [primarySelectedId, setPrimarySelectedId] = useState<string | null>(null);

  const selectAgent = useCallback((id: string, additive: boolean, inspect: boolean = !additive) => {
    setSelectedIds(prev => {
      if (!additive) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setPrimarySelectedId(prev => {
      if (!additive) return id;
      // Shift+click: if we just added, this becomes primary; if we just
      // removed primary, fall back to "any other selected" or null.
      if (prev === id) return prev;
      return id;
    });
    // Selecting an agent IS inspecting it (#814). A card clicked, stepped to
    // with j/k, picked from the session list or answered with Enter opens the
    // detail panel; its × still closes it for now, and the next selection
    // brings it back. Shift+click only widens the spotlight, so it leaves the
    // panel as it was.
    //
    // Except from a pointer on the canvas, which passes `inspect: false`: a
    // click on a card goes to its session instead (onNodeClick), and the panel
    // is the double-click's — the owner's call on 2026-09-19, over #814's for
    // the click. j/k, the list, W, Enter and D still open it.
    if (!additive && inspect) setDetailOpen(true);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setPrimarySelectedId(null);
  }, []);

  /** Drop every selected id whose agent is no longer on the board, so the
   *  selection never names an evicted agent (#576). Read through the ref when
   *  React applies it, not when it is asked for: a `__clear` over SSE replaces
   *  the map, and the updater should see the one that is current by then. Both
   *  updaters return their previous value when there is nothing to drop, so
   *  React bails out and no render happens. */
  const pruneSelectionToBoard = useCallback(() => {
    setSelectedIds(prev => pruneSelection(prev, stateRef.current.agents));
    setPrimarySelectedId(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));
  }, [stateRef]);

  return { selectedIds, primarySelectedId, selectAgent, clearSelection, pruneSelectionToBoard };
}
