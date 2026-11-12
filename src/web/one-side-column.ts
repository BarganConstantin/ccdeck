// One side column at a time between 641 and 839px.
//
// A window that narrow has no room for both side columns beside the board: at
// 720px with the Sessions rail and the Inspector open, 40 + 264 + board + 320 +
// 40 left the board 56px. Material's guidance is one pane under 840dp, and that
// is the rule here. When one side column opens while the other is open, the
// other folds to its stripe, and closing the one that took the room brings the
// other back. The most recently opened side wins; a load with both open shows
// the right (the Inspector, Usage, This machine) and folds the left.
//
// A fold is display only. Neither side's stored open flags are touched, so a
// window widened to 840 or more shows both again, as the reader left them. A
// folded side reads closed on its stripe, and a door or key that opens it
// brings it back over the other (foldAwareSet), rather than closing a panel
// nobody can see.
//
// The phone (640 and under) has its own sheets and is left alone, and so is
// Workspace, where the two sides are sheets over the pane at these widths and
// have their own rules (use-left-column.ts useWorkspaceColumn, App.tsx).
import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useMediaQuery } from "./use-media-query";
import { useMirroredRef } from "./use-mirrored-ref";

export type Side = "left" | "right";

/** The band the rule holds in: wider than a phone, narrower than 840. */
export const ONE_SIDE_QUERY = "(min-width: 641px) and (max-width: 839px)";

export interface SidesShown { left: boolean; right: boolean }

/** Which side columns are drawn, given which are open. Outside the band both
 *  are drawn as they are open; inside it, with both open, only the last one
 *  opened. */
export function sideColumnsShown({ narrow, leftOpen, rightOpen, lastOpened }: {
  narrow: boolean; leftOpen: boolean; rightOpen: boolean; lastOpened: Side;
}): SidesShown {
  if (!narrow || !leftOpen || !rightOpen) return { left: leftOpen, right: rightOpen };
  return lastOpened === "left" ? { left: true, right: false } : { left: false, right: true };
}

/** The side opened last, after the two open flags moved from `prev` to `now`.
 *  Both opening at once is a load's case, and the right wins it. */
export function lastOpenedSide(prev: SidesShown & { last: Side }, now: SidesShown): Side {
  if (now.right && !prev.right) return "right";
  if (now.left && !prev.left) return "left";
  return prev.last;
}

/** A side's setter answered against what is on screen. While the side is
 *  folded every panel in it reads closed, so a toggle opens, and an open
 *  brings the side back over the other; a close goes through as it is. */
export function foldAwareSet(
  set: Dispatch<SetStateAction<boolean>>, folded: () => boolean, raise: () => void,
): Dispatch<SetStateAction<boolean>> {
  return next => {
    if (!folded()) { set(next); return; }
    const want = typeof next === "function" ? next(false) : next;
    if (want) raise();
    set(want);
  };
}

/** A door's press on the left, which holds one panel at a time (Sessions or
 *  Accounts), answered against what is on screen. Folded, the door reads
 *  closed: the press brings the column back, and moves it to the door's panel
 *  when the other one holds it. */
export function foldAwarePress(press: () => void, p: { folded: () => boolean; holds: () => boolean; raise: () => void }): () => void {
  return () => {
    if (!p.folded()) { press(); return; }
    p.raise();
    if (!p.holds()) press();
  };
}

interface Track extends SidesShown {
  /** Board, not Workspace: the only view the rule is for. */
  board: boolean;
  last: Side;
}

export interface OneSideColumn {
  /** The side is open and folded to its stripe. Read from the last settled
   *  inputs; `settle` corrects them before the render is committed. */
  fold: SidesShown;
  /** `fold`, for callbacks that outlive a render. */
  foldRef: MutableRefObject<SidesShown>;
  /** A press or key opened that side: it is the one opened last. */
  raise: (side: Side) => void;
  /** The open flags as this render has them, given once they are known. A
   *  change is a state update during render, which React answers by running
   *  the render again before it commits, so no frame draws both columns. */
  settle: (now: SidesShown & { board: boolean }) => void;
}

/**
 * The rule for App. `initial` is the load's best reading of the open flags,
 * before the selection and the stage exist: what the first render draws.
 */
export function useOneSideColumn(initial: SidesShown & { board: boolean }): OneSideColumn {
  const band = useMediaQuery(ONE_SIDE_QUERY);
  const [track, setTrack] = useState<Track>(() => ({ ...initial, last: initial.right ? "right" : "left" }));
  const shown = sideColumnsShown({ narrow: band && track.board, leftOpen: track.left, rightOpen: track.right, lastOpened: track.last });
  const fold = { left: track.left && !shown.left, right: track.right && !shown.right };
  const foldRef = useMirroredRef(fold);
  const raise = useCallback((side: Side) => setTrack(t => (t.last === side ? t : { ...t, last: side })), []);
  const settle = (now: SidesShown & { board: boolean }) => {
    if (now.left === track.left && now.right === track.right && now.board === track.board) return;
    setTrack({ ...now, last: lastOpenedSide(track, now) });
  };
  return { fold, foldRef, raise, settle };
}
