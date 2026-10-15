import { describe, expect, it } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  const env: HookEnvelope = {
    seq: ++seq,
    receivedAt: at,
    source: "test",
    payload,
  };
  return applyEvent(state, env);
}

function spawn(child: string, parent: string, extra: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: "CodexSubagentStart",
    session_id: child,
    parent_session_id: parent,
    runtime: "codex",
    provider: "codex",
    ...extra,
  };
}

describe("Codex subagent spawn and rollout records share one node", () => {
  it("creates a child-id node and a parent edge from the spawn metadata", () => {
    seq = 0;
    const state = send(initialState(), T0, spawn("child-a", "root-a", {
      agent_type: "explorer",
      agent_nickname: "Dewey",
      agent_role: "luna-worker",
      model: "gpt-6-luna",
    }));

    const root = state.agents.get("root-a")!;
    const child = state.agents.get("child-a")!;
    expect(state.agents.size).toBe(2);
    expect(root).toMatchObject({ id: "root-a", kind: "root", provider: "codex", synthetic: true, childCount: 1 });
    expect(child).toMatchObject({
      id: "child-a", sessionId: "child-a", parentId: "root-a", kind: "subagent",
      provider: "codex", state: "active", label: "Dewey", agentType: "explorer",
      agentNickname: "Dewey", agentRole: "luna-worker", model: "gpt-6-luna",
    });
  });

  it("upgrades a child-first SessionStart node in place and settles its tool call", () => {
    seq = 0;
    let state = send(initialState(), T0, {
      hook_event_name: "SessionStart", session_id: "child-b", provider: "codex", cwd: "/repo",
    });
    state = send(state, T0 + 1, {
      hook_event_name: "PreToolUse", session_id: "child-b", provider: "codex",
      tool_name: "Read", tool_use_id: "call-1",
    });
    const childBefore = state.agents.get("child-b")!;

    state = send(state, T0 + 2, spawn("child-b", "root-b", { agent_type: "reviewer" }));
    expect(state.agents.get("child-b")).toBe(childBefore);
    expect(state.agents.get("child-b")).toMatchObject({
      id: "child-b", sessionId: "child-b", parentId: "root-b", kind: "subagent",
      provider: "codex", label: "reviewer",
    });
    expect(state.agents.get("root-b")?.childCount).toBe(1);

    state = send(state, T0 + 3, {
      hook_event_name: "PostToolUse", session_id: "child-b", provider: "codex",
      tool_use_id: "call-1", tool_response: "read complete",
    });
    expect(state.agents.get("child-b")?.tools).toMatchObject([
      { id: "call-1", name: "Read", endedAt: T0 + 3, ok: true },
    ]);
  });

  it("replay-deduplicates parent count and does not revive a completed child", () => {
    seq = 0;
    let state = send(initialState(), T0, spawn("child-c", "root-c"));
    state = send(state, T0 + 1, { hook_event_name: "Stop", session_id: "child-c", provider: "codex" });
    const endedAt = state.agents.get("child-c")?.endedAt;
    state = send(state, T0 + 2, spawn("child-c", "root-c", { agent_nickname: "late replay" }));

    expect(state.agents.get("root-c")?.childCount).toBe(1);
    expect(state.agents.get("child-c")).toMatchObject({ state: "done", endedAt, label: "late replay" });
  });

  it("supports nested immediate parents and rejects self and cyclic relations", () => {
    seq = 0;
    let state = send(initialState(), T0, spawn("child-d", "root-d"));
    state = send(state, T0 + 1, spawn("grandchild-d", "child-d"));
    expect(state.agents.get("grandchild-d")).toMatchObject({
      id: "grandchild-d", sessionId: "grandchild-d", parentId: "child-d", kind: "subagent",
    });
    expect(state.agents.get("child-d")?.childCount).toBe(1);

    state = send(state, T0 + 2, spawn("self-d", "self-d"));
    state = send(state, T0 + 3, spawn("root-d", "grandchild-d"));
    expect(state.agents.has("self-d")).toBe(false);
    expect(state.agents.get("root-d")?.parentId).toBeUndefined();
    for (const a of state.agents.values()) {
      const visited = new Set<string>([a.id]);
      let parent = a.parentId;
      while (parent) {
        expect(visited.has(parent)).toBe(false);
        visited.add(parent);
        parent = state.agents.get(parent)?.parentId;
      }
    }
  });

  it("adopts model enrichment that arrived before the child spawn record", () => {
    seq = 0;
    let state = send(initialState(), T0, {
      hook_event_name: "ModelObserved", session_id: "child-e", provider: "codex", model: "gpt-6-luna",
    });
    expect(state.agents.has("child-e")).toBe(false);
    state = send(state, T0 + 1, spawn("child-e", "root-e"));
    expect(state.agents.get("child-e")?.model).toBe("gpt-6-luna");
  });

  it("keeps ordinary Codex roots and Claude subagent handling unchanged", () => {
    seq = 0;
    let state = send(initialState(), T0, {
      hook_event_name: "SessionStart", session_id: "ordinary-codex", provider: "codex",
    });
    state = send(state, T0 + 1, {
      hook_event_name: "PreToolUse", session_id: "ordinary-codex", provider: "codex",
      tool_name: "Read", tool_use_id: "call-2",
    });
    expect([...state.agents.values()].map(a => a.id)).toEqual(["ordinary-codex"]);
    expect(state.agents.get("ordinary-codex")?.tools).toHaveLength(1);

    state = send(state, T0 + 2, {
      hook_event_name: "SessionStart", session_id: "claude-root", provider: "claude",
    });
    state = send(state, T0 + 3, {
      hook_event_name: "SubagentStart", session_id: "claude-root", provider: "claude",
      agent_id: "claude-agent", agent_type: "Explore",
    });
    expect(state.agents.get("claude-root::claude-agent")).toMatchObject({
      sessionId: "claude-root", parentId: "claude-root", kind: "subagent",
    });
    expect(state.agents.get("claude-root")?.childCount).toBe(1);
  });
});
