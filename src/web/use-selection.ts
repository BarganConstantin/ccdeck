// Which agents are selected, and which one of them is primary.
//
// Lifted out of App.tsx's `Inner`. The two pieces of state had three writers:
// a selection, a clear, and the clock's tick dropping ids whose agents had been
// evicted (#576). The first two were already named operations; the third was
// two setter calls in the middle of the tick. It is `pruneSelectionToBoard`
// now, and with it every write is one of the three below, and the setters are
// this file's alone. The two are one state since #1766, so one updater decides
// both and the primary cannot name a card the set has dropped.
//
// The detail panel is not this hook's. Selecting opens it (#814), so the
// panel's setter comes in as a parameter, under the name it has in App.tsx.
import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { pruneSelection } from "./prune";
import type { GraphState } from "./reducer";

/** The selected set and its primary, as one value so one updater decides
 *  both. The primary is always null or a member of `ids` (#1766). */
export interface Selection { ids: Set<string>; primary: string | null }

/** Where a click on `id` takes the selection. A plain click replaces it with
 *  `id`. A Shift+click toggles `id`: added, it becomes the primary; taken out
 *  while primary, the primary falls back to the card added most recently of
 *  those left (a Set keeps insertion order), or to null when none is; taken
 *  out while not primary, the primary stays where it is.
 *
 *  They were two states with two updaters, and the primary's never learned
 *  whether the click had added the card or removed it, so it named the card
 *  either way (#1766): Shift+clicking the primary out left the ribbon, the
 *  detail panel, Z and Delete on a card with no highlight, and Shift+clicking
 *  another card out made it the primary. */
export function nextSelection(prev: Selection, id: string, additive: boolean): Selection {
  if (!additive) return { ids: new Set([id]), primary: id };
  const ids = new Set(prev.ids);
  if (!ids.has(id)) {
    ids.add(id);
    return { ids, primary: id };
  }
  ids.delete(id);
  if (prev.primary !== id) return { ids, primary: prev.primary };
  let primary: string | null = null;
  for (const left of ids) primary = left;
  return { ids, primary };
}

export function useSelection(stateRef: MutableRefObject<GraphState>, setDetailOpen: Dispatch<SetStateAction<boolean>>) {
  // Selection model: a set of agent ids contributes to spotlight lineage.
  // The primary selection (last clicked) drives the right-hand detail
  // panel and the topbar ribbon — multi-select extends the spotlight but
  // doesn't try to show N agents in the side panel at once.
  const [selection, setSelection] = useState<Selection>(() => ({ ids: new Set(), primary: null }));
  const { ids: selectedIds, primary: primarySelectedId } = selection;

  const selectAgent = useCallback((id: string, additive: boolean, inspect: boolean = !additive) => {
    setSelection(prev => nextSelection(prev, id, additive));
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
    setSelection({ ids: new Set(), primary: null });
  }, []);

  /** Drop every selected id whose agent is no longer on the board, so the
   *  selection never names an evicted agent (#576). Read through the ref when
   *  React applies it, not when it is asked for: a `__clear` over SSE replaces
   *  the map, and the updater should see the one that is current by then. The
   *  updater returns its previous value when there is nothing to drop, so
   *  React bails out and no render happens. */
  const pruneSelectionToBoard = useCallback(() => {
    setSelection(prev => {
      const ids = pruneSelection(prev.ids, stateRef.current.agents);
      const primary = prev.primary != null && !stateRef.current.agents.has(prev.primary) ? null : prev.primary;
      return ids === prev.ids && primary === prev.primary ? prev : { ids, primary };
    });
  }, [stateRef]);

  return { selectedIds, primarySelectedId, selectAgent, clearSelection, pruneSelectionToBoard };
}
