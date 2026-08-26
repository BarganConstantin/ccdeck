// #675: where a submitted prompt is RECORDED, as opposed to whether it is
// recorded twice — `userprompt-idempotent.test.ts` owns the second question and
// answers all seven of its cases against a session with no subagent live, which
// is exactly the shape in which this one cannot go wrong.
//
// `UserPromptSubmit` used to resolve its owner through `resolveOwner`, the
// active-subagent stack heuristic. That heuristic exists for a real problem —
// CC's tool-call hooks carry no `agent_id`, so an untagged PreToolUse has to be
// attributed to the deepest live subagent or a Task's work all lands on the
// session root — but a human prompt carries no `agent_id` for the opposite
// reason: a person types into a session, never into a subagent. Read through
// the stack, the turn the human typed went into `sub.prompts`, set
// `sub.firstPrompt` (which is what `SessionSummary` leads with), and never
// reached the root's own list; the same three lines forced that subagent back
// to `active` with `endedAt`/`exitAt` cleared, so typing could un-finish a node.
//
// The stack is non-empty at a prompt more often than it looks: a `SubagentStop`
// POST that never landed leaves its key behind, and a prompt can overtake its
// turn's `Stop` on the wire before `Stop` drops the stack.
//
// The last case here is the other half of the bargain — the tool-call
// attribution the stack was introduced for must still work, prompt or no
// prompt.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-owner";
const SUB = `${SESSION}::sub-1`;
const SUB2 = `${SESSION}::sub-2`;
const T0 = 1_700_000_000_000;

let seq = 0;

function send(state: GraphState, payload: HookPayload, at: number): GraphState {
  const env: HookEnvelope = {
    seq: ++seq,
    receivedAt: at,
    source: "hook",
    epoch: "boot-1",
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

function start(): GraphState {
  seq = 0;
  return send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
}

describe("UserPromptSubmit while a subagent is live", () => {
  it("records the turn on the session root, not on the Task that happens to be running", () => {
    let state = start();
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "first prompt" }, T0 + 20);
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" }, T0 + 30);
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "second prompt" }, T0 + 40);

    // The key really is on the stack — otherwise this case would be proving
    // nothing but that the fallback path works.
    expect(state.activeSubagentStack.get(SESSION)).toEqual(["sub-1"]);

    const root = state.agents.get(SESSION)!;
    expect(root.prompts.map(p => p.text)).toEqual(["first prompt", "second prompt"]);

    const sub = state.agents.get(SUB)!;
    expect(sub.prompts).toEqual([]);
    expect(sub.firstPrompt).toBeUndefined();
  });

  it("leads the session summary with the human's opening line even if it was typed under a subagent", () => {
    // `SessionSummary` reads `firstPrompt` off the first agent in map order
    // that has one, so a session whose opening turn was filed on a subagent
    // opened with the wrong sentence — and `firstPrompt` is written once and
    // never revised, so the next prompt could not repair it.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" }, T0 + 10);
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "rename the columns" }, T0 + 20);

    expect(state.agents.get(SESSION)!.firstPrompt).toBe("rename the columns");
    expect(state.agents.get(SUB)!.firstPrompt).toBeUndefined();
  });

  it("keeps the turn on the root with two subagents running in parallel", () => {
    // `resolveOwner` reads the stack TOP, so the deepest live subagent is the
    // one that used to collect the prompt. Both are still live here: neither
    // may take it.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" }, T0 + 10);
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-2" }, T0 + 11);
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "and also check the tests" }, T0 + 20);

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["sub-1", "sub-2"]);
    expect(state.agents.get(SESSION)!.prompts.map(p => p.text)).toEqual(["and also check the tests"]);
    expect(state.agents.get(SUB)!.prompts).toEqual([]);
    expect(state.agents.get(SUB2)!.prompts).toEqual([]);
  });

  it("does not un-finish a subagent whose key is still on the stack", () => {
    // The state below — settled node, key still on the stack — is what a lost
    // `SubagentStop` leaves behind, and it is reached here by hand because the
    // two guards that stand between it and a real deck are somewhere else
    // entirely: `pushActive` refuses a duplicate key, and `Stop` /
    // `sweepStaleSessions` drop the stack when they settle the nodes. This case
    // is about THIS branch holding on its own, so that a change to either guard
    // cannot quietly bring typing-resurrects-an-agent back.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" }, T0 + 10);
    const sub = state.agents.get(SUB)!;
    sub.state = "done";
    sub.endedAt = T0 + 20;

    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "next turn" }, T0 + 40);

    expect(sub.state).toBe("done");
    expect(sub.endedAt).toBe(T0 + 20);
    expect(sub.prompts).toEqual([]);
    // ...and the retirement loop at the top of the branch keeps its work: a
    // subagent that ended before this turn fades out rather than being
    // un-retired by the act of typing.
    expect(sub.exitAt).toBe(T0 + 40);
    expect(state.agents.get(SESSION)!.prompts.map(p => p.text)).toEqual(["next turn"]);
  });

  it("still stamps exitAt on a finished subagent while a sibling is live", () => {
    // The all-events path to the same picture: sub-1 keeps running, sub-2 is
    // over. The prompt belongs to the root, sub-2 retires, sub-1 is untouched.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" }, T0 + 10);
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-2" }, T0 + 11);
    state = send(state, { hook_event_name: "SubagentStop", agent_id: "sub-2" }, T0 + 20);
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "next turn" }, T0 + 40);

    const live = state.agents.get(SUB)!;
    expect(live.state).toBe("active");
    expect(live.endedAt).toBeUndefined();
    expect(live.exitAt).toBeUndefined();
    expect(live.prompts).toEqual([]);

    const finished = state.agents.get(SUB2)!;
    expect(finished.state).toBe("done");
    expect(finished.endedAt).toBe(T0 + 20);
    expect(finished.exitAt).toBe(T0 + 40);
    expect(finished.prompts).toEqual([]);

    expect(state.agents.get(SESSION)!.prompts.map(p => p.text)).toEqual(["next turn"]);
  });

  it("still reopens the root, and only the root, when a prompt follows a Stop", () => {
    // The prompt moved off `resolveOwner`; the reopen it performs must not move
    // with it. A `Stop` drops the stack, so this is the ordinary path — but the
    // root's own `state`/`endedAt`/`exitAt` reset is what draws the session as
    // live again, and it is now the only such reset in the branch.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" }, T0 + 10);
    state = send(state, { hook_event_name: "SessionEnd" }, T0 + 20);
    expect(state.agents.get(SESSION)!.state).toBe("done");

    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "one more thing" }, T0 + 30);

    const root = state.agents.get(SESSION)!;
    expect(root.state).toBe("active");
    expect(root.endedAt).toBeUndefined();
    expect(root.exitAt).toBeUndefined();
    expect(root.closedAt).toBeUndefined();
    expect(root.prompts.map(p => p.text)).toEqual(["one more thing"]);
  });

  it("leaves the subagent's own tool calls exactly where the stack puts them", () => {
    // This is 5d01f30's behaviour and the reason the stack exists: CC's
    // Pre/PostToolUse hooks carry no agent_id, so an untagged tool call must
    // reach the deepest live subagent. Fixing where the PROMPT lands must not
    // cost that — a prompt arriving mid-Task must leave the attribution the
    // next tool call gets untouched.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" }, T0 + 10);
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "second prompt" }, T0 + 20);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t1" }, T0 + 30);
    state = send(state, { hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "t1", tool_response: "ok" }, T0 + 40);

    const sub = state.agents.get(SUB)!;
    expect(sub.tools.map(t => t.name)).toEqual(["Grep"]);
    expect(sub.toolCount).toBe(1);
    expect(sub.tools[0].endedAt).toBe(T0 + 40);

    const root = state.agents.get(SESSION)!;
    expect(root.tools).toEqual([]);
    expect(root.toolCount).toBe(0);
    expect(root.prompts.map(p => p.text)).toEqual(["second prompt"]);
  });
});
