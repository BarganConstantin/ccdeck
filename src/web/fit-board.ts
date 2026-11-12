// THE FIT, AS ARITHMETIC: where fitLeft (use-camera.ts) puts the camera for a
// board, given the board's own places, the pane and what the floating panels
// cover of it. fitLeft measures; this decides, so the decision can be tested
// without a canvas.
//
// It reads the board's places, never the places the faces draw it at
// (packed-board.ts), so the answer does not depend on the zoom the camera
// happens to be at: fitted twice, a board lands on the same frame twice.
import { PAD as GROUP_PAD } from "./session-chrome";
import { CARD_BODY_PX, DETAIL_EXIT_PX, FAR_ZOOM, fitZoomForDrawnLanes } from "./semantic-zoom";
import { TOOL_LANE_W } from "./layout-geometry";
import { squeezeSpans } from "./packed-board";
import { FIT_FILL, FIT_MARGIN } from "./use-layout-frame";

/** Cards are drawn at their natural size at 1, and magnifying past it only
 *  makes a small board look coarse. */
export const FIT_MAX_ZOOM = 1;
/** The least an explicit fit goes to (Fit all, F): the canvas's own floor. */
export const FIT_MIN_ZOOM = 0.2;
/** The least the AUTO-fit goes to: the zoom below which a card's face stops
 *  saying its task beside its state (semantic-zoom.ts). A board that does not
 *  fit there is shown from its top left at this zoom, and the reader pans. */
export const AUTO_FIT_MIN_ZOOM = FAR_ZOOM;

/** A node on the board, in flow units: a card (`agent`), a note, a session's handle. */
export interface FitRect { left: number; right: number; top: number; bottom: number; type?: string }

export interface FitFrame {
  /** The canvas, in px. */
  pane: { width: number; height: number };
  /** How much of its right edge the floating panels cover (use-layout-frame.ts railCover). */
  rail: number;
  /** The card's body type at the reader's text size (semantic-zoom.ts cardBodyPx). */
  bodyPx?: number;
  /** The least zoom this fit may land on. */
  floor?: number;
}

export interface FitBox { minX: number; minY: number; w: number; h: number }

/**
 * Where the camera frames `rects`: left-anchored, at the largest zoom that
 * shows the board, never above 1 and never below `floor`.
 *
 * Two boxes. `all` is everything, with the tool bubbles' lane beside it: what
 * the full card draws. `cards` is the cards alone in their session's padding:
 * what the faces draw. Below the full card the faces draw the board packed —
 * the bands kept for bubbles and notes closed up (packed-board.ts) — so its
 * zoom is sized on the packed width, from the same left edge, and held under
 * the full card by fitZoomForDrawnLanes, where no mode draws the bubbles that
 * width left no room for.
 */
export function fitBoard(rects: readonly FitRect[], { pane: paneRect, rail: railWidth, bodyPx = CARD_BODY_PX, floor = FIT_MIN_ZOOM }: FitFrame)
  : { x: number; y: number; zoom: number } | null {
  const MARGIN = FIT_MARGIN, MAX_ZOOM = FIT_MAX_ZOOM, MIN_ZOOM = FIT_MIN_ZOOM, FILL = FIT_FILL;
  if (rects.length === 0) return null;
  const boxOf = (list: readonly FitRect[], pad = 0): FitBox => {
    const minX = Math.min(...list.map(r => r.left)) - pad;
    const minY = Math.min(...list.map(r => r.top)) - pad;
    const w = Math.max(...list.map(r => r.right)) + pad - minX;
    const h = Math.max(...list.map(r => r.bottom)) + pad - minY;
    return { minX, minY, w, h };
  };
  const all = boxOf(rects);
  // The cards alone, in the session handle's own padding, for the zooms where
  // a session's note is not drawn (below the full card, the faces;
  // context-modal.css). The note and the handle around it (which covers the
  // note too) framed where nothing is drawn: every working session's box was
  // half empty on its left and the board stood off to the right.
  const agents = rects.filter(r => r.type === "agent");
  const cards = agents.length > 0 ? boxOf(agents, GROUP_PAD) : all;
  if (!(all.w > 0 && all.h > 0) || !(cards.w > 0 && cards.h > 0)) return null;
  const packed = packedBox(agents, cards);

  // Tool bursts are an overlay rather than nodes, so they are absent from
  // these rects — leave room or the last column's chips get clipped. The
  // rail's strip is not room either: a board framed into it would put its
  // last column under the machine and usage panels.
  const fitWith = (box: { w: number; h: number }, lane: number) => Math.max(MIN_ZOOM, Math.min(
    MAX_ZOOM,
    ((paneRect.width - railWidth - MARGIN * 2) / (box.w + lane)) * FILL,
    ((paneRect.height - MARGIN * 2) / box.h) * FILL,
  ));
  // The notes go with the bubbles: both are drawn only at the full card, so
  // the zoom that keeps them frames them and the one below it does not.
  const zoom = Math.max(floor, fitZoomForDrawnLanes(fitWith(all, TOOL_LANE_W), fitWith(packed, 0), bodyPx));
  // The box that zoom shows: everything where the full card may be drawn
  // (the band between the two thresholds keeps whichever it came from, so it
  // is given the room), the cards alone below it. Packing keeps the board's
  // left edge, top and height, so the frame is the same packed or not.
  const { minX, minY, h } = zoom * bodyPx >= DETAIL_EXIT_PX ? all : cards;
  return {
    x: MARGIN - minX * zoom,
    // Tall canvases read down from the top. Centring a width-bound board
    // there left hundreds of empty pixels above and below its sessions.
    // Keep the familiar vertical centring on landscape/square canvases.
    y: (paneRect.height > paneRect.width - railWidth
      ? MARGIN : Math.max(MARGIN, (paneRect.height - h * zoom) / 2)) - minY * zoom,
    zoom,
  };
}

/** The cards' box as the faces draw it: the same left edge, top and height,
 *  as wide as the board's cards are once the bands between them close. */
export function packedBox(agents: readonly FitRect[], cards: FitBox): FitBox {
  if (agents.length === 0) return cards;
  const squeeze = squeezeSpans(agents);
  const right = Math.max(...agents.map(r => r.right));
  return { ...cards, w: squeeze.at(right) + GROUP_PAD - cards.minX };
}
