import { describe, expect, it } from "vitest";
import type { Node } from "reactflow";
import { clusterBounds } from "../cluster-bounds";
import { sessionGroupNodes } from "../session-group-nodes";
import { snapshotVisualFamily, translateFamilySnapshot } from "../use-node-drag";
import type { AgentNodeData } from "../types";

function card(id: string, sessionId: string, x: number, provider: "claude" | "codex", kind: "root" | "subagent", parentId?: string): Node {
  const data = {
    id, sessionId, provider, kind, parentId, label: kind === "root" ? "workspace" : "Explore",
    state: "active", startedAt: 1, tools: [], prompts: [], toolCount: 0, childCount: 0,
  } as AgentNodeData;
  return { id, type: "agent", position: { x, y: 0 }, width: 240, height: 130, data };
}

describe("visual family wrappers", () => {
  it("wraps a Codex root and linked children once, with the real root as operation identity", () => {
    const root = card("codex-root", "codex-root-session", 0, "codex", "root");
    const child = card("codex-child", "codex-child-session", 300, "codex", "subagent", "codex-root");
    const grandchild = card("codex-grandchild", "codex-grandchild-session", 600, "codex", "subagent", "codex-child");
    const claudeRoot = card("claude-root", "claude-session", 1200, "claude", "root");
    const claudeChild = card("claude-child", "claude-session", 1500, "claude", "subagent", "claude-root");
    const otherClaude = card("other-claude", "other-session", 1800, "claude", "root");
    const nodes = [root, child, grandchild, claudeRoot, claudeChild, otherClaude];

    const clusters = clusterBounds(nodes);
    const codex = clusters.find(c => c.rootId === "codex-root");
    expect(codex).toMatchObject({ familyKey: "codex-family:codex-root", rootId: "codex-root", sessionId: "codex-root", label: "workspace" });
    expect(codex?.x).toBeLessThan(root.position.x);
    expect(codex?.x + codex?.w!).toBeGreaterThan(grandchild.position.x);
    expect(clusters).toHaveLength(3);

    const groups = sessionGroupNodes(nodes);
    const group = groups.find(n => (n.data as { rootId?: string }).rootId === "codex-root");
    expect(group?.id).toBe("group:codex-root");
    expect((group?.data as { sessionId?: string }).sessionId).toBe("codex-root");
    const snapshot = snapshotVisualFamily(nodes, "codex-family:codex-root");
    expect([...snapshot.keys()]).toEqual(["codex-root", "codex-child", "codex-grandchild"]);
    expect(translateFamilySnapshot(snapshot, 40, -25)).toEqual(new Map([
      ["codex-root", { x: 40, y: -25 }],
      ["codex-child", { x: 340, y: -25 }],
      ["codex-grandchild", { x: 640, y: -25 }],
    ]));

    // The underlying telemetry identity stays with each original agent.
    expect((child.data as AgentNodeData).sessionId).toBe("codex-child-session");
    expect((grandchild.data as AgentNodeData).sessionId).toBe("codex-grandchild-session");
  });

  it("keeps Claude's session wrapper stable and separate from other sessions", () => {
    const root = card("claude-root", "claude-session", 0, "claude", "root");
    const child = card("claude-child", "claude-session", 300, "claude", "subagent", "claude-root");
    const unrelated = card("unrelated", "unrelated-session", 900, "claude", "root");
    const groups = sessionGroupNodes([root, child, unrelated]);
    expect(groups.map(n => n.id)).toEqual(["group:claude-session", "group:unrelated-session"]);
    expect([...snapshotVisualFamily([root, child, unrelated], "session:claude-session").keys()]).toEqual(["claude-root", "claude-child"]);
  });
});
