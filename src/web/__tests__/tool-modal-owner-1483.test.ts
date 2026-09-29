// #1483: the tool modal opened another session's call when two calls shared an
// id.
//
// A tool_use_id is only unique within one session — Codex forwards the
// rollout's own call_id, and nothing keeps two sessions' ids apart. The modal
// was opened by the id alone, and the lookup behind it returned the first call
// on the board carrying it, so clicking beta's Write bubble showed alpha's Bash
// call, input and result included. It is opened by the agent and the id now.
//
// Plain node: the reducer driven directly, the way the server's pushEvent feeds
// it, and the lookup the modal's render calls.
import { describe, it, expect } from "vitest";
import { applyEvent, findToolOnBoard, initialState, type GraphState } from "../reducer";
import type { HookPayload } from "../types";

let seq = 0;
function send(state: GraphState, session: string, payload: HookPayload, receivedAt: number): GraphState {
  return applyEvent(state, { seq: ++seq, receivedAt, source: "hook", payload: { session_id: session, ...payload } });
}

/** The issue's steps: two sessions, one call each, one id between them. */
function board(): GraphState {
  seq = 0;
  let state = send(initialState(), "alpha", { hook_event_name: "SessionStart", cwd: "/a" }, 1_000);
  state = send(state, "beta", { hook_event_name: "SessionStart", cwd: "/b" }, 1_100);
  state = send(state, "alpha", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "ls" } }, 2_000);
  return send(state, "beta", { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "call_1", tool_input: { file_path: "/b/x" } }, 2_100);
}

describe("the tool modal shows the call that was clicked (#1483)", () => {
  it("really has two calls under one id, one per session", () => {
    const state = board();
    expect(state.agents.get("alpha")!.tools.map(t => [t.id, t.name])).toEqual([["call_1", "Bash"]]);
    expect(state.agents.get("beta")!.tools.map(t => [t.id, t.name])).toEqual([["call_1", "Write"]]);
  });

  it("finds each session's own call by its agent and its id", () => {
    const state = board();
    expect(findToolOnBoard(state.agents, "beta", "call_1")?.name).toBe("Write");
    expect(findToolOnBoard(state.agents, "alpha", "call_1")?.name).toBe("Bash");
  });

  it("finds nothing, rather than another session's call, once the agent is gone", () => {
    const state = board();
    state.agents.delete("beta");
    expect(findToolOnBoard(state.agents, "beta", "call_1")).toBeNull();
  });
});
