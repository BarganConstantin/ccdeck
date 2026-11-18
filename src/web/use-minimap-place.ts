// The minimap's place (minimap-place.ts), read from React Flow's store: the
// cards and notes where it draws them now, the camera and the pane, with the
// tool bubbles ToolBursts drew (bubble-boxes.ts) and the selected card it must
// keep off. A string comes back, so the board's frames re-render the minimap
// only when the answer changes.
import { useCallback, useEffect, useState } from "react";
import { useStore, type ReactFlowState } from "reactflow";
import { useBubbleBoxes } from "./bubble-boxes";
import {
  clearOfKept, coversKept, drawnCards, drawnSelection, drawnWork, MINIMAP_HOLD_MS, minimapCorner, minimapWanted,
  type MinimapCorner, type WorldRect,
} from "./minimap-place";

const CORNERS: readonly MinimapCorner[] = ["left", "right"];

/** The answer, and the corners that would cover the selection, as one string
 *  ("right/left": the map wants the right corner, the left one would stand over
 *  the card being read; "-/" no map), for one walk of the store per frame.
 *  Whether the map is wanted is the cards' to say; only then is the rest of
 *  what the board draws, bubbles and all, walked for the corner. */
function minimapState(s: ReactFlowState, bubbles: readonly WorldRect[], notes: boolean): string {
  const pane = { width: s.width, height: s.height };
  if (!minimapWanted(drawnCards(s.nodeInternals.values(), s.transform), pane)) return "-/";
  const keep = drawnSelection(s.nodeInternals.values(), s.transform, notes);
  const corner = clearOfKept(minimapCorner(drawnWork(s.nodeInternals.values(), s.transform, bubbles), pane), pane, keep);
  return `${corner ?? "-"}/${CORNERS.filter(c => coversKept(c, pane, keep)).join(",")}`;
}

/** Where the map stands now, or null: none. `notes`: whether the sessions'
 *  notes are drawn (the full card only), so a selected card's note is kept
 *  clear too. */
export function selectMinimapPlace(s: ReactFlowState, bubbles: readonly WorldRect[] = [], notes = true): MinimapCorner | null {
  const corner = minimapState(s, bubbles, notes).split("/")[0];
  return corner === "-" ? null : corner as MinimapCorner;
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
 *  map until it is let go, and it moves corners no sooner either. Nor over the
 *  card being read, not even for the hold before it changes corners: a corner
 *  that would cover the selection is no place at once. */
export function useMinimapPlace(notes = true): MinimapCorner | null {
  const bubbles = useBubbleBoxes();
  const select = useCallback((s: ReactFlowState) => minimapState(s, bubbles, notes), [bubbles, notes]);
  const [answer, blockedList] = useStore(select).split("/");
  const wanted = answer === "-" ? null : answer as MinimapCorner;
  const pressed = usePressedOnMap();
  const [place, setPlace] = useState<MinimapCorner | null>(null);
  useEffect(() => {
    if (pressed) return;
    if (wanted === null) { setPlace(null); return; }
    const timer = setTimeout(() => setPlace(wanted), MINIMAP_HOLD_MS);
    return () => clearTimeout(timer);
  }, [wanted, pressed]);
  if (wanted === null && !pressed) return null;
  if (place !== null && !pressed && blockedList.split(",").includes(place)) return null;
  return place;
}
