import { describe, expect, it } from "vitest";
import { runningSessionCount } from "../ambient-counts";
import type { AgentNodeData } from "../types";

function agent(
  id: string,
  sessionId: string,
  state: "active" | "done",
  options: Partial<Pick<AgentNodeData, "provider" | "kind" | "parentId">> = {},
): AgentNodeData {
  return {
    id,
    sessionId,
    state,
    kind: "root",
    label: id,
    startedAt: 0,
    tools: [],
    ...options,
  } as AgentNodeData;
}

describe("Codex child families in the ambient running count", () => {
  it("still counts a Claude root and its six children as one session", () => {
    const agents = [
      agent("claude", "claude-session", "active"),
      ...Array.from({ length: 6 }, (_, i) =>
        agent(`claude-child-${i}`, "claude-session", "active", { kind: "subagent", parentId: "claude" }),
      ),
    ];
    expect(runningSessionCount(agents)).toBe(1);
  });

  it("counts two independent Codex roots separately", () => {
    expect(runningSessionCount([
      agent("root-a", "session-a", "active", { provider: "codex" }),
      agent("root-b", "session-b", "active", { provider: "codex" }),
    ])).toBe(2);
  });

  it("counts an active child when its parent is done", () => {
    expect(runningSessionCount([
      agent("root", "root-session", "done", { provider: "codex" }),
      agent("child", "child-session", "active", { provider: "codex", kind: "subagent", parentId: "root" }),
    ])).toBe(1);
  });

  it("resolves nested children through their immediate parents", () => {
    expect(runningSessionCount([
      agent("root", "root-session", "done", { provider: "codex" }),
      agent("child", "child-session", "done", { provider: "codex", kind: "subagent", parentId: "root" }),
      agent("grandchild", "grandchild-session", "active", { provider: "codex", kind: "subagent", parentId: "child" }),
    ])).toBe(1);
  });

  it("keeps children with missing parents in separate safe buckets", () => {
    expect(runningSessionCount([
      agent("orphan-a", "same-session", "active", { provider: "codex", kind: "subagent", parentId: "missing" }),
      agent("orphan-b", "same-session", "active", { provider: "codex", kind: "subagent", parentId: "missing" }),
    ])).toBe(2);
  });

  it("does not merge members of a cyclic parent chain", () => {
    expect(runningSessionCount([
      agent("cycle-a", "same-session", "active", { provider: "codex", kind: "subagent", parentId: "cycle-b" }),
      agent("cycle-b", "same-session", "active", { provider: "codex", kind: "subagent", parentId: "cycle-a" }),
    ])).toBe(2);
  });
});
