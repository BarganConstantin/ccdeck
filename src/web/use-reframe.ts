// Re-column when the frame changes enough to change the answer, and keep the
// card the reader was looking at where they were looking.
//
// Moved out of App.tsx unchanged. It throws away the cached arrangement the
// way R does (use-board-layout.ts), minus the pins, and then either frames the
// new board or moves the camera by exactly as far as the kept card moved.
import { useEffect, type MutableRefObject } from "react";
import type { Edge, Node, ReactFlowInstance } from "reactflow";
import { laneMap } from "./canvas-flow";
import { frameForGitView } from "./git-view-fit";
import { columnsWouldChange, type Frame } from "./layout";
import { saveLayout, saveLayoutFrame } from "./layout-storage";
import type { GraphState } from "./reducer";
import type { useBoardLayout } from "./use-board-layout";
import type { useCamera } from "./use-camera";

export function useReframe({
  nodes, edges, settled, dragging, availableWidth, availableHeight, layout, camera, rf,
  measuredRef, stateRef, lastFocusRef, primarySelectedIdRef, focusAgentRef, autoFitDisabledRef,
}: {
  /** The board on screen, read (not watched) when the frame moves. */
  nodes: Node[];
  edges: Edge[];
  settled: boolean;
  dragging: boolean;
  /** The frame a fit shows the board in. */
  availableWidth: number;
  availableHeight: number;
  /** The arrangement this throws away and stores again. */
  layout: ReturnType<typeof useBoardLayout>;
  camera: ReturnType<typeof useCamera>;
  rf: ReactFlowInstance;
  measuredRef: MutableRefObject<Map<string, { width: number; height: number }>>;
  stateRef: MutableRefObject<GraphState>;
  lastFocusRef: MutableRefObject<{ id: string; at: number } | null>;
  primarySelectedIdRef: MutableRefObject<string | null>;
  focusAgentRef: MutableRefObject<(id: string) => void>;
  autoFitDisabledRef: MutableRefObject<boolean>;
}): void {
  const { lastLayoutFrameRef, pinnedRef, positionsRef, provisionalRef, lastLayoutSigRef, setLayoutEpoch } = layout;
  const { applyViewport, fitLeft, cameraEpochRef, lastFitTimeRef } = camera;
  // Re-column when the frame changes ENOUGH TO CHANGE THE ANSWER.
  //
  // autoLayout picks the column count by scoring each arrangement against the
  // frame a fit will show it in, but the key that decides whether it runs again
  // — visible agent ids plus the two size versions — says nothing about the
  // frame. Closing the accounts and usage panels on a 1280px window takes the
  // frame from 457.5 to 963.2 flow units (measured in Firefox against this
  // sheet), which is the difference between one column and two for a board of
  // four to six sessions. Nothing reconsidered it, so the board stayed a tall
  // strip beside empty canvas until the user pressed R.
  //
  // Adding the frame to `layoutSig` would not have done this: the branch that
  // re-columns is inside `if (missing.length > 0)`, and with every node already
  // placed a signature change reaches only separateOverlaps. Re-columning means
  // dropping the cached positions, which is what R does — minus the pins, which
  // are the user's own placements and survive here as they do in joinSessions.
  //
  // Gated on the ANSWER changing rather than on the frame moving. The frame
  // steps on every 40px of a window drag; the column count changes at a handful
  // of widths, and re-laying out on anything less would throw away the
  // arrangement fillGapsWithNewSessions built for a change that moves nothing.
  useEffect(() => {
    if (!settled || dragging) return;
    const frame: Frame = { width: availableWidth, height: availableHeight };
    if (!(frame.width > 0 && frame.height > 0)) return;
    const prev = lastLayoutFrameRef.current;
    lastLayoutFrameRef.current = frame;
    saveLayoutFrame(frame);
    if (!prev || (prev.width === frame.width && prev.height === frame.height)) return;
    const opts = {
      direction: "LR" as const,
      pinned: pinnedRef.current,
      measured: measuredRef.current,
      lanes: laneMap(stateRef.current),
    };
    if (!columnsWouldChange(nodes, edges, opts, prev, frame)) return;
    // WHAT THE READER IS LOOKING AT, BEFORE THE BOARD MOVES UNDER IT. With the
    // auto-fit on, the fit below frames the new arrangement and nothing needs
    // keeping. With it off — a pan, or a focus — the camera used to stay where
    // it was while every session moved to a new column, so selecting a card
    // (which opens the detail panel, which narrows the canvas, which is this
    // frame change) sent the card the reader had just clicked somewhere off
    // the screen they were reading. A double-click to focus lost its session
    // the same way: the focus framed where the card was a paint before the
    // re-pack moved it.
    const focused = lastFocusRef.current && Date.now() - lastFocusRef.current.at < 1500 ? lastFocusRef.current.id : null;
    const keepId = focused ?? primarySelectedIdRef.current;
    const keptAt = keepId ? (pinnedRef.current.get(keepId) ?? positionsRef.current.get(keepId)) : undefined;
    for (const id of Array.from(positionsRef.current.keys())) {
      if (!pinnedRef.current.has(id)) positionsRef.current.delete(id);
    }
    provisionalRef.current.clear();
    lastLayoutSigRef.current = "";
    setLayoutEpoch(e => e + 1);
    // Same 80ms handleRelayout waits: React and React Flow get one paint to
    // settle the new positions before the camera is asked to frame them.
    window.setTimeout(() => {
      // The board is only rebuilt during the render the epoch schedules —
      // positionsRef holds nothing but the pins until then — so this is the
      // first moment there is a new arrangement to store. It has to be stored
      // here because the debounced save is keyed on layoutSig, which a frame
      // change does not move: without this the next reload would restore the
      // arrangement this pass just replaced, beside a frame record saying it
      // was packed for the new window.
      saveLayout(positionsRef.current, pinnedRef.current);
      // An open git view frames the selected session beside it, from the new
      // arrangement, whatever the auto-fit says: its own frame on the new
      // width ran before the re-pack moved the cards.
      if (frameForGitView(0)) return;
      if (autoFitDisabledRef.current) {
        // A focus this recent is framed again, from the new arrangement.
        if (focused) { focusAgentRef.current(focused); return; }
        // Otherwise the selected card stays where it was on screen: the view
        // moves by exactly as far as the re-pack moved the card.
        const movedTo = keepId ? (pinnedRef.current.get(keepId) ?? positionsRef.current.get(keepId)) : undefined;
        if (keptAt && movedTo && (movedTo.x !== keptAt.x || movedTo.y !== keptAt.y)) {
          const vp = rf.getViewport();
          cameraEpochRef.current += 1;
          applyViewport({ x: vp.x - (movedTo.x - keptAt.x) * vp.zoom, y: vp.y - (movedTo.y - keptAt.y) * vp.zoom, zoom: vp.zoom }, 0);
          lastFitTimeRef.current = Date.now();
        }
        return;
      }
      fitLeft(500);
    }, 80);
    // `nodes` and `edges` are read, not watched: they are rebuilt four times a
    // second and this has to run when the FRAME moves, on whatever board was on
    // screen at that moment.
  }, [availableWidth, availableHeight, settled, dragging, fitLeft, rf, applyViewport]);
}
