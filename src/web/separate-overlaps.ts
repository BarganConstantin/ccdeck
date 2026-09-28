// The overlap repair: push apart only the cards that overlap, and leave every
// other card where it is.
//
// Runs on every structural change, after `autoLayout` has placed whatever was
// new, and never re-lays anything out — so an arrangement the user has lived
// with survives it.
import type { Node } from "reactflow";
import { CARD_MARGIN, CROSS_SESSION_X, CROSS_SESSION_Y, footprint, sessionOfNode, type Lanes } from "./layout-geometry";

/**
 * Push apart only the nodes that overlap, leaving everything else where it is.
 *
 * The layout pass runs once per node and then never again, so an arrangement
 * survives reloads and structural changes. The cost of that is that a newly
 * placed node can land on an older one, and two sessions can drift together.
 * This is the repair: it walks the nodes in a stable order, and the first time
 * a node covers ground already taken it slides down until it is clear.
 *
 * Deliberately minimal. Re-running the full layout would fix more and move
 * everything; this fixes the specific thing that is wrong and touches nothing
 * else, which is what makes it safe to run on every structural change.
 *
 * Pinned nodes are obstacles but never move — the user put them there. Mutates
 * `positions`; returns the ids it had to move.
 *
 * `lanes` is the same map `autoLayout` gets. It has to be, because this runs on
 * every structural change and dagre runs once: reserving the lane there and
 * omitting it here means the repair packs the cards back to card clearance and
 * a 420px lane runs straight through the neighbour. Resolution is still on Y
 * alone, so a lane overhanging to the right is cleared by sliding the node it
 * covers below it rather than further out.
 *
 * `held` nodes do not move either, but only for a while: they are positions
 * restored from storage while the board they were saved with is still coming
 * back (#1333, see snapshotToFlow). They are laid down before the walk starts,
 * so a node that covers one slides off it wherever the two sit in the order. A
 * pin only stands in the way of the nodes after it, and a card placed a few
 * pixels above a restored one would be left lying on it — to push it down
 * after all the moment the hold lifted.
 */
export function separateOverlaps(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  lanes?: Lanes,
  held?: { has(id: string): boolean },
): string[] {
  const sizeOf = (id: string) => footprint(id, measured, lanes);

  // Stable order: by y, then x, then id. Same input always yields the same
  // result, so a re-render cannot make nodes drift.
  const sessionOf = new Map(nodes.map(n => [n.id, sessionOfNode(n)]));

  const placed: Array<{ x: number; y: number; w: number; h: number; sid: string }> = [];
  const ordered = nodes
    .map(n => ({ id: n.id, pos: pinned.get(n.id) ?? positions.get(n.id) }))
    .filter((n): n is { id: string; pos: { x: number; y: number } } => n.pos != null)
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));

  // A pin is left to the walk below, where it has always been an obstacle.
  const isHeld = (id: string) => held?.has(id) === true && !pinned.has(id);
  for (const { id, pos } of ordered) {
    if (!isHeld(id)) continue;
    const { w, h } = sizeOf(id);
    placed.push({ x: pos.x, y: pos.y, w, h, sid: sessionOf.get(id) ?? "_default" });
  }

  const moved: string[] = [];
  for (const { id, pos } of ordered) {
    if (isHeld(id)) continue;
    const { w, h } = sizeOf(id);
    const sid = sessionOf.get(id) ?? "_default";
    // A dragged node is an obstacle for everything else but is never itself
    // relocated.
    if (pinned.has(id)) { placed.push({ x: pos.x, y: pos.y, w, h, sid }); continue; }

    let y = pos.y;
    // Re-check from the start after each shift: sliding clear of one node can
    // push into another that was already checked.
    for (let guard = 0; guard < placed.length + 1; guard++) {
      const clash = placed.find(r => {
        const mx = r.sid === sid ? CARD_MARGIN : CROSS_SESSION_X;
        const my = r.sid === sid ? CARD_MARGIN : CROSS_SESSION_Y;
        return pos.x < r.x + r.w + mx && r.x < pos.x + w + mx &&
               y     < r.y + r.h + my && r.y < y     + h + my;
      });
      if (!clash) break;
      y = clash.y + clash.h + (clash.sid === sid ? CARD_MARGIN : CROSS_SESSION_Y);
    }
    if (y !== pos.y) { positions.set(id, { x: pos.x, y }); moved.push(id); }
    placed.push({ x: pos.x, y, w, h, sid });
  }
  return moved;
}
