// THE BOARD AS THE FACES DRAW IT. Below the full card neither the tool bubbles
// nor the sessions' notes are drawn, and the canvas kept for them closes up.
//
// The layout pitches a column at its cards plus the lane their bubbles take at
// full size, and the next column's notes stand in front of its cards, so two
// columns of one-card sessions stood about 1,150 units apart for 260 of card.
// From a distance all of that was empty canvas: beside one side panel the fit
// held the board at 38% to keep it, every card a pill, half the width an empty
// band (owner's critique, round 3, point 1).
//
// The board itself does not move. Pins, the stored board, the bubbles and a
// focus all read its places, and they are the places the full card is drawn
// at. What changes is what React Flow is handed below the full card: a map of
// x that draws every band of empty canvas wider than PACKED_GAP between two
// runs of cards PACKED_GAP wide. The fit sizes its zoom on the same map
// (fit-board.ts), the board draws through it (use-board-graph.ts), a drag
// turns the drawn place back into the board's (use-node-drag.ts), and where the
// zoom crosses into or out of it the camera holds the card the reader is
// zooming at (use-repack-anchor.ts).
import type { Node } from "reactflow";
import { NODE_H, NODE_W, RANK_SEP } from "./layout-geometry";

/** The widest band of empty canvas the packed board keeps between two cards
 *  side by side: the gap a rank keeps when its parent has no bubbles, so the
 *  board is drawn as if no card had called a tool. Narrower bands are kept. */
export const PACKED_GAP = RANK_SEP;

/** A map of x from the board to the board as drawn, and back. Both ways are
 *  continuous and increasing, so nothing changes sides and nothing new
 *  overlaps: only empty canvas gets narrower. */
export interface Squeeze {
  /** Where the board's `x` is drawn. */
  at(x: number): number;
  /** The board's x for a drawn `x`. */
  back(x: number): number;
}

/** Nothing closed up: the board as it is. */
export const NO_SQUEEZE: Squeeze = { at: x => x, back: x => x };

/** `x` carried through the knots `from` → `to`: linear between two knots,
 *  and one to one before the first and after the last. */
function through(x: number, from: readonly number[], to: readonly number[]): number {
  const n = from.length;
  if (n === 0 || !Number.isFinite(x)) return x;
  if (x <= from[0]) return x - from[0] + to[0];
  if (x >= from[n - 1]) return x - from[n - 1] + to[n - 1];
  for (let i = 1; i < n; i++) {
    if (x > from[i]) continue;
    const span = from[i] - from[i - 1];
    return span > 0 ? to[i - 1] + ((x - from[i - 1]) * (to[i] - to[i - 1])) / span : to[i];
  }
  return x;
}

/**
 * The squeeze for these spans across the board (a card's left and right).
 *
 * Spans that overlap, or stand no more than `gap` apart, are one run and keep
 * their spacing. Between two runs the band is drawn `gap` wide, and the first
 * run stays where it is, so the board's left edge does not move. One run or
 * none: nothing to close.
 */
export function squeezeSpans(spans: Iterable<{ left: number; right: number }>, gap = PACKED_GAP): Squeeze {
  const sorted = [...spans]
    .filter(s => Number.isFinite(s.left) && Number.isFinite(s.right) && s.right >= s.left)
    .sort((p, q) => p.left - q.left);
  const runs: { left: number; right: number }[] = [];
  for (const s of sorted) {
    const last = runs[runs.length - 1];
    if (last && s.left - last.right <= gap) last.right = Math.max(last.right, s.right);
    else runs.push({ left: s.left, right: s.right });
  }
  if (runs.length < 2) return NO_SQUEEZE;
  const from: number[] = [];
  const to: number[] = [];
  let drawn = runs[0].left;
  runs.forEach((r, i) => {
    if (i > 0) drawn += gap;
    from.push(r.left, r.right);
    to.push(drawn, drawn + (r.right - r.left));
    drawn += r.right - r.left;
  });
  return { at: x => through(x, from, to), back: x => through(x, to, from) };
}

/** The squeeze for a board: the spans of its cards. A note is not drawn at
 *  this distance and claims none (packNodes folds it behind its card). */
export function boardSqueeze(nodes: readonly Node[]): Squeeze {
  const spans: { left: number; right: number }[] = [];
  for (const n of nodes) {
    if (n.type === "agent") spans.push({ left: n.position.x, right: n.position.x + (n.width ?? NODE_W) });
  }
  return squeezeSpans(spans);
}

/**
 * The board as the faces draw it: each card where `squeeze` draws it, and each
 * note folded behind its card. A note is hidden below the full card, and left
 * where it stands it would put its session's drag handle across the band that
 * closed, over the column before. Nodes that do not move are handed back as
 * they are.
 */
export function packNodes<N extends Node>(nodes: readonly N[], squeeze: Squeeze): N[] {
  const moved = (n: N, x: number): N => (x === n.position.x ? n : { ...n, position: { x, y: n.position.y } });
  const cards = new Map<string, number>();
  const placed = nodes.map(n => {
    if (n.type === "recapNote") return n;
    const x = squeeze.at(n.position.x);
    if (n.type === "agent") cards.set(n.id, x);
    return moved(n, x);
  });
  return placed.map(n => {
    if (n.type !== "recapNote") return n;
    const parent = (n.data as { parentId?: string } | undefined)?.parentId;
    const x = parent != null ? cards.get(parent) : undefined;
    return moved(n, x ?? squeeze.at(n.position.x));
  });
}

/** A camera, in React Flow's terms: the board's 0 drawn at (x, y) in the
 *  pane, `zoom` screen px to the board's unit. */
export interface View { x: number; y: number; zoom: number }

/**
 * The point in the pane a zoom from `prev` to `next` held still: the pointer
 * of a wheel or a pinch, the pane's middle for the zoom buttons. Null when the
 * zoom did not change, since a pan holds no point still.
 */
export function zoomFocus(prev: View, next: View): { x: number; y: number } | null {
  const dz = prev.zoom - next.zoom;
  if (!(Math.abs(dz) > 1e-6)) return null;
  const x = (next.x * prev.zoom - prev.x * next.zoom) / dz;
  const y = (next.y * prev.zoom - prev.y * next.zoom) / dz;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * How far the camera moves sideways, in screen px, when the board stops being
 * drawn through `from` and is drawn through `to` (null: as laid out), so the
 * card nearest `focus` stays where the reader sees it. Every other card moves
 * by its own distance from that one; only x is packed, so only x moves.
 */
export function anchorShift(
  nodes: readonly Node[], from: Squeeze | null, to: Squeeze | null, view: View, focus: { x: number; y: number },
): number {
  let best = Infinity, shift = 0;
  for (const n of nodes) {
    if (n.type !== "agent") continue;
    const was = from ? from.at(n.position.x) : n.position.x;
    const left = was * view.zoom + view.x, top = n.position.y * view.zoom + view.y;
    const right = left + (n.width ?? NODE_W) * view.zoom, bottom = top + (n.height ?? NODE_H) * view.zoom;
    const dx = Math.max(left - focus.x, 0, focus.x - right);
    const dy = Math.max(top - focus.y, 0, focus.y - bottom);
    const d = dx * dx + dy * dy;
    if (d >= best) continue;
    best = d;
    shift = (was - (to ? to.at(n.position.x) : n.position.x)) * view.zoom;
  }
  return shift;
}
