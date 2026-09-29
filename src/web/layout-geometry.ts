// The measurements every layout pass shares: how big a card is, how much room
// its tool bubbles take beside it, how much chrome a session's box adds around
// its cards, and the zoom a fit would show a board at.
//
// Pulled out of layout.ts so the passes that run after it — the overlap repair,
// the gap filler, the push — measure a card and a session the same way
// `autoLayout` does. Two passes that disagree about how big something is pack
// one thing into the space the other reserved.
import type { Node } from "reactflow";
import { HEADER_H, LABEL_LIFT, PAD } from "./session-chrome";

export const NODE_W = 240;
export const NODE_H = 130;

// Chrome drawn around a session beyond its cards: outer padding on both sides,
// the label header, and the label tab that sits above the box's top edge — the
// three parts of session-chrome.ts, which the box and its drag handle are
// drawn with.
export const SESSION_CHROME = PAD * 2 + HEADER_H + LABEL_LIFT;

// Clear space wanted between one session's box and the next one's label tab.
// Measured as what the eye sees, not as the distance between card origins —
// the chrome is added on top, so changing this changes the visible gap by the
// same amount.
export const SESSION_VISIBLE_GAP = 72;
export const SESSION_GAP = SESSION_CHROME + SESSION_VISIBLE_GAP;

// Clear space two cards of the SAME session keep from each other.
export const CARD_MARGIN = 24;

// Two cards in DIFFERENT sessions need more than card clearance: each is drawn
// inside a cluster box that extends past it — padding on every side, a header
// strip, and a label tab above that. Cards 30px apart look fine and their boxes
// still cross, which is what "one on another" actually was. Sideways that is
// the two boxes' facing padding (PAD each) plus the card margin; down it is
// the gap two stacked sessions keep, chrome included. The overlap repair and
// the push both clear these, so the two agree on what "overlapping" means.
export const CROSS_SESSION_X = PAD * 2 + CARD_MARGIN;
export const CROSS_SESSION_Y = SESSION_GAP;

// Horizontal room between two session columns: a full card width. At 80px the
// columns read as one crowded field, with cluster boxes and their label tabs
// close enough to look joined. A whole node of clear space is where the eye
// stops trying to relate them. Measured from the widest card actually on
// screen rather than the default, so the gap holds when cards are wider.
//
// Read per node id, the way every other pass here reads `measured`. Walking
// the map's values instead took in the invisible per-session drag handles,
// which React Flow measures like any other node and which are as wide as the
// whole session box: one session fanned out to subagents reported ~1100px, and
// that became the pitch between two 240px columns. Either the fit check in
// layout.ts's `packColumns` then failed and every session collapsed into one very tall strip that
// fit-to-view had to shrink to cover, or the columns survived with an ~850px
// band of dead canvas between them.
export function columnGap(
  nodes: Node[],
  measured: Map<string, { width: number; height: number }>,
): number {
  let widest = NODE_W;
  for (const n of nodes) widest = Math.max(widest, measured.get(n.id)?.width ?? NODE_W);
  return widest;
}

/**
 * Width the tool-burst lane needs to the right of every agent card.
 *
 * Bursts are drawn by <ToolBursts/> as an overlay, not as React Flow nodes, so
 * dagre cannot see them and a session measured from its cards alone reports a
 * width that stops at the card's right edge. Packing columns on that number
 * puts the next column straight through this session's tool chips — which is
 * exactly what a second column made visible.
 *
 * Derived from ToolBursts: BUBBLE_OFFSET_X (60) + a primary bubble + SUB_GAP
 * (28) + a chained sub-bubble, with headroom for the long Codex labels that
 * size themselves from the label text.
 */
export const TOOL_LANE_W = 420;

/**
 * The closest a fit ever frames the board — fitLeft's MAX_ZOOM. Cards are drawn
 * at their natural size, so two arrangements that both show them 1:1 are
 * equally readable, and the one with fewer columns is the easier read.
 */
export const FULL_SIZE = 1;

/**
 * The zoom a fit would show a `w` x `h` board at, on a frame `canvasW` x
 * `canvasH` that shows it at full size.
 *
 * This is what picks the number of columns and where a new session goes. A cap
 * of two columns, and a second one only when both fitted the canvas at full
 * size, used to decide it instead — so one session fanning out to subagents
 * made two columns "not fit", everything collapsed into one strip several
 * screens tall, and the fit shrank the whole board to a third of its size
 * beside an empty right half. Scoring an arrangement by what the fit will
 * actually show spreads the board sideways exactly as far as the canvas's own
 * shape asks, and stops once the cards are at full size.
 */
export function fitZoom(w: number, h: number, canvasW: number, canvasH: number): number {
  return Math.min(FULL_SIZE, canvasW / Math.max(1, w), canvasH / Math.max(1, h));
}

export function sessionOfNode(n: Node): string {
  const sid = (n.data as { sessionId?: string } | undefined)?.sessionId;
  return sid ?? "_default";
}

/** The nodes of each session, keyed by `sessionOfNode`, in the order they are
 *  given; `keep` leaves some out. Sessions appear in the order their first
 *  kept node does. */
export function groupBySession(nodes: Node[], keep: (n: Node) => boolean = () => true): Map<string, Node[]> {
  const groups = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!keep(n)) continue;
    const sid = sessionOfNode(n);
    const list = groups.get(sid);
    if (list) list.push(n);
    else groups.set(sid, [n]);
  }
  return groups;
}

/** Bubbles currently drawn beside an agent, by agent id. Absent = none. */
export type Lanes = Map<string, number>;

/** Horizontal room this agent's bubbles need, or 0 when it has none. */
function laneWidth(id: string, lanes: Lanes | undefined): number {
  return (lanes?.get(id) ?? 0) > 0 ? TOOL_LANE_W : 0;
}

/** Vertical room, from ToolBursts: 6px inset then 36px per bubble. */
function laneHeight(id: string, lanes: Lanes | undefined): number {
  const n = lanes?.get(id) ?? 0;
  return n > 0 ? 6 + n * 36 : 0;
}

/** A card's own size: what React Flow measured, or the default until it has.
 *  The size a fit frames and a pin occupies; `footprint` is the one to pack
 *  and push with. */
export function cardSize(
  id: string,
  measured: Map<string, { width: number; height: number }>,
): { w: number; h: number } {
  const m = measured.get(id);
  return { w: m?.width ?? NODE_W, h: m?.height ?? NODE_H };
}

/**
 * The ground an agent actually covers: its card PLUS its burst lane.
 *
 * `measured` is what React Flow measured, and React Flow measures nodes —
 * bursts are an overlay, so a card with four chips streaming off its right edge
 * measures exactly as wide as one with none. Every pass that places or pushes a
 * box has to add the lane back itself, or it packs neighbours into space the
 * chips are already using and quietly undoes the reservation `layoutSession`
 * made — which is what a screenshot of tool chips drawn across the cards beside
 * them was. Sizing from `measured` alone is the bug; this is the size to use.
 */
export function footprint(
  id: string,
  measured: Map<string, { width: number; height: number }>,
  lanes: Lanes | undefined,
): { w: number; h: number } {
  const card = cardSize(id, measured);
  return {
    w: card.w + laneWidth(id, lanes),
    h: Math.max(card.h, laneHeight(id, lanes)),
  };
}

/**
 * Canonical string for a lane map, so a caller that caches its layout can tell
 * when the lanes have moved.
 *
 * An agent gaining its first bubble is as real a change in size as its card
 * being measured wider, and it has to invalidate a cached arrangement the same
 * way. The count is clamped by the caller at the four bubbles ToolBursts keeps,
 * so this settles after an agent's fourth tool call however many thousand it
 * goes on to make.
 */
export function laneSignature(lanes: Lanes): string {
  return [...lanes.keys()].sort().map(id => `${id}:${lanes.get(id)}`).join("|");
}
