// A card joining a session already on the canvas goes beside that session as
// it sits now — not where a layout from scratch would put the session.
import type { Node } from "reactflow";
import { groupBySession, NODE_H, sessionOfNode, SIBLING_GAP, TOOL_LANE_W } from "./layout-geometry";

type Point = { x: number; y: number };

/** The parent a card was spawned from, when it has one. */
const parentOf = (n: Node): string | undefined => (n.data as { parentId?: string } | undefined)?.parentId;

/**
 * Keep the cards a session gains beside that session, wherever it now sits.
 *
 * autoLayout places every card as if the whole board were being laid out from
 * scratch, and the caller keeps only the slots of cards that had none. For a
 * session already on the canvas that is the subagent it just spawned — and the
 * scratch slot is where the session WOULD sit, not where it does. The two part
 * as soon as anything moves a session: a gap it was dropped into, a push from a
 * neighbour that grew, a column count that changed with the canvas. The child
 * then landed wherever the scratch layout had its session, and the repair pass
 * slid it down until it cleared something — a live board had three subagents
 * strung out a screen below their parent, and to the left of it.
 *
 * So a new card moves by however far its session has: the offset between an
 * already-placed member's real position and its scratch one. That member is the
 * card's parent when the parent has a place, because the edge to it is what the
 * eye follows, and otherwise the lowest id, so the choice is stable. A pinned
 * card is never the anchor — dagre does not lay pins out, so a pin's scratch
 * position is the pin itself and says nothing about where the session went —
 * and is never moved.
 *
 * A SUBAGENT WHOSE PARENT ALREADY HAS SUBAGENTS ON THE CANVAS JOINS THEIR
 * COLUMN, under the lowest of them. The scratch slot cannot say where that is:
 * the scratch layout centres the parent on ALL its children, the new one
 * included, while the ones already placed keep the slots they were centred on
 * when there were fewer — so the new card's slot sat on top of a sibling and
 * the overlap pass slid it down by whatever cleared it. And the rank's x moves
 * as soon as one sibling gains bubbles, because dagre centres a rank on its
 * widest box. A parent that spawned five one after another drew its first
 * subagent level with it and the other four in a second column further right,
 * unevenly spaced — "Default layout for spawning new nodes make no sense". Under
 * the lowest sibling, at the pitch dagre spaces them by, a column grown one
 * spawn at a time looks like one laid out whole, and nothing already on the
 * canvas moves. Only siblings standing near the slot count: one the overlap
 * pass or a push carried off on its own is not the column.
 *
 * `placedAt` answers for cards that already have a real position. `boxOf` is
 * the ground a card covers, bubbles included (layout-geometry's `footprint`);
 * without it a card is NODE_H tall. Returns `laidOut` with the unplaced cards
 * of those sessions shifted.
 */
export function joinSessions(
  laidOut: Node[],
  pinned: Map<string, { x: number; y: number }>,
  placedAt: (id: string) => { x: number; y: number } | undefined,
  boxOf?: (id: string) => { w: number; h: number },
): Node[] {
  const anchors = groupBySession(laidOut, n => !pinned.has(n.id) && placedAt(n.id) != null);
  if (anchors.size === 0) return laidOut;
  for (const members of anchors.values()) members.sort((a, b) => a.id.localeCompare(b.id));

  const heightOf = (id: string) => boxOf?.(id).h ?? laidOut.find(n => n.id === id)?.height ?? NODE_H;
  const scratchOf = new Map(laidOut.map(n => [n.id, n.position]));
  // Where this pass put each card it moved, so a card placed after its parent
  // in the same frame follows where the parent went, and a second new sibling
  // goes under the first.
  const joined = new Map<string, Point>();
  const realOf = (id: string): Point | undefined => (pinned.has(id) ? undefined : joined.get(id) ?? placedAt(id));

  // Parents before children: the layout runs left to right, so a parent's
  // scratch slot is left of its children's. Siblings top to bottom, the order
  // the scratch layout already gave them.
  const unplaced = laidOut
    .filter(n => !pinned.has(n.id) && !placedAt(n.id) && anchors.has(sessionOfNode(n)))
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);

  for (const n of unplaced) {
    const sid = sessionOfNode(n);
    const parentId = parentOf(n);
    const parent = parentId ? realOf(parentId) : undefined;

    // Its siblings' column, when the parent has one beside it already.
    if (parentId && parent && n.type !== "recapNote") {
      const delta = { x: parent.x - scratchOf.get(parentId)!.x, y: parent.y - scratchOf.get(parentId)!.y };
      const slot = { x: n.position.x + delta.x, y: n.position.y + delta.y };
      let lowest: { at: Point; bottom: number } | null = null;
      for (const s of laidOut) {
        if (s.id === n.id || s.type === "recapNote" || parentOf(s) !== parentId || sessionOfNode(s) !== sid) continue;
        const at = realOf(s.id);
        if (!at || Math.abs(at.x - slot.x) > TOOL_LANE_W || at.x <= parent.x) continue;
        const bottom = at.y + heightOf(s.id);
        if (!lowest || bottom > lowest.bottom) lowest = { at, bottom };
      }
      if (lowest) {
        joined.set(n.id, { x: lowest.at.x, y: lowest.bottom + SIBLING_GAP });
        continue;
      }
    }

    const first = anchors.get(sid)![0].id;
    const real = parent ?? placedAt(first)!;
    const scratch = scratchOf.get(parent ? parentId! : first)!;
    joined.set(n.id, { x: n.position.x + real.x - scratch.x, y: n.position.y + real.y - scratch.y });
  }

  if (joined.size === 0) return laidOut;
  return laidOut.map(n => {
    const p = joined.get(n.id);
    return p ? { ...n, position: p } : n;
  });
}
