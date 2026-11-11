// Frame the board again when the canvas it is shown in changes size — a panel
// opening or closing, the window resized — without moving a card.
//
// Moved out of App.tsx. It used to re-column the board here too, whenever the
// new frame would have packed it into a different number of columns (#995): a
// card selected opened the Inspector, the Inspector narrowed the canvas, and
// every session moved to a new column under the reader's eye. The whole board
// flows into its columns on a fresh board's first layout and on R
// (canvas-flow.ts BoardFlow); a frame change is neither, so only the camera
// follows it.
import { useEffect, type MutableRefObject } from "react";
import type { Frame } from "./layout";
import { saveLayoutFrame } from "./layout-storage";
import type { useBoardLayout } from "./use-board-layout";
import type { useCamera } from "./use-camera";

export function useReframe({
  settled, dragging, availableWidth, availableHeight, layout, camera, lastFocusRef, focusAgentRef, autoFitDisabledRef,
}: {
  settled: boolean;
  dragging: boolean;
  /** The frame a fit shows the board in. */
  availableWidth: number;
  availableHeight: number;
  /** The frame the board was last shown in, compared against and stored. */
  layout: ReturnType<typeof useBoardLayout>;
  camera: ReturnType<typeof useCamera>;
  lastFocusRef: MutableRefObject<{ id: string; at: number } | null>;
  focusAgentRef: MutableRefObject<(id: string) => void>;
  autoFitDisabledRef: MutableRefObject<boolean>;
}): void {
  const { lastLayoutFrameRef } = layout;
  const { fitLeft, cameraEpochRef } = camera;
  useEffect(() => {
    if (!settled || dragging) return;
    const frame: Frame = { width: availableWidth, height: availableHeight };
    if (!(frame.width > 0 && frame.height > 0)) return;
    const prev = lastLayoutFrameRef.current;
    lastLayoutFrameRef.current = frame;
    saveLayoutFrame(frame);
    if (!prev || (prev.width === frame.width && prev.height === frame.height)) return;
    // The board keeps its positions, but its old viewport can leave cards
    // outside the narrowed canvas. Wait one paint for the pane to settle, then
    // fit while the deck owns the camera — or, with the auto-fit off, frame a
    // card the reader focused a moment ago again.
    const focused = lastFocusRef.current && Date.now() - lastFocusRef.current.at < 1500 ? lastFocusRef.current.id : null;
    const epoch = cameraEpochRef.current;
    const timer = window.setTimeout(() => {
      if (cameraEpochRef.current !== epoch) return;
      if (!autoFitDisabledRef.current) fitLeft();
      else if (focused && lastFocusRef.current?.id === focused) focusAgentRef.current(focused);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [availableWidth, availableHeight, settled, dragging, fitLeft]);
}
