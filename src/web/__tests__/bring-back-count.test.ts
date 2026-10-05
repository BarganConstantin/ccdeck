// "Bring back 31 removed cards" for one session with three cards drawn.
//
// A new prompt retires the previous turn's finished subagents with `exitAt`:
// they fade off the canvas and stay in the agents map until the 200-agent cap
// evicts them. Removing the session hides every agent of it, those included,
// and the session list's footer counted that whole set — so the number named
// cards that were not on the board before the removal and would not be on it
// after "bring back" either.
//
// Rendered, not read: the board is built by the reducer, the removal is the
// one use-removals.ts makes, and SessionList is drawn by react-dom/server.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { removalHiddenIds } from "../remove-node";
import { computeVisibleIds, EXIT_ANIM_MS } from "../visibility";
import type { HookEnvelope, HookPayload } from "../types";

const SID = "busy-session";
const T0 = 1_700_000_000_000;
let seq = 0;
let clock = T0;
const send = (state: GraphState, payload: HookPayload) =>
  applyEvent(state, { seq: ++seq, receivedAt: (clock += 1_000), source: "hook", payload: { session_id: SID, ...payload } } as HookEnvelope);

/** One turn that spawns `n` subagents and lets them all finish. */
function turn(state: GraphState, t: number, n: number): GraphState {
  state = send(state, { hook_event_name: "UserPromptSubmit", prompt: `turn ${t}` });
  for (let k = 0; k < n; k++) {
    const task = `task-${t}-${k}`, agent = `a${t}-${k}`;
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: task, tool_input: { description: "look", subagent_type: "Explore" } });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: agent, agent_type: "Explore" } as HookPayload);
    state = send(state, { hook_event_name: "PreToolUse", agent_id: agent, tool_name: "Read", tool_use_id: `r-${agent}` } as HookPayload);
    state = send(state, { hook_event_name: "PostToolUse", agent_id: agent, tool_name: "Read", tool_use_id: `r-${agent}`, tool_response: {} } as HookPayload);
    state = send(state, { hook_event_name: "SubagentStop", agent_id: agent, agent_type: "Explore" } as HookPayload);
    state = send(state, { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: task, tool_response: {} });
  }
  return state;
}

describe("the session list's bring-back count", () => {
  it("counts the cards that come back, not the retired ones behind them", () => {
    let s = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    for (let t = 0; t < 5; t++) s = turn(s, t, 6);
    // Four turns' subagents retired, the last turn's six still drawn.
    s = turn(s, 5, 2);
    const now = clock + EXIT_ANIM_MS + 1_000;
    const removed = removalHiddenIds(s.agents.values(), new Set([SID]));
    const drawn = [...computeVisibleIds(s, now)].filter(id => s.agents.get(id)!.sessionId === SID);
    expect(removed.size).toBe(1 + 5 * 6 + 2);
    expect(drawn).toHaveLength(1 + 2);

    const html = renderToStaticMarkup(createElement(SessionList, {
      state: s, now, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
      removedIds: removed, onBringBackAll: () => {},
    }));
    expect(html).toContain("Bring back 3 removed cards");
    // The row still says the session is off the board.
    expect(html).toContain("off the board");
  });
});
