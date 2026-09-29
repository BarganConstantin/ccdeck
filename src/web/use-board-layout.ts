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
import { clearStoredLayout, loadLayout, loadLayoutFrame, saveLayout, saveLayoutFrame } from "./layout-storage";
import type { Provisional } from "./placement";
import { restoreLayout } from "./stored-layout";
import type { useCamera } from "./use-camera";

/** `fitLeft` is the camera's: R frames the board it has just drawn. */
export function useBoardLayout(fitLeft: ReturnType<typeof useCamera>["fitLeft"]) {
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

  // R: throw the arrangement away, pins included, and draw it again from the
  // board as it is.
  const handleRelayout = useCallback(() => {
    pinnedRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    setLayoutEpoch(e => e + 1);
    // After dagre runs on the next render, fit-view so the user sees the
    // result. 80ms gives React + RF one paint to settle the new positions.
    window.setTimeout(() => {
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
  }, [fitLeft]);

  return { restoredLayout, pinnedRef, positionsRef, provisionalRef, lastLayoutSigRef, layoutEpoch, setLayoutEpoch, lastLayoutFrameRef,
           handleRelayout };
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
