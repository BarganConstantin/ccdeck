import { describe, expect, it } from "vitest";
import type { Node } from "reactflow";
import { fillGapsWithNewSessions } from "../fill-gaps";
import { joinSessions } from "../join-sessions";
import { separateOverlaps } from "../separate-overlaps";
import { CARD_MARGIN, NODE_W, TOOL_LANE_W } from "../layout-geometry";

type Point = { x: number; y: number };
function card(id: string, sessionId: string, kind: "root" | "subagent", parentId?: string): Node {
  return {
    id, type: "agent", position: { x: 0, y: 0 }, width: NODE_W, height: 130,
    data: { id, sessionId, provider: "codex", kind, parentId },
  } as Node;
}
function recapNote(id: string, sessionId: string, parentId: string): Node {
  return { id, type: "recapNote", position: { x: 0, y: 0 }, data: { sessionId, parentId } } as Node;
}

const sizes = (nodes: Node[]) => new Map(nodes.map(n => [n.id, { width: NODE_W, height: 130 }]));

describe("Codex family arrivals", () => {
  it("keeps a late child beside its already placed parent through both repair passes", () => {
    const nodes = [card("root", "root-session", "root"), card("child", "child-session", "subagent", "root")];
    const root: Point = { x: 900, y: 300 };
    const laidOut = joinSessions(nodes, new Map(), id => id === "root" ? root : undefined);
    const child = laidOut.find(n => n.id === "child")!.position;
    expect(child).toEqual({ x: root.x + NODE_W + CARD_MARGIN, y: root.y });

    const positions = new Map<string, Point>([["root", root], ["child", child]]);
    expect(fillGapsWithNewSessions(nodes, positions, new Map(), sizes(nodes), new Set(["child"]))).toEqual([]);
    expect(positions.get("root")).toEqual(root);
    expect(positions.get("child")).toEqual(child);
    expect(separateOverlaps(nodes, positions, new Map(), sizes(nodes))).toEqual([]);
    expect(positions.get("child")).toEqual(child);
  });

  it("keeps a late child clear of its parent's active tool lane", () => {
    const rootNode = card("root", "root-session", "root");
    (rootNode.data as { tools?: unknown[] }).tools = [{}];
    const childNode = card("child", "child-session", "subagent", "root");
    const nodes = [rootNode, childNode];
    const root: Point = { x: 900, y: 300 };
    const lanes = new Map([["root", 1]]);
    const laidOut = joinSessions(nodes, new Map(), id => id === "root" ? root : undefined);
    const child = laidOut.find(n => n.id === "child")!.position;
    expect(child).toEqual({ x: root.x + NODE_W + TOOL_LANE_W + CARD_MARGIN, y: root.y });

    const positions = new Map<string, Point>([["root", root], ["child", child]]);
    expect(fillGapsWithNewSessions(nodes, positions, new Map(), sizes(nodes), new Set(["child"]), lanes)).toEqual([]);
    expect(separateOverlaps(nodes, positions, new Map(), sizes(nodes), lanes)).toEqual([]);
    expect(positions.get("child")).toEqual(child);
  });

  it("moves a root and its child together when the whole Codex family arrives", () => {
    const nodes = [
      card("arriving-root", "root-session", "root"),
      card("arriving-child", "child-session", "subagent", "arriving-root"),
      card("settled", "settled-session", "root"),
    ];
    const positions = new Map<string, Point>([
      ["arriving-root", { x: 0, y: 500 }],
      ["arriving-child", { x: 300, y: 500 }],
      ["settled", { x: 0, y: 0 }],
    ]);
    const beforeDelta = positions.get("arriving-child")!.x - positions.get("arriving-root")!.x;
    const moved = fillGapsWithNewSessions(
      nodes, positions, new Map(), sizes(nodes), new Set(["arriving-root", "arriving-child"]),
    );
    expect(moved).toEqual(["root-session"]);
    expect(positions.get("arriving-child")!.x - positions.get("arriving-root")!.x).toBe(beforeDelta);
    expect(positions.get("settled")).toEqual({ x: 0, y: 0 });
  });

  it.each([
    ["Codex", "codex", "root-session", "child-session"],
    ["Claude", "claude", "claude-session", "claude-session"],
  ] as const)("keeps a family with a pinned recap note settled (%s)", (_label, provider, rootSession, childSession) => {
    const root = card("root", rootSession, "root");
    const child = card("child", childSession, "subagent", "root");
    for (const node of [root, child]) (node.data as { provider?: string }).provider = provider;
    const note = recapNote("note", rootSession, "root");
    const nodes = [root, child, note, card("settled", "settled-session", "root")];
    const initial: Record<string, Point> = {
      root: { x: 0, y: 500 }, child: { x: 300, y: 500 },
      note: { x: 1600, y: 500 }, settled: { x: 0, y: 0 },
    };
    const positions = new Map(Object.entries(initial));
    const pinned = new Map<string, Point>([["note", initial.note]]);

    expect(fillGapsWithNewSessions(nodes, positions, pinned, sizes(nodes), new Set(["root", "child"]))).toEqual([]);
    expect(Object.fromEntries(positions)).toEqual(initial);
  });
});
