import { describe, expect, it } from "vitest";
import type { Node } from "reactflow";
import { joinSessions } from "../join-sessions";
import { CARD_MARGIN, NODE_W, SESSION_GAP } from "../layout-geometry";

type Point = { x: number; y: number };

function node(
  id: string,
  sessionId: string,
  parentId?: string,
  provider: "claude" | "codex" = "codex",
  kind: "root" | "subagent" = "root",
  position: Point = { x: 0, y: 0 },
): Node {
  return { id, position, data: { sessionId, parentId, provider, kind } } as Node;
}

const at = (nodes: Node[], id: string) => nodes.find(n => n.id === id)!.position;

describe("Codex child sessions join their immediate parent", () => {
  it("places a child session beside its positioned parent", () => {
    const laidOut = [node("parent", "parent-session"), node("child", "child-session", "parent", "codex", "subagent")];
    const parent = { x: 1200, y: 700 };
    const out = joinSessions(laidOut, new Map(), id => id === "parent" ? parent : undefined);
    expect(at(out, "child")).toEqual({ x: parent.x + NODE_W + CARD_MARGIN, y: parent.y });
    expect(at(laidOut, "child")).toEqual({ x: 0, y: 0 });
  });

  it("anchors a nested child to its immediate parent", () => {
    const laidOut = [
      node("root", "root-session"),
      node("child", "child-session", "root", "codex", "subagent"),
      node("grandchild", "grandchild-session", "child", "codex", "subagent"),
    ];
    const root = { x: 900, y: 300 };
    const out = joinSessions(laidOut, new Map(), id => id === "root" ? root : undefined);
    expect(at(out, "child")).toEqual({ x: root.x + NODE_W + CARD_MARGIN, y: root.y });
    expect(at(out, "grandchild")).toEqual({
      x: root.x + 2 * (NODE_W + CARD_MARGIN), y: root.y,
    });
  });

  it("leaves a child in the normal layout when its parent is missing", () => {
    const laidOut = [node("child", "child-session", "missing-parent", "codex", "subagent", { x: 400, y: 250 })];
    expect(joinSessions(laidOut, new Map(), () => undefined)).toEqual(laidOut);
  });

  it("uses the dragged parent's pinned position", () => {
    const parent = node("parent", "parent-session");
    const child = node("child", "child-session", "parent", "codex", "subagent");
    const pinned = new Map<string, Point>([["parent", { x: 1800, y: 400 }]]);
    const out = joinSessions([parent, child], pinned, () => undefined);
    expect(at(out, "child")).toEqual({ x: 1800 + NODE_W + CARD_MARGIN, y: 400 });
    expect(at(out, "parent")).toEqual({ x: 0, y: 0 });
  });

  it("keeps Claude's same-session placement and unrelated cross-session placement", () => {
    const laidOut = [
      node("claude-parent", "claude-session"),
      node("claude-child", "claude-session", "claude-parent", "claude", "subagent", { x: 300, y: 0 }),
      node("unrelated", "other-session", undefined, "codex", "root", { x: 700, y: 500 }),
      node("other-child", "other-child-session", "unrelated", "claude", "subagent", { x: 1100, y: 500 }),
    ];
    const parent = { x: 1000, y: 200 };
    const out = joinSessions(laidOut, new Map(), id => id === "claude-parent" ? parent : undefined);
    expect(at(out, "claude-child").x).toBeGreaterThan(parent.x);
    expect(at(out, "claude-child").y).toBe(parent.y);
    expect(at(out, "other-child")).toEqual({ x: 1100, y: 500 });
  });

  it("spaces separate child sessions that share a parent", () => {
    const laidOut = [
      node("parent", "parent-session"),
      node("child-a", "child-a-session", "parent", "codex", "subagent"),
      node("child-b", "child-b-session", "parent", "codex", "subagent"),
    ];
    const parent = { x: 500, y: 100 };
    const out = joinSessions(laidOut, new Map(), id => id === "parent" ? parent : undefined);
    expect(at(out, "child-a").y).toBe(parent.y);
    expect(at(out, "child-b").y - at(out, "child-a").y).toBe(SESSION_GAP);
  });
});
