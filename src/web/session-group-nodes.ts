// Invisible per-session drag-handle nodes. One per session, sized to the
// bounding box of that session's agent nodes and rendered behind them
// (negative zIndex). Grabbing the empty canvas behind a session drags the
// whole session; the agent nodes stay on top and individually draggable.
//
// Moved out of App.tsx unchanged, so the suite can call what it used to copy:
// cluster-bounds.test.ts rebuilt this handle by hand to test the card that
// traces it.
import type { Node } from "reactflow";
import { SESSION_GROUP_TYPE } from "./minimap";
import { PAD } from "./session-chrome";
import { buildVisualFamilies } from "./visual-family";
import type { AgentNodeData } from "./types";

// Padding of the invisible session drag-handle node: the box's own PAD, from
// session-chrome.ts, so the handle lines up with the card's body (the card's
// header strip is left uncovered so its label stays clickable).
export const GROUP_PAD = PAD;

/** One handle per session with a measured, non-retiring card, covering those
 *  cards plus GROUP_PAD. A card React Flow has not measured yet is skipped for
 *  the frame rather than guessed at. */
export function sessionGroupNodes(nodes: Node[]): Node[] {
  const agents = nodes.flatMap(n => {
    const d = n.data as AgentNodeData | undefined;
    return (n.type === "agent" || n.type == null) && d?.sessionId ? [{ ...d, id: d.id || n.id }] : [];
  });
  const families = buildVisualFamilies(agents);
  const byFamily = new Map<string, { familyKey: string; rootId: string; sessionId: string; minX: number; minY: number; maxX: number; maxY: number }>();
  for (const n of nodes) {
    const d = n.data as AgentNodeData | undefined;
    if (!d?.sessionId || d.exitAt != null) continue;
    const familyId = n.type === "recapNote" && d.parentId ? d.parentId : (d.id || n.id);
    const family = families.get(familyId);
    if (!family) continue;
    const w = n.width, h = n.height;
    if (w == null || h == null) continue; // unmeasured — skip this frame
    const x1 = n.position.x, y1 = n.position.y, x2 = x1 + w, y2 = y1 + h;
    const b = byFamily.get(family.familyKey);
    if (!b) byFamily.set(family.familyKey, { familyKey: family.familyKey, rootId: family.rootId, sessionId: family.rootId, minX: x1, minY: y1, maxX: x2, maxY: y2 });
    else {
      b.minX = Math.min(b.minX, x1); b.minY = Math.min(b.minY, y1);
      b.maxX = Math.max(b.maxX, x2); b.maxY = Math.max(b.maxY, y2);
    }
  }
  const out: typeof nodes = [];
  for (const [, b] of byFamily) {
    // Cover the nodes + padding, but NOT the header strip above them — that
    // area holds SessionClusters' clickable label (fit-view), which must stay
    // hittable above this handle.
    const w = b.maxX - b.minX + GROUP_PAD * 2;
    const h = b.maxY - b.minY + GROUP_PAD * 2;
    out.push({
      id: `group:${b.rootId}`,
      type: SESSION_GROUP_TYPE,
      position: { x: b.minX - GROUP_PAD, y: b.minY - GROUP_PAD },
      // w/h handed to the node component so it can size itself in explicit
      // pixels (a 100% child would collapse under RF's content sizing).
      data: { sessionId: b.sessionId, familyKey: b.familyKey, rootId: b.rootId, w, h } as unknown as AgentNodeData,
      width: w,
      height: h,
      style: { width: w, height: h },
      zIndex: -1,
      draggable: true,
      selectable: false,
      focusable: false,
      deletable: false,
      connectable: false,
    });
  }
  return out;
}
