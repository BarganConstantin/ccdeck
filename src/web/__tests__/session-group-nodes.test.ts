// The invisible handle behind each session's cards, which is what a drag on the
// empty canvas inside a session box grabs. What it covers decides what a press
// there does: the cards plus GROUP_PAD, never the label strip above them (the
// label is SessionClusters' fit-view control and has to stay hittable).
import { describe, it, expect } from "vitest";
import type { Node } from "reactflow";
import { SESSION_GROUP_TYPE } from "../minimap";
import { GROUP_PAD, sessionGroupNodes } from "../session-group-nodes";
import type { AgentNodeData } from "../types";

const card = (id: string, sessionId: string, x: number, y: number, extra: Partial<Node> = {}, data: Partial<AgentNodeData> = {}): Node =>
  ({ id, position: { x, y }, width: 240, height: 130, data: { sessionId, ...data } as AgentNodeData, ...extra });

describe("sessionGroupNodes", () => {
  it("builds one handle per session, over its cards plus GROUP_PAD", () => {
    const out = sessionGroupNodes([card("a", "s1", 100, 100), card("b", "s1", 500, 260), card("c", "s2", 0, 900)]);
    expect(out.map(n => n.id)).toEqual(["group:s1", "group:s2"]);
    const [h] = out;
    expect(h.type).toBe(SESSION_GROUP_TYPE);
    expect(h.position).toEqual({ x: 100 - GROUP_PAD, y: 100 - GROUP_PAD });
    expect(h.width).toBe(500 + 240 - 100 + GROUP_PAD * 2);
    expect(h.height).toBe(260 + 130 - 100 + GROUP_PAD * 2);
    // Sized in explicit pixels, because a 100% child collapses under React
    // Flow's content sizing; the node component reads w and h from its data.
    expect(h.style).toEqual({ width: h.width, height: h.height });
    expect(h.data).toEqual({ sessionId: "s1", w: h.width, h: h.height });
  });

  it("sits behind the cards and is only ever dragged", () => {
    const [h] = sessionGroupNodes([card("a", "s1", 0, 0)]);
    expect(h.zIndex).toBe(-1);
    expect(h).toMatchObject({ draggable: true, selectable: false, focusable: false, deletable: false, connectable: false });
  });

  it("skips a card React Flow has not measured yet, for this frame", () => {
    expect(sessionGroupNodes([card("a", "s1", 0, 0, { width: undefined })])).toEqual([]);
    const [h] = sessionGroupNodes([card("a", "s1", 0, 0), card("b", "s1", 900, 900, { height: null as unknown as number })]);
    expect(h.width).toBe(240 + GROUP_PAD * 2);
  });

  it("leaves out retiring cards and nodes with no session", () => {
    const retiring = card("a", "s1", 900, 900, {}, { exitAt: 1 });
    const [h] = sessionGroupNodes([card("b", "s1", 0, 0), retiring, card("c", "", 50, 50)]);
    expect(h.width).toBe(240 + GROUP_PAD * 2);
    expect(sessionGroupNodes([retiring])).toEqual([]);
  });
});
