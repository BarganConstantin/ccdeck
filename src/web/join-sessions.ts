// A card joining a session already on the canvas goes beside that session as
// it sits now — not where a layout from scratch would put the session.
import type { Node } from "reactflow";
import { CARD_MARGIN, groupBySession, NODE_W, SESSION_GAP, TOOL_LANE_W, sessionOfNode } from "./layout-geometry";

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
  const anchors = groupBySession(laidOut, n => !pinned.has(n.id) && placedAt(n.id) != null);
  for (const members of anchors.values()) members.sort((a, b) => a.id.localeCompare(b.id));

  const joined = laidOut.map(n => {
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

  // Codex child sessions can arrive as roots of their own sessions. In that
  // case the normal session anchor above cannot see the immediate parent, so
  // place that child session beside the parent's real position. Keep this
  // limited to Codex subagents: Claude's subagents remain in their existing
  // session and continue through the normal path above.
  const byId = new Map(joined.map(n => [n.id, n]));
  const anchored = new Set<string>();
  const pending = joined.filter(n => {
    const data = n.data as { provider?: string; kind?: string; parentId?: string } | undefined;
    const parent = data?.parentId ? byId.get(data.parentId) : undefined;
    return data?.provider === "codex" && data.kind === "subagent" && parent != null &&
      sessionOfNode(parent) !== sessionOfNode(n) && !pinned.has(n.id) && !placedAt(n.id);
  });
  pending.sort((a, b) => a.id.localeCompare(b.id));
  for (let pass = 0; pending.length > 0 && pass <= joined.length; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const id = pending[i].id;
      const n = byId.get(id)!;
      const data = n.data as { parentId?: string } | undefined;
      const parentId = data?.parentId;
      const parent = parentId && byId.get(parentId);
      if (!parentId || !parent) { pending.splice(i, 1); continue; }
      const parentPosition = pinned.get(parentId) ?? placedAt(parentId) ??
        (anchored.has(parentId) ? parent.position : undefined);
      if (!parentPosition) continue;

      const parentData = parent.data as { tools?: unknown[] } | undefined;
      const parentWidth = parent.width ?? NODE_W;
      const parentLane = parentData?.tools?.length ? TOOL_LANE_W : 0;

      const siblingIds = joined.filter(sibling => {
        const siblingData = sibling.data as { provider?: string; kind?: string; parentId?: string } | undefined;
        const siblingParent = siblingData?.parentId ? byId.get(siblingData.parentId) : undefined;
        return siblingData?.provider === "codex" && siblingData.kind === "subagent" &&
          siblingData.parentId === parentId && siblingParent != null &&
          sessionOfNode(siblingParent) !== sessionOfNode(sibling);
      }).map(sibling => sibling.id).sort((a, b) => a.localeCompare(b));
      const row = siblingIds.indexOf(id);
      const target = {
        x: parentPosition.x + parentWidth + parentLane + CARD_MARGIN,
        y: parentPosition.y + Math.max(0, row) * SESSION_GAP,
      };
      const dx = target.x - n.position.x;
      const dy = target.y - n.position.y;
      const sid = sessionOfNode(n);
      for (let j = 0; j < joined.length; j++) {
        const member = joined[j];
        if (sessionOfNode(member) !== sid || pinned.has(member.id) || placedAt(member.id)) continue;
        const moved = { ...member, position: { x: member.position.x + dx, y: member.position.y + dy } };
        joined[j] = moved;
        byId.set(member.id, moved);
        anchored.add(member.id);
      }
      pending.splice(i, 1);
    }
  }
  return joined;
}
