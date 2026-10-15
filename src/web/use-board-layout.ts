// The board's arrangement, as state: where every card was put, which of those
// the user pinned, which are placeholders, the signature the layout keys off,
// the epoch that forces a rebuild, and the frame the arrangement was packed
// for. Restored from storage on the first render.
//
// Moved out of App.tsx unchanged, with R (handleRelayout), which touches
// nothing else. The rest happens where each is read: snapshotToFlow reads and
// fills them (use-board-graph.ts), the reframe throws them away
// (use-reframe.ts), the drag handlers pin (use-node-drag.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Frame } from "./layout";
import {
  clearStoredLayout, loadLayout, loadLayoutFrame, readStoredArrangement, restoreStoredArrangement, saveLayout,
  saveLayoutFrame,
} from "./layout-storage";
import type { Provisional } from "./placement";
import {
  createUndoWindow, REARRANGE_RESTORED_SAID, REARRANGE_UNDO_SAID, restoreArrangement, snapshotArrangement,
  type Arrangement, type RearrangeSnapshot, type UndoHold,
} from "./rearrange-undo";
import { restoreLayout } from "./stored-layout";
import type { useCamera } from "./use-camera";

type Camera = ReturnType<typeof useCamera>;

/** The camera's three that R and its Undo reach: R frames the board it has just
 *  drawn and keeps the view it replaced, and Undo moves back to that view. */
export function useBoardLayout({ fitLeft, moveCamera, currentViewport }: Pick<Camera, "fitLeft" | "moveCamera" | "currentViewport">) {
  // Restore pinned positions synchronously on first render so they're
  // applied before snapshotToFlow runs autoLayout. Sessions outlast a
  // browser refresh (their session_id is stable), so dragged positions
  // come back where you left them.
  //
  // Once, in a `useState` initialiser — the form App.tsx's `restoredViewport` has
  // always used, and for the same reason. As a `useRef` argument the whole of
  // this ran on EVERY render and every result but the first was discarded
  // (#612): a getItem, a JSON.parse, and two Maps, four times a second on an
  // idle deck and once per pointer move through a drag — the same drag that is
  // in the middle of rewriting the value being re-read.
  //
  // The pinned half also stopped being quadratic in the process — see
  // restoreLayout in stored-layout.ts, which is where that lives so it can be
  // tested without a DOM.
  const restoredLayout = useState(() => restoreLayout(loadLayout()))[0];
  const pinnedRef = useRef(restoredLayout.pinned);

  // Position cache + structural signature. Layout reruns only when the set
  // of visible agents OR sizes OR pin-set changes — NOT on every event.
  // Seeded from storage so a reload resumes the arrangement that was on screen
  // rather than re-deriving one. Anything without a stored position — a new
  // agent, or one whose position was evicted — still gets laid out.
  // Built once, beside the pinned half, in the initialiser up at
  // `restoredLayout` — the argument here is a read and not a `new Map` (#612).
  const positionsRef = useRef(restoredLayout.positions);
  // Which of those positions are placeholders. Deliberately not persisted: the
  // retry runs on the next render, at most a 250ms tick away, and the save
  // (useLayoutAutosave, below) is debounced 1500ms — so a placeholder is
  // overwritten by a real coordinate long before anything writes it to
  // storage, and a mark restored from a previous run would only relayout a
  // node that has been settled since.
  const provisionalRef = useRef<Provisional>(new Set());
  const lastLayoutSigRef = useRef<string>("");
  // Moved wherever the cached positions are thrown away — R, below, and the
  // reframe (use-reframe.ts). The board is rebuilt inside the memo that calls
  // snapshotToFlow (use-board-graph.ts), and emptying positionsRef moves none
  // of that memo's deps, so the rerender both used to ask for handed back the
  // cached board and the rebuild waited for the clock's next 250ms tick. The
  // save and the fit each of them runs 80ms later then read the arrangement
  // they had just discarded, most of the time: R was never stored, and a reload
  // drew a different board (#1331). In the deps, the render they schedule is
  // the one that rebuilds.
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  // THE FRAME THE BOARD ON SCREEN WAS PACKED FOR (#995).
  //
  // Seeded from storage, because the frame a restored layout was built in is
  // not this window's: a deck reopened after a monitor change comes back with
  // coordinates that are internally consistent and shaped for a canvas that is
  // no longer there.
  //
  // Read through a lazy initialiser and held in a ref, the shape `restoredLayout`
  // uses: `useRef(loadLayoutFrame())` would put a localStorage read on the
  // render path for an answer only the first render asks for (#612).
  const restoredLayoutFrame = useState(loadLayoutFrame)[0];
  const lastLayoutFrameRef = useRef<Frame | null>(restoredLayoutFrame);

  // RE-ARRANGE'S WAY BACK (rearrange-undo.ts). What R throws away is kept for
  // a few seconds, and the canvas offers it back: the strip on the board, ⌘Z
  // or Ctrl+Z, until the clock runs out, Escape, or a drag moves on from the
  // board R drew. `said` is the polite live region's, mounted with the strip.
  const [undoOffered, setUndoOffered] = useState(false);
  const [undoSaid, setUndoSaid] = useState("");
  const undoWindow = useState(() => createUndoWindow<RearrangeSnapshot>(open => {
    setUndoOffered(open);
    if (!open) setUndoSaid(said => (said === REARRANGE_RESTORED_SAID ? said : ""));
  }))[0];
  useEffect(() => () => undoWindow.close(), [undoWindow]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => (document.hidden ? undoWindow.hold("hidden") : undoWindow.release("hidden"));
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [undoWindow]);
  /** R's store-and-fit, while it is still 80ms away: Undo cancels it. */
  const relayoutTimerRef = useRef<number | null>(null);
  /** The live maps, read when asked: R and the reframe replace what is in them,
   *  never the maps themselves. */
  const arrangement = (): Arrangement => ({
    positions: positionsRef.current, pinned: pinnedRef.current, provisional: provisionalRef.current, layoutSig: lastLayoutSigRef,
  });

  // R: throw the arrangement away, pins included, and draw it again from the
  // board as it is.
  const handleRelayout = useCallback(() => {
    // The copy first — unless one is already offered. A drag ends the offer,
    // so a second R while it is up has had nothing built on the board the
    // first drew: its own copy would be that board, an Undo that changes
    // nothing, and the hand-built one gone after all, which is the stray
    // double press this exists for. It keeps the first copy and starts the
    // clock again. (Inside the first press's 80ms there would be nothing
    // whole to copy anyway: the maps half rebuilt, storage empty.)
    undoWindow.open(undoWindow.snapshot ?? snapshotArrangement(arrangement(), readStoredArrangement(), currentViewport()));
    setUndoSaid(REARRANGE_UNDO_SAID);
    pinnedRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    setLayoutEpoch(e => e + 1);
    // After dagre runs on the next render, fit-view so the user sees the
    // result. 80ms gives React + RF one paint to settle the new positions.
    if (relayoutTimerRef.current != null) window.clearTimeout(relayoutTimerRef.current);
    relayoutTimerRef.current = window.setTimeout(() => {
      relayoutTimerRef.current = null;
      // And store it, for the reason the reframe (use-reframe.ts) does: the
      // debounced save is keyed on layoutSig, which R does not move, so the
      // board R drew was never written — the storage it had just emptied stayed
      // empty, and a reload rebuilt the board from the replay instead (#1331).
      // With it goes the frame it was packed for, which clearStoredLayout
      // removed with the arrangement it described.
      saveLayout(positionsRef.current, pinnedRef.current);
      if (lastLayoutFrameRef.current) saveLayoutFrame(lastLayoutFrameRef.current);
      fitLeft(500);
    }, 80);
  }, [fitLeft, currentViewport, undoWindow]);

  /** Puts back the board R replaced — the maps, the stored keys and the view —
   *  and says whether there was one to put back. False once the offer has gone,
   *  which is how ⌘Z knows to leave the chord to the browser. */
  const undoRearrange = useCallback((): boolean => {
    const kept = undoWindow.take();
    if (!kept) return false;
    if (relayoutTimerRef.current != null) window.clearTimeout(relayoutTimerRef.current);
    relayoutTimerRef.current = null;
    restoreArrangement(kept, arrangement());
    restoreStoredArrangement(kept.stored);
    setLayoutEpoch(e => e + 1);
    // The cards snap back as R snapped them away; the camera travels back over
    // the 500ms R's fit took, through the door that keeps auto-fit as it was.
    if (kept.viewport) moveCamera(kept.viewport, 500);
    setUndoSaid(REARRANGE_RESTORED_SAID);
    return true;
  }, [moveCamera, undoWindow]);
  const dismissRearrangeUndo = useCallback(() => undoWindow.close(), [undoWindow]);
  const holdRearrangeUndo = useCallback((why: UndoHold) => undoWindow.hold(why), [undoWindow]);
  const releaseRearrangeUndo = useCallback((why: UndoHold) => undoWindow.release(why), [undoWindow]);
  const rearrangeUndo = {
    open: undoOffered, said: undoSaid, undo: undoRearrange,
    dismiss: dismissRearrangeUndo, hold: holdRearrangeUndo, release: releaseRearrangeUndo,
  };

  return { restoredLayout, pinnedRef, positionsRef, provisionalRef, lastLayoutSigRef, layoutEpoch, setLayoutEpoch, lastLayoutFrameRef,
           handleRelayout, rearrangeUndo };
}

/** Keeps the stored layout in step with the board: moved out of App.tsx
 *  unchanged, and called there once layoutSig has been worked out. */
export function useLayoutAutosave(layoutSig: string, layout: ReturnType<typeof useBoardLayout>): void {
  // Persist the arrangement whenever it changes, not only when the user drags.
  // Auto-placed nodes are part of what gets restored on reload, so a session
  // that was never touched still comes back where it was. Debounced: layoutSig
  // moves on every structural change and localStorage writes are synchronous.
  const { positionsRef, pinnedRef } = layout;
  const layoutSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (layoutSaveTimerRef.current != null) window.clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = window.setTimeout(() => {
      saveLayout(positionsRef.current, pinnedRef.current);
    }, 1500);
    return () => { if (layoutSaveTimerRef.current != null) window.clearTimeout(layoutSaveTimerRef.current); };
  }, [layoutSig]);
}
