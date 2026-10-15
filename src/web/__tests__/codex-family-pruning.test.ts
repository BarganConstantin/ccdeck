import { describe, expect, it } from "vitest";
import { applyEvent, initialState, pruneDoneSessions, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const NOW = 10_000_000;
let sequence = 0;
function event(payload: HookPayload, receivedAt: number): HookEnvelope {
  return { seq: ++sequence, receivedAt, source: "hook", payload };
}

function build(specs: Array<{ id: string; endedAt?: number }>): GraphState {
  sequence = 0;
  let state = initialState();
  for (const spec of specs) {
    state = applyEvent(state, event({ hook_event_name: "SessionStart", session_id: spec.id, cwd: "/repo" }, 1));
    if (spec.endedAt != null) state = applyEvent(state, event({ hook_event_name: "Stop", session_id: spec.id }, spec.endedAt));
  }
  return state;
}

describe("Codex parent-linked session pruning", () => {
  it("keeps a finished parent while its child is live", () => {
    const state = build([{ id: "parent", endedAt: NOW - 100_000 }, { id: "child" }]);
    state.agents.get("child")!.parentId = "parent";
    expect(pruneDoneSessions(state, NOW, 0, 1_000)).toBe(false);
    expect([...state.agents.keys()]).toEqual(["parent", "child"]);
  });

  it("keeps a child that is still inside its grace period", () => {
    const state = build([{ id: "parent", endedAt: NOW - 100_000 }, { id: "child", endedAt: NOW - 500 }]);
    state.agents.get("child")!.parentId = "parent";
    expect(pruneDoneSessions(state, NOW, 0, 1_000)).toBe(false);
    expect(state.agents.size).toBe(2);
  });

  it("removes a fully expired nested family and forgets each session once", () => {
    const state = build([
      { id: "parent", endedAt: NOW - 30_000 },
      { id: "child", endedAt: NOW - 20_000 },
      { id: "grandchild", endedAt: NOW - 10_000 },
    ]);
    state.agents.get("child")!.parentId = "parent";
    state.agents.get("grandchild")!.parentId = "child";
    const forgotten: string[] = [];
    expect(pruneDoneSessions(state, NOW, 0, 1_000, sid => forgotten.push(sid))).toBe(true);
    expect(state.agents.size).toBe(0);
    expect(forgotten.sort()).toEqual(["child", "grandchild", "parent"]);
  });

  it("handles missing parents and cycles without looping", () => {
    const state = build([
      { id: "orphan", endedAt: NOW - 20_000 },
      { id: "cycle-a", endedAt: NOW - 20_000 },
      { id: "cycle-b", endedAt: NOW - 10_000 },
    ]);
    state.agents.get("orphan")!.parentId = "not-present";
    state.agents.get("cycle-a")!.parentId = "cycle-b";
    state.agents.get("cycle-b")!.parentId = "cycle-a";
    const forgotten: string[] = [];
    expect(pruneDoneSessions(state, NOW, 0, 1_000, sid => forgotten.push(sid))).toBe(true);
    expect(state.agents.size).toBe(0);
    expect(forgotten.sort()).toEqual(["cycle-a", "cycle-b", "orphan"]);
  });
});
