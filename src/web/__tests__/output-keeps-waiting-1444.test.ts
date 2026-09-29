// #1444: the output watch cleared the waiting badge a moment after a prompt
// raised it.
//
// The server polls every live session's transcript every 1.5s and reports each
// block the model finished writing as an `OutputObserved`. The block that leads
// to a prompt — the tool call a permission prompt is about, the text of a
// question — is written just before the prompt, so the next tick usually lands
// after the Notification. It went through the clear rule as session traffic,
// and the chip, the tab title and the favicon went back to resting while the
// prompt was still open in the terminal.
//
// Plain node: the reducer driven directly, the way the server's pushEvent feeds
// it.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookPayload } from "../types";

const SESSION = "s-1444";
let seq = 0;

function send(state: GraphState, payload: HookPayload, receivedAt: number, source: "hook" | "internal" = "hook"): GraphState {
  return applyEvent(state, { seq: ++seq, receivedAt, source, payload: { session_id: SESSION, ...payload } });
}

/** The tick that finds the block the model wrote just before the prompt. */
const output = (state: GraphState, kind: "tool_use" | "text" | "thinking", at: number, receivedAt: number) =>
  send(state, { hook_event_name: "OutputObserved", kind, at }, receivedAt, "internal");

const root = (state: GraphState) => state.agents.get(SESSION)!;

/** A turn under way: started, prompted. */
function turn(): GraphState {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, 1_000);
  return send(state, { hook_event_name: "UserPromptSubmit", prompt: "clean the build" }, 1_100);
}

describe("the output watch leaves a standing prompt standing (#1444)", () => {
  it("keeps a permission block when the tick reports the tool call it is about", () => {
    let state = send(turn(), {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm -rf dist" },
    }, 5_000);
    state = send(state, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 5_050);
    expect(root(state).waiting?.kind).toBe("permission");

    state = output(state, "tool_use", 4_990, 5_600);
    expect(root(state).waiting?.kind).toBe("permission");
    // Still read for what it is for: the card's "last worked" moves.
    expect(root(state).lastOutputAt).toBe(4_990);
  });

  it("keeps an asked block when the tick reports the question's own text", () => {
    let state = send(turn(), { hook_event_name: "Notification", notification_type: "agent_needs_input", message: "ccdeck needs your input: all three, or one?" }, 5_050);
    expect(root(state).waiting?.kind).toBe("asked");

    state = output(state, "text", 4_990, 5_600);
    expect(root(state).waiting?.kind).toBe("asked");
    expect(root(state).outputs).toEqual([4_990]);
  });

  it("keeps it through any number of ticks, and still clears on the answer", () => {
    let state = send(turn(), {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm -rf dist" },
    }, 5_000);
    state = send(state, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 5_050);
    for (const [i, kind] of (["tool_use", "thinking", "text"] as const).entries()) {
      state = output(state, kind, 4_990 + i, 5_600 + i * 1_500);
      expect(root(state).waiting?.kind, kind).toBe("permission");
    }
    // The human approved: the tool's result is the session's own traffic.
    state = send(state, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_response: { stdout: "" } }, 20_000);
    expect(root(state).waiting).toBeFalsy();
  });
});
