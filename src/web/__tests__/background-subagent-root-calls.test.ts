// A background subagent must not take over the calls its own session's main
// thread goes on making.
//
// A Task started with `run_in_background: true` returns at once
// (`async_launched`) and the root keeps working in the same turn while the
// subagent runs beside it. Current Claude Code puts an `agent_id` on every call
// a subagent makes and none on the main thread's, but the reducer handed every
// call without one to the top of the session's subagent stack — a rule written
// for older versions whose subagent calls carried nothing. So the root's Read,
// Edit and Bash were drawn and counted on the subagent's card, and a root call
// still running when the subagent finished stayed in flight on a `done` card.
//
// The stack rule is kept for a session whose subagents have never named
// themselves on their own traffic; once one has, an event naming nobody is the
// root's, including the ones that reached the subagent before it said so.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "s-bg";
const SUB = `${SESSION}::a1`;

let seq = 0;
function send(state: GraphState, payload: HookPayload): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: 1_000 + seq, source: "hook", payload: { session_id: SESSION, ...payload } };
  return applyEvent(state, env);
}

/** The turn up to the point the background Task has been launched. */
function launched(): GraphState {
  let s = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
  s = send(s, { hook_event_name: "UserPromptSubmit", prompt: "review in the background, then fix the bug" });
  s = send(s, { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "task1", tool_input: { run_in_background: true } });
  s = send(s, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "code-reviewer" });
  return send(s, { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "task1", tool_response: { status: "async_launched" } });
}

const names = (s: GraphState, id: string) => s.agents.get(id)!.tools.map(t => t.name);
const live = (s: GraphState, id: string) => s.agents.get(id)!.tools.filter(t => t.endedAt == null).map(t => t.name);

describe("a background subagent beside its session's main thread", () => {
  it("leaves the root's own calls on the root once the subagent has named itself", () => {
    let s = launched();
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "g1", agent_id: "a1" });
    s = send(s, { hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "g1", agent_id: "a1" });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "r1" });
    s = send(s, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "r1" });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1" });

    expect(names(s, SESSION)).toEqual(["Task", "Read", "Bash"]);
    expect(live(s, SESSION)).toEqual(["Bash"]);
    expect(names(s, SUB)).toEqual(["Grep"]);
    expect(s.agents.get(SESSION)!.toolCount).toBe(3);
    expect(s.agents.get(SUB)!.toolCount).toBe(1);
  });

  it("hands back a root call that reached the subagent before the subagent's first own call", () => {
    // The order the finder posted: the root's Bash is under way before the
    // subagent has made a call of its own, so nothing yet says how this
    // session's subagents identify themselves.
    let s = launched();
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "npm test" } });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "g1", agent_id: "a1" });
    s = send(s, { hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "g1", agent_id: "a1" });
    s = send(s, { hook_event_name: "SubagentStop", agent_id: "a1" });

    const sub = s.agents.get(SUB)!;
    expect(sub.state).toBe("done");
    expect(names(s, SUB)).toEqual(["Grep"]);
    expect(live(s, SUB), "a done subagent holds no call in flight").toEqual([]);
    expect(sub.toolCount).toBe(1);
    expect([...(sub.toolCountByName ?? new Map())]).toEqual([["Grep", 1]]);

    const root = s.agents.get(SESSION)!;
    expect(names(s, SESSION)).toEqual(["Task", "Bash"]);
    expect(live(s, SESSION)).toEqual(["Bash"]);
    expect(root.toolCount).toBe(2);
    expect(root.tools.find(t => t.name === "Bash")!.agentId).toBe(SESSION);

    // ...and its outcome settles it where it now is.
    s = send(s, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b1", tool_response: { stdout: "ok" } });
    const bash = s.agents.get(SESSION)!.tools.find(t => t.name === "Bash")!;
    expect(bash.endedAt).not.toBeUndefined();
    expect(bash.ok).toBe(true);
    expect(live(s, SUB)).toEqual([]);
  });

  it("keeps the root's model off the subagent once it has named itself", () => {
    let s = launched();
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "g1", agent_id: "a1", model: "claude-haiku-4-5" });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "r1", model: "claude-opus-5" });
    expect(s.agents.get(SUB)!.model).toBe("claude-haiku-4-5");
    expect(s.agents.get(SESSION)!.model).toBe("claude-opus-5");
  });

  it("still gives an unnamed call to the live subagent when no subagent of the session ever named itself", () => {
    // The older Claude Code this rule was written for: its subagents' calls
    // carry no agent_id at all, so the stack is the only evidence there is.
    let s = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "task1" });
    s = send(s, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "explorer" });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "g1" });
    s = send(s, { hook_event_name: "SubagentStop", agent_id: "a1" });
    expect(names(s, SUB)).toEqual(["Grep"]);
    expect(names(s, SESSION)).toEqual(["Task"]);
  });

  it("decides it per session", () => {
    // One session whose subagent named itself says nothing about another's.
    let s = launched();
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "g1", agent_id: "a1" });
    const other = (p: HookPayload): void => {
      s = applyEvent(s, { seq: ++seq, receivedAt: 1_000 + seq, source: "hook", payload: { session_id: "s-old", ...p } });
    };
    other({ hook_event_name: "SessionStart", cwd: "/old" });
    other({ hook_event_name: "SubagentStart", agent_id: "b1" });
    other({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "x1" });
    expect(names(s, "s-old::b1")).toEqual(["Read"]);
  });
});
