// A subagent card says what it is for: the description on the Task or Agent
// call that started it ("Find every public route"), as V4's Agent / Card draws
// it, rather than "subagent · web-api".
//
// `SubagentStart` names the subagent and its type, never the call that started
// it, so the reducer pairs the two when the subagent announces itself: the
// payload's `parent_tool_use_id` when it has one, otherwise the oldest Task or
// Agent call of the session still running that no sibling has taken, of the
// same type when the call names one. These pin that pairing, and that a
// subagent with no call to pair keeps today's line.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
let seq = 0;

function send(state: GraphState, payload: HookPayload): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: T0 + seq * 10, source: "hook", payload: { session_id: "s1", cwd: "/repo/web-api", ...payload } };
  return applyEvent(state, env);
}

function session(): GraphState {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart" });
  return send(state, { hook_event_name: "UserPromptSubmit", prompt: "Add rate limiting to the public API" });
}

const spawn = (id: string, description: string | undefined, type = "Explore", name = "Agent"): HookPayload => ({
  hook_event_name: "PreToolUse", tool_name: name, tool_use_id: id,
  tool_input: { ...(description === undefined ? {} : { description }), prompt: "…", subagent_type: type },
});

describe("a subagent takes the description of the call that started it", () => {
  it("pairs a Start with the running Agent call before it", () => {
    let state = send(session(), spawn("toolu_1", "Find every public route"));
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(state.agents.get("s1::a1")!.spawnCall).toEqual({ id: "toolu_1", description: "Find every public route" });
  });

  it("pairs the older Task call too, by the name Claude Code used before Agent", () => {
    let state = send(session(), spawn("toolu_1", "Read the job's config", "general-purpose", "Task"));
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "general-purpose" });
    expect(state.agents.get("s1::a1")!.spawnCall?.description).toBe("Read the job's config");
  });

  it("takes the call the payload names when it names one", () => {
    let state = send(session(), spawn("toolu_1", "First"));
    state = send(state, spawn("toolu_2", "Second"));
    state = send(state, { hook_event_name: "SubagentStart", parent_tool_use_id: "toolu_2", agent_type: "Explore" });
    expect(state.agents.get("s1::toolu_2")!.spawnCall?.description).toBe("Second");
  });

  it("hands calls made side by side to their subagents in the order they were made", () => {
    let state = send(session(), spawn("toolu_1", "Check row counts per day", "general-purpose"));
    state = send(state, spawn("toolu_2", "Bump versions and the changelog", "general-purpose"));
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "general-purpose" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "general-purpose" });
    expect(state.agents.get("s1::a1")!.spawnCall?.description).toBe("Check row counts per day");
    expect(state.agents.get("s1::a2")!.spawnCall?.description).toBe("Bump versions and the changelog");
  });

  it("matches the type the call asked for when two kinds start together", () => {
    let state = send(session(), spawn("toolu_1", "Update the store screenshots", "general-purpose"));
    state = send(state, spawn("toolu_2", "Find every public route", "Explore"));
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(state.agents.get("s1::a1")!.spawnCall?.description).toBe("Find every public route");
  });

  it("skips a call that already ended, and keeps the pairing a re-delivered Start finds", () => {
    let state = send(session(), spawn("toolu_1", "Done already"));
    state = send(state, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_1", tool_input: {}, tool_response: {} });
    state = send(state, spawn("toolu_2", "Still going"));
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(state.agents.get("s1::a1")!.spawnCall?.description).toBe("Still going");
    state = send(state, spawn("toolu_3", "Another one"));
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(state.agents.get("s1::a1")!.spawnCall?.description).toBe("Still going");
  });

  it("leaves a subagent with no call to pair without one, and a call with no description without words", () => {
    let state = send(session(), { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(state.agents.get("s1::a1")!.spawnCall).toBeUndefined();
    state = send(state, spawn("toolu_9", undefined));
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "Explore" });
    expect(state.agents.get("s1::a2")!.spawnCall).toEqual({ id: "toolu_9" });
  });
});
