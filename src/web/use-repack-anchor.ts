// THE SWITCH BETWEEN THE PACKED BOARD AND THE BOARD AS LAID OUT, held still
// where the reader is zooming.
//
// Crossing the full card's threshold changes where every card after the first
// column is drawn (packed-board.ts). Left to itself the canvas carried them
// there on the cards' own Slow transition, a column sliding 480px across the
// screen under a pinch. Now, in the frame the cards move, the camera moves
// sideways by as much as the card nearest the zoom's focus did, so that card
// stays put and the rest close up or open out around it; and the cards take
// their new places at once (`data-repack`, canvas-motion.css).
//
// Only for the reader's zoom: a fit or a focus that crosses the threshold is
// already on its way to a frame worked out for the board it lands on.
import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import type { Node } from "reactflow";
import { anchorShift, type Squeeze, type View } from "./packed-board";

/** Where the last zoom held still, and whether the reader made it
 *  (use-canvas-viewport.ts). */
export interface ZoomFocus { x: number; y: number; reader: boolean }

/** The attribute that holds the cards' travel off for the switch. */
export const REPACK_ATTR = "data-repack";

export function useRepackAnchor({ packed, nodes, squeeze, focusRef, canvasRef, getViewport, panBy }: {
  /** Whether the board is drawn packed this render. */
  packed: boolean;
  /** The board's own places (use-board-graph.ts `nodes`). */
  nodes: Node[];
  /** The map it is drawn through, null where it is drawn as laid out. */
  squeeze: Squeeze | null;
  focusRef: MutableRefObject<ZoomFocus | null>;
  canvasRef: MutableRefObject<HTMLElement | null>;
  getViewport: () => View;
  panBy: (dx: number) => void;
}): void {
  const lastRef = useRef<{ packed: boolean; squeeze: Squeeze | null }>({ packed, squeeze });
  const switchRef = useRef<{ from: Squeeze | null; to: Squeeze | null } | null>(null);
  const last = lastRef.current;
  if (last.packed !== packed) switchRef.current = { from: last.squeeze, to: squeeze };
  lastRef.current = { packed, squeeze };
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Before React Flow is handed the moved cards (its store takes them in an
  // effect of its own, after this commit), so no card starts a transition.
  useLayoutEffect(() => {
    if (switchRef.current) canvasRef.current?.setAttribute(REPACK_ATTR, "");
  }, [packed]);

  // After React Flow's effect has taken the moved cards, so the camera and the
  // cards land in one frame.
  useEffect(() => {
    const move = switchRef.current;
    if (!move) return;
    switchRef.current = null;
    const focus = focusRef.current;
    if (focus?.reader) panBy(anchorShift(nodesRef.current, move.from, move.to, getViewport(), focus));
    const el = canvasRef.current;
    if (!el) return;
    // Two frames: the moved cards have been styled without travel by then.
    requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute(REPACK_ATTR)));
  }, [packed]);
}
