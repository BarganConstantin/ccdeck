// Where the subagents still on the board stand once a sibling has left: closed
// up under their parent, the way the column would have been drawn without the
// ones that are gone.
//
// A subagent joins its parent's column under the lowest sibling already there
// (join-sessions.ts), and a card that has a place keeps it. A subagent leaves
// the board a moment after it stops, and nothing closed the column behind it:
// a coordinator that starts and stops many subagents had its card at the top of
// its box, the two still working at the foot of it, and between them the height
// of every one that had finished. Every new one then went under the last.
import type { Node } from "reactflow";
import {
  CARD_MARGIN, CROSS_SESSION_X, CROSS_SESSION_Y, footprint, NODE_H, sessionOfNode, SIBLING_GAP, TOOL_LANE_W,
  type Lanes,
} from "./layout-geometry";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number; sid: string };

/** The parent a card was spawned from, when it has one. */
const parentOf = (n: Node): string | undefined => (n.data as { parentId?: string } | undefined)?.parentId;

/**
 * How far below its spot a card has to stand before it counts as a hole. A
 * departed sibling leaves a card and a gap, two hundred units; a rank dagre
 * centred on its parent, or a parent taller than its first child, stands off
 * the spot by less than half a card and is drawn the way it was laid out.
 */
const HOLE = NODE_H / 2;

/**
 * Close the holes departed subagents left in their parents' columns.
 *
 * For each parent on the board, its subagents standing in a column to its right
 * are walked top to bottom. The first may rise as far as level with its parent,
 * and each one after it as far as a sibling's gap under the one above, which is
 * where joinSessions puts a subagent spawned into the column. A card only ever
 * rises, and only when it stands at least half a card below that spot: a column
 * without a hole is left exactly where it is.
 *
 * A subagent moves with everything spawned under it, and only into ground that
 * is clear — of the cards of its own session by a card margin, of any other
 * session by the room its box needs, as separateOverlaps measures it. Where the
 * ground is not clear it stays, and the walk goes on under it. A card the user
 * dragged is a pin: never moved, and only an obstacle.
 *
 * `placedAt` answers for cards that have a real position — not a placeholder,
 * which is a card about to be laid out. Returns the sessions it moved, for the
 * board's motion to carry, the way a push is carried.
 */
export function closeSiblingGaps(
  nodes: Node[],
  positions: Map<string, Point>,
  pinned: Map<string, Point>,
  measured: Map<string, { width: number; height: number }>,
  lanes: Lanes | undefined,
  placedAt: (id: string) => Point | undefined,
): string[] {
  const sizeOf = (id: string) => footprint(id, measured, lanes);
  const sessionOf = new Map(nodes.map(n => [n.id, sessionOfNode(n)]));
  const cards = nodes.filter(n => n.type !== "recapNote");
  const children = new Map<string, Node[]>();
  for (const n of cards) {
    const p = parentOf(n);
    if (!p) continue;
    const list = children.get(p);
    if (list) list.push(n);
    else children.set(p, [n]);
  }
  if (children.size === 0) return [];

  const where = (id: string): Point | undefined => pinned.get(id) ?? placedAt(id);
  /** A card and every unpinned card spawned under it that has a place. */
  const subtree = (id: string): string[] => {
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const c of children.get(out[i]) ?? []) {
        if (!pinned.has(c.id) && placedAt(c.id)) out.push(c.id);
      }
    }
    return out;
  };

  const moved = new Set<string>();
  for (const [parentId, kids] of children) {
    const parent = where(parentId);
    if (!parent) continue;
    const column = kids
      .map(n => ({ id: n.id, at: pinned.has(n.id) ? undefined : placedAt(n.id) }))
      .filter((k): k is { id: string; at: Point } => k.at != null && k.at.x > parent.x)
      .sort((a, b) => a.at.y - b.at.y || a.id.localeCompare(b.id));
    if (column.length === 0) continue;
    const columnX = column[0].at.x;
    const members = column.filter(k => Math.abs(k.at.x - columnX) <= TOOL_LANE_W);

    let spot = parent.y;
    for (let i = 0; i < members.length; i++) {
      const { id } = members[i];
      const at = placedAt(id)!;
      const dy = spot - at.y;
      if (-dy >= HOLE) {
        const group = subtree(id);
        const moving = new Set(group);
        // The siblings still to walk, and theirs, are below this one and rise
        // after it; they are not in its way.
        for (const later of members.slice(i + 1)) for (const d of subtree(later.id)) moving.add(d);
        const obstacles: Rect[] = [];
        for (const n of nodes) {
          if (moving.has(n.id)) continue;
          const p = where(n.id);
          if (!p) continue;
          const { w, h } = sizeOf(n.id);
          obstacles.push({ x: p.x, y: p.y, w, h, sid: sessionOf.get(n.id) ?? "_default" });
        }
        const clear = group.every(g => {
          const p = placedAt(g)!;
          const { w, h } = sizeOf(g);
          const sid = sessionOf.get(g) ?? "_default";
          const y = p.y + dy;
          return !obstacles.some(r => {
            const mx = r.sid === sid ? CARD_MARGIN : CROSS_SESSION_X;
            const my = r.sid === sid ? CARD_MARGIN : CROSS_SESSION_Y;
            return p.x < r.x + r.w + mx && r.x < p.x + w + mx && y < r.y + r.h + my && r.y < y + h + my;
          });
        });
        if (clear) {
          for (const g of group) {
            const p = placedAt(g)!;
            positions.set(g, { x: p.x, y: p.y + dy });
          }
          moved.add(sessionOf.get(id) ?? "_default");
        }
      }
      spot = placedAt(id)!.y + sizeOf(id).h + SIBLING_GAP;
    }
  }
  return [...moved];
}
