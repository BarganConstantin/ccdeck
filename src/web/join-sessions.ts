// A card joining a session already on the canvas goes beside that session as
// it sits now — not where a layout from scratch would put the session.
import type { Node } from "reactflow";
import { sessionOfNode } from "./layout-geometry";

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
 * `placedAt` answers for cards that already have a real position. Returns
 * `laidOut` with the unplaced cards of those sessions shifted.
 */
export function joinSessions(
  laidOut: Node[],
  pinned: Map<string, { x: number; y: number }>,
  placedAt: (id: string) => { x: number; y: number } | undefined,
): Node[] {
  const anchors = new Map<string, Node[]>();
  for (const n of laidOut) {
    if (pinned.has(n.id) || !placedAt(n.id)) continue;
    const sid = sessionOfNode(n);
    (anchors.get(sid) ?? anchors.set(sid, []).get(sid)!).push(n);
  }
  if (anchors.size === 0) return laidOut;
  for (const members of anchors.values()) members.sort((a, b) => a.id.localeCompare(b.id));

  return laidOut.map(n => {
    if (pinned.has(n.id) || placedAt(n.id)) return n;
    const members = anchors.get(sessionOfNode(n));
    if (!members) return n;
    const parentId = (n.data as { parentId?: string } | undefined)?.parentId;
    const anchor = members.find(m => m.id === parentId) ?? members[0];
    const real = placedAt(anchor.id)!;
    return {
      ...n,
      position: {
        x: n.position.x + real.x - anchor.position.x,
        y: n.position.y + real.y - anchor.position.y,
      },
    };
  });
}
