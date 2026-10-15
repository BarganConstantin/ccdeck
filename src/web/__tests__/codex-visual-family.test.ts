import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import { autoLayout } from "../layout";
import { buildVisualFamilies, type VisualFamilyAgent } from "../visual-family";

function ref(
  id: string,
  sessionId: string,
  options: Partial<Pick<VisualFamilyAgent, "provider" | "kind" | "parentId">> = {},
): VisualFamilyAgent {
  return { id, sessionId, provider: "codex", kind: "root", ...options };
}

function card(agent: VisualFamilyAgent): Node {
  return {
    id: agent.id,
    type: "agent",
    position: { x: 0, y: 0 },
    width: 240,
    height: 130,
    data: agent,
  } as Node;
}

describe("visual family identity", () => {
  it("joins Codex descendants through their immediate parent to the actual root", () => {
    const families = buildVisualFamilies([
      ref("root", "root", { kind: "root" }),
      ref("child", "child-session", { kind: "subagent", parentId: "root" }),
      ref("grandchild", "grandchild-session", { kind: "subagent", parentId: "child" }),
    ]);
    expect(families.get("root")).toEqual({ familyKey: "codex-family:root", rootId: "root" });
    expect(families.get("child")).toEqual(families.get("root"));
    expect(families.get("grandchild")).toEqual(families.get("root"));
  });

  it("keeps Claude grouping by its existing sessionId", () => {
    const families = buildVisualFamilies([
      ref("claude-root", "claude-session", { provider: "claude", kind: "root" }),
      ref("claude-child", "claude-session", { provider: "claude", kind: "subagent", parentId: "claude-root" }),
    ]);
    expect(families.get("claude-root")).toEqual({ familyKey: "session:claude-session", rootId: "claude-session" });
    expect(families.get("claude-child")).toEqual(families.get("claude-root"));
  });

  it("isolates missing-parent and cyclic Codex nodes", () => {
    const families = buildVisualFamilies([
      ref("orphan-a", "same-session", { kind: "subagent", parentId: "missing" }),
      ref("orphan-b", "same-session", { kind: "subagent", parentId: "missing" }),
      ref("cycle-a", "cycle-session", { kind: "subagent", parentId: "cycle-b" }),
      ref("cycle-b", "cycle-session", { kind: "subagent", parentId: "cycle-a" }),
    ]);
    expect(new Set(["orphan-a", "orphan-b", "cycle-a", "cycle-b"].map(id => families.get(id)!.familyKey)).size).toBe(4);
  });
});

describe("Codex family auto layout", () => {
  it("lays out separate-session Codex descendants as one horizontal tree", () => {
    const agents = [
      ref("root", "root-session"),
      ref("child", "child-session", { kind: "subagent", parentId: "root" }),
      ref("grandchild", "grandchild-session", { kind: "subagent", parentId: "child" }),
    ];
    const nodes = agents.map(card);
    const edges: Edge[] = [
      { id: "root-child", source: "root", target: "child" },
      { id: "child-grandchild", source: "child", target: "grandchild" },
    ];
    const out = autoLayout(nodes, edges, {
      direction: "LR",
      measured: new Map(nodes.map(n => [n.id, { width: 240, height: 130 }])),
      availableWidth: 1600,
      availableHeight: 900,
    });
    const x = new Map(out.map(n => [n.id, n.position.x]));
    expect(x.get("child")).toBeGreaterThan(x.get("root")!);
    expect(x.get("grandchild")).toBeGreaterThan(x.get("child")!);
  });

  it("keeps separate Codex roots in distinct visual families", () => {
    const families = buildVisualFamilies([
      ref("root-a", "session-a"),
      ref("root-b", "session-b"),
    ]);
    expect(families.get("root-a")?.familyKey).not.toBe(families.get("root-b")?.familyKey);
  });
});
