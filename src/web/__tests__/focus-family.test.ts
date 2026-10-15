import { describe, expect, it } from "vitest";
import { focusFamilyBoxes, focusViewport, type FocusFlowNode } from "../focus-camera";
import type { AgentNodeData } from "../types";

function agent(id: string, provider: "codex" | "claude", kind: "root" | "subagent", sessionId: string, parentId?: string): AgentNodeData {
  return { id, provider, kind, sessionId, parentId, label: id, state: "active", startedAt: 1, tools: [], prompts: [], toolCount: 0, childCount: 0 } as AgentNodeData;
}

function node(id: string, x: number, type: "agent" | "recapNote" = "agent", parentId?: string): FocusFlowNode {
  return { id, type, position: { x, y: 100 }, data: parentId ? { parentId } : undefined };
}

const sizes = (nodes: FocusFlowNode[]) => new Map(nodes.map(n => [n.id, { width: 240, height: 130 }]));

describe("family focus context", () => {
  it("frames a Codex root with children on their own sessionIds and keeps the requested card as anchor", () => {
    const agents = [
      agent("root", "codex", "root", "root-session"),
      agent("child", "codex", "subagent", "child-session", "root"),
      agent("grandchild", "codex", "subagent", "grandchild-session", "child"),
      agent("other-root", "codex", "root", "other-session"),
    ];
    const nodes = [node("root", 0), node("child", 380), node("grandchild", 760), node("other-root", 1400)];
    const boxes = focusFamilyBoxes("root", agents, nodes, sizes(nodes), new Set(["child"]), 220);
    expect(boxes).toEqual({
      anchor: { x: 0, y: 100, width: 240, height: 130 },
      context: { x: 0, y: 100, width: 1000, height: 130 },
    });
    expect(focusFamilyBoxes("child", agents, nodes, sizes(nodes), new Set(["child"]), 220)).toEqual({
      anchor: { x: 380, y: 100, width: 240, height: 130 },
      context: boxes!.context,
    });
    const view = focusViewport({
      pane: { width: 1080, height: 800 },
      insets: { top: 56, right: 32, bottom: 32, left: 72 },
      context: boxes!.context,
      anchor: boxes!.anchor,
    });
    const rightEdge = (boxes!.context.x + boxes!.context.width) * view.zoom + view.x;
    expect(rightEdge).toBeLessThanOrEqual(1080 - 32);
  });

  it("keeps Claude's existing same-session focus grouping", () => {
    const agents = [agent("claude-root", "claude", "root", "claude-session"), agent("claude-child", "claude", "subagent", "claude-session", "claude-root")];
    const nodes = [node("claude-root", 0), node("claude-child", 420)];
    expect(focusFamilyBoxes("claude-root", agents, nodes, sizes(nodes), new Set(), 220)).toMatchObject({
      anchor: { x: 0, width: 240 },
      context: { x: 0, width: 660 },
    });
  });

  it("isolates children with missing parents and cyclic ancestry", () => {
    const agents = [
      agent("root", "codex", "root", "root-session"),
      agent("orphan", "codex", "subagent", "orphan-session", "missing"),
      agent("cycle-a", "codex", "subagent", "cycle-a-session", "cycle-b"),
      agent("cycle-b", "codex", "subagent", "cycle-b-session", "cycle-a"),
    ];
    const nodes = [node("root", 0), node("orphan", 400), node("cycle-a", 800), node("cycle-b", 1200)];
    const measured = sizes(nodes);
    expect(focusFamilyBoxes("root", agents, nodes, measured, new Set(), 220)?.context.width).toBe(240);
    expect(focusFamilyBoxes("orphan", agents, nodes, measured, new Set(), 220)?.context.x).toBe(400);
    expect(focusFamilyBoxes("cycle-a", agents, nodes, measured, new Set(), 220)?.context.width).toBe(240);
  });
});
