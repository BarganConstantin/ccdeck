// The Sessions list's pins (list-pinned.ts holds the rules), kept in storage
// the way the hidden rows are (use-list-hidden.ts): read once when the list
// is drawn, written on every change, and pruned of the sessions that have
// left the board once the deck has heard its whole history.
//
// Nothing here reaches a process, a pane or the Board's cards: a pin only
// decides where the list draws a row.
import { useCallback, useEffect, useState } from "react";
import { prunedPinned, readListPinned, saveListPinned, togglePinned, type PinnedIds } from "./list-pinned";
import { localStore } from "./storage";

export function useListPinned({ agents, revision, ready }: {
  /** The board's agents, read when asked (the reducer changes the map in place). */
  agents: ReadonlyMap<string, { kind: string }>;
  /** The board's revision, which moves whenever the map's contents do. */
  revision: number;
  /** The deck has heard its whole history: a session it does not know now has
   *  left the board, and its pin goes. */
  ready: boolean;
}) {
  // Through localStore(), never `window.localStorage` as the argument: on a
  // profile that blocks site data the accessor itself throws (#1628).
  const [pinnedIds, setPinned] = useState<PinnedIds>(() => readListPinned(localStore()));
  const change = useCallback((make: (previous: PinnedIds) => PinnedIds) => setPinned(previous => {
    const next = make(previous);
    if (next !== previous) saveListPinned(localStore(), next);
    return next;
  }), []);

  // An empty board is not read as every session gone: a board being cleared
  // or one not yet filled says nothing yet, and the pins wait for the next
  // session to arrive before the ones that did not come back are dropped.
  useEffect(() => {
    if (!ready || agents.size === 0) return;
    change(previous => prunedPinned(previous, id => agents.get(id)?.kind === "root"));
  }, [ready, agents, revision]);

  const isPinned = (id: string) => pinnedIds.includes(id);
  /** Pins the session, or takes its pin off. */
  const toggle = useCallback((id: string) => change(previous => togglePinned(previous, id)), [change]);

  return { pinnedIds, isPinned, toggle };
}
