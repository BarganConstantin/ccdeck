// The Sessions list's hidden rows (list-hidden.ts holds the rules): the marks,
// kept in storage, and the Undo the list offers for a few seconds after a
// hide, on Re-arrange's clock (rearrange-undo.ts createUndoWindow): the same
// seven seconds, held while the pointer or focus is on the strip or the tab is
// not being looked at.
//
// Nothing here reaches a process, a pane, the Board's cards or what Remove
// from board took off it: a mark only decides whether the list draws a row.
import { useCallback, useEffect, useState } from "react";
import { createUndoWindow, type UndoHold } from "./rearrange-undo";
import {
  hiddenLifted, hideSince, prunedHidden, readListHidden, saveListHidden, withHidden, withoutHidden,
  type HiddenMarks, type HiddenWorker,
} from "./list-hidden";
import type { RailGroup } from "./rail-model";
import { localStore } from "./storage";

/** What Undo puts back: the row, its name for the notice, and the row drawn
 *  before it, so a held order takes it back to its place. */
export interface HiddenUndo { id: string; name: string; after: string | null }

/** The notice's state and its controls (components/HideUndo.tsx). */
export interface ListHiddenOffer {
  open: boolean;
  /** The row the notice is about; empty while nothing is offered. */
  name: string;
  undo: () => void;
  dismiss: () => void;
  hold: (why: UndoHold) => void;
  release: (why: UndoHold) => void;
}

const NONE: ReadonlySet<string> = new Set();

export function useListHidden({ agents, revision, groupOf, ready }: {
  /** The board's agents, read when asked (the reducer changes the map in place). */
  agents: ReadonlyMap<string, HiddenWorker & { kind: string }>;
  /** The board's revision, which moves whenever the map's contents do. */
  revision: number;
  /** The group each session's row is in now, undefined for a session with no row. */
  groupOf: (id: string) => RailGroup | undefined;
  /** The deck has heard its whole history: a session it does not know now is
   *  one it has forgotten, and its mark can go. */
  ready: boolean;
}) {
  // Through localStore(), never `window.localStorage` as the argument: on a
  // profile that blocks site data the accessor itself throws (#1628).
  const [marks, setMarks] = useState<HiddenMarks>(() => readListHidden(localStore()));
  const change = useCallback((make: (previous: HiddenMarks) => HiddenMarks) => setMarks(previous => {
    const next = make(previous);
    if (next !== previous) saveListHidden(localStore(), next);
    return next;
  }), []);

  const [offered, setOffered] = useState<HiddenUndo | null>(null);
  const undoWindow = useState(() => createUndoWindow<HiddenUndo>(open => { if (!open) setOffered(null); }))[0];
  useEffect(() => () => undoWindow.close(), [undoWindow]);
  useEffect(() => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const onVisibility = () => (document.hidden ? undoWindow.hold("hidden") : undoWindow.release("hidden"));
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [undoWindow]);

  // Asked on every render, not only when the marks change: the work that lifts
  // a mark arrives as the board's own state.
  const lifted = marks.size === 0 ? NONE : new Set(hiddenLifted(marks, groupOf, agents.values()));
  const liftedKey = [...lifted].join("\n");
  useEffect(() => {
    if (lifted.size === 0) return;
    change(previous => withoutHidden(previous, lifted));
    // An Undo for a row that is back already has nothing left to do.
    if (undoWindow.snapshot && lifted.has(undoWindow.snapshot.id)) undoWindow.close();
  }, [liftedKey]);

  useEffect(() => {
    if (!ready || agents.size === 0) return;
    change(previous => prunedHidden(previous, id => agents.get(id)?.kind === "root"));
  }, [ready, agents, revision]);

  const isHidden = (id: string) => marks.has(id) && !lifted.has(id);

  const hide = useCallback((id: string, name: string, after: string | null) => {
    const since = hideSince(agents.values(), id, Date.now());
    change(previous => withHidden(previous, id, since));
    const kept = { id, name, after };
    undoWindow.open(kept);
    setOffered(kept);
  }, [agents, change, undoWindow]);

  /** Puts rows back: Show in list. */
  const show = useCallback((ids: readonly string[]) => {
    change(previous => withoutHidden(previous, ids));
    if (undoWindow.snapshot && ids.includes(undoWindow.snapshot.id)) undoWindow.close();
  }, [change, undoWindow]);

  /** Undo: the last row hidden comes back, and what it was is handed back so
   *  the list can put it in its place. Null once the offer has gone. */
  const undo = useCallback((): HiddenUndo | null => {
    const kept = undoWindow.snapshot;
    if (!kept) return null;
    // The mark first, the offer after: a render between the two (nothing
    // batching them) then draws the row back before it draws the offer gone,
    // never the offer gone with the row still hidden.
    change(previous => withoutHidden(previous, [kept.id]));
    undoWindow.take();
    return kept;
  }, [change, undoWindow]);

  const dismiss = useCallback(() => undoWindow.close(), [undoWindow]);
  const hold = useCallback((why: UndoHold) => undoWindow.hold(why), [undoWindow]);
  const release = useCallback((why: UndoHold) => undoWindow.release(why), [undoWindow]);

  /** The hidden sessions, the newest hide first. */
  const hiddenIds = [...marks.keys()].filter(id => !lifted.has(id)).reverse();

  return { isHidden, hiddenIds, hide, show, undo, offered, dismiss, hold, release };
}
