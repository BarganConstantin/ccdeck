// The minimap's place (minimap-place.ts), read from React Flow's store: the
// cards and notes where it draws them now, the camera and the pane, with the
// tool bubbles ToolBursts drew (bubble-boxes.ts). A string comes back, so the
// board's frames re-render the minimap only when the answer changes.
import { useCallback, useEffect, useState } from "react";
import { useStore, type ReactFlowState } from "reactflow";
import { useBubbleBoxes } from "./bubble-boxes";
import {
  drawnCards, drawnWork, MINIMAP_HOLD_MS, minimapCorner, minimapWanted, type MinimapCorner, type WorldRect,
} from "./minimap-place";

/** Whether the map is wanted is the cards' to say; only then is the rest of
 *  what the board draws, bubbles and all, walked for the corner. */
export function selectMinimapPlace(s: ReactFlowState, bubbles: readonly WorldRect[] = []): MinimapCorner | null {
  const pane = { width: s.width, height: s.height };
  if (!minimapWanted(drawnCards(s.nodeInternals.values(), s.transform), pane)) return null;
  return minimapCorner(drawnWork(s.nodeInternals.values(), s.transform, bubbles), pane);
}

/** True from a press on the minimap until it is let go. */
function usePressedOnMap(): boolean {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".react-flow__minimap")) setPressed(true);
    };
    const up = () => setPressed(false);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, []);
  return pressed;
}

/** The place once it has held for MINIMAP_HOLD_MS. Going away is at once: a
 *  board brought wholly into view has no use for a map of it. Not under a
 *  press, though: a drag on the map that brings the board into view keeps the
 *  map until it is let go, and it moves corners no sooner either. */
export function useMinimapPlace(): MinimapCorner | null {
  const bubbles = useBubbleBoxes();
  const select = useCallback((s: ReactFlowState) => selectMinimapPlace(s, bubbles), [bubbles]);
  const wanted = useStore(select);
  const pressed = usePressedOnMap();
  const [place, setPlace] = useState<MinimapCorner | null>(null);
  useEffect(() => {
    if (pressed) return;
    if (wanted === null) { setPlace(null); return; }
    const timer = setTimeout(() => setPlace(wanted), MINIMAP_HOLD_MS);
    return () => clearTimeout(timer);
  }, [wanted, pressed]);
  return wanted === null && !pressed ? null : place;
}
