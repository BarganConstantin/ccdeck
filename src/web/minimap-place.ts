// Where the minimap stands, and whether it is drawn at all (V4 critique, round
// 3, point 6: the minimap and the character stay off the work).
//
// A map of a board that is all in view tells the reader nothing the board does
// not, and it stood over the tool bubbles. So it is drawn only while part of
// the board is outside the view: some card, as React Flow draws it now (packed
// below the full card or not, packed-board.ts), is not wholly inside the
// canvas. Then it takes a bottom corner, the left one unless the right one
// covers fewer of the pixels the board draws: the cards, the subagents' cards,
// the notes and the tool bubbles. Never on a phone, never on an empty board
// (board-empty.ts); BoardFlow.tsx asks both.
// The store's reading and the hold are use-minimap-place.ts's.
import { NODE_H, NODE_W } from "./layout-geometry";
import { SESSION_GROUP_TYPE } from "./minimap";
import { CAMERA_SLOW_MS } from "./viewport-motion";

export type MinimapCorner = "left" | "right";

/** A rect in the pane's pixels, from its top left. */
export interface PaneRect { left: number; top: number; right: number; bottom: number }
/** A rect in the board's own units, before the camera. */
export type WorldRect = PaneRect;
type Camera = readonly [number, number, number];
type DrawnNode = {
  type?: string; hidden?: boolean; width?: number | null; height?: number | null;
  position: { x: number; y: number }; positionAbsolute?: { x: number; y: number };
};

/** The minimap's box: MINIMAP_SIZE (BoardFlow.tsx) with its 1px edge. */
export const MINIMAP_BOX = { width: 142, height: 107 } as const;
/** Its air from the canvas's side (react-flow.css --board-controls-edge) and
 *  from the floor (--board-controls-room at the default density): it stands a
 *  row up, over the control bar on the right and the notices on the left. */
export const MINIMAP_EDGE = 12;
export const MINIMAP_FLOOR = 50;
/** A card this close to the edge is in view: rounding, not the board. */
const SLACK = 1;
/** How long an answer has to hold before the minimap follows it. Longer than
 *  the camera's own moves, so a fit that passes through "part of the board
 *  is out" on its way to framing it all does not flash the map. */
export const MINIMAP_HOLD_MS = CAMERA_SLOW_MS + 200;

/** A world rect where the camera puts it in the pane. */
export function onPane({ left, top, right, bottom }: WorldRect, [x, y, zoom]: Camera): PaneRect {
  return { left: left * zoom + x, top: top * zoom + y, right: right * zoom + x, bottom: bottom * zoom + y };
}

function nodeRect(n: DrawnNode, w: number, h: number, camera: Camera): PaneRect {
  const at = n.positionAbsolute ?? n.position;
  return onPane({ left: at.x, top: at.y, right: at.x + w, bottom: at.y + h }, camera);
}

/** The cards as React Flow draws them, in the pane's pixels. Only cards: the
 *  part of the board whose being out of view brings the map. */
export function drawnCards(nodes: Iterable<DrawnNode>, camera: Camera): PaneRect[] {
  const out: PaneRect[] = [];
  for (const n of nodes) {
    if (n.type !== "agent" || n.hidden) continue;
    out.push(nodeRect(n, n.width ?? NODE_W, n.height ?? NODE_H, camera));
  }
  return out;
}

/** Everything the board draws, in the pane's pixels: every node React Flow
 *  draws (the cards, the subagents' cards, the notes) but the sessions'
 *  invisible drag handles (session-group-nodes.ts), and the tool bubbles,
 *  which are a layer of their own over the nodes (ToolBursts.tsx) and come in
 *  world space. A note React Flow has not measured yet is left out for the
 *  frame; a card counts at its default size, as it does in drawnCards. */
export function drawnWork(nodes: Iterable<DrawnNode>, camera: Camera, bubbles: readonly WorldRect[]): PaneRect[] {
  const out: PaneRect[] = [];
  for (const n of nodes) {
    if (n.hidden || n.type === SESSION_GROUP_TYPE) continue;
    const card = n.type === "agent";
    const w = n.width ?? (card ? NODE_W : null), h = n.height ?? (card ? NODE_H : null);
    if (w == null || h == null) continue;
    out.push(nodeRect(n, w, h, camera));
  }
  for (const b of bubbles) out.push(onPane(b, camera));
  return out;
}

/** Some card is not wholly inside the canvas. */
export function boardOffScreen(cards: readonly PaneRect[], pane: { width: number; height: number }): boolean {
  return cards.some(c => c.left < -SLACK || c.top < -SLACK || c.right > pane.width + SLACK || c.bottom > pane.height + SLACK);
}

/** The map is wanted: the pane is measured and part of the board is out of it. */
export function minimapWanted(cards: readonly PaneRect[], pane: { width: number; height: number }): boolean {
  return pane.width > 0 && pane.height > 0 && boardOffScreen(cards, pane);
}

/** The minimap's box in a bottom corner of the pane. */
export function cornerBox(corner: MinimapCorner, pane: { width: number; height: number }): PaneRect {
  const bottom = pane.height - MINIMAP_FLOOR;
  const left = corner === "left" ? MINIMAP_EDGE : pane.width - MINIMAP_EDGE - MINIMAP_BOX.width;
  return { left, top: bottom - MINIMAP_BOX.height, right: left + MINIMAP_BOX.width, bottom };
}

/** How many of the drawn pixels `box` covers. */
export function coveredPixels(drawn: readonly PaneRect[], box: PaneRect): number {
  let sum = 0;
  for (const c of drawn) {
    const w = Math.min(c.right, box.right) - Math.max(c.left, box.left);
    const h = Math.min(c.bottom, box.bottom) - Math.max(c.top, box.top);
    if (w > 0 && h > 0) sum += w * h;
  }
  return sum;
}

/** Bottom left, unless bottom right covers fewer drawn pixels; a tie stays left. */
export function minimapCorner(drawn: readonly PaneRect[], pane: { width: number; height: number }): MinimapCorner {
  const left = coveredPixels(drawn, cornerBox("left", pane));
  if (left === 0) return "left";
  return coveredPixels(drawn, cornerBox("right", pane)) < left ? "right" : "left";
}

/** Where the minimap stands, or null: not drawn. Whether is the cards' to say
 *  (minimapWanted); where is for everything drawn, `work`, the cards alone
 *  when nothing else is handed in. */
export function minimapPlace(
  cards: readonly PaneRect[], pane: { width: number; height: number }, work: readonly PaneRect[] = cards,
): MinimapCorner | null {
  return minimapWanted(cards, pane) ? minimapCorner(work, pane) : null;
}
