// #1809: the session recap counted every tool call but only the errors, and the
// most-used tools, among each agent's last 200.
//
// "250 tool calls" is the agent's lifetime counter, while the errors stat and
// the ranking were read off `tools`, the window `trimTools` keeps at
// MAX_TOOLS_PER_AGENT. So ten failures early in a long session vanished from a
// recap that still counted their calls, and the errors stat, hidden at zero,
// was simply not there. The window stays — it is what bounds the memory a
// long-lived session holds — and the agent now also keeps a lifetime count of
// its failed calls and of its calls by tool, which the recap sums instead.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionSummary from "../components/SessionSummary";
import { applyEvent, initialState, MAX_TOOLS_PER_AGENT, sweepStaleTools, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
const CALLS = 250;

let seq = 0;
const send = (state: GraphState, payload: HookPayload, at: number) =>
  applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: "s1", ...payload } } as HookEnvelope);

/** A session of `CALLS` calls, of which the ones `fails` names failed, and the
 *  first `greps` were Grep and the rest Read. */
function session(fails: (i: number) => boolean, greps = 0): GraphState {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
  state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "look around" }, T0 + 1);
  for (let i = 0; i < CALLS; i++) {
    const tool_name = i < greps ? "Grep" : "Read";
    state = send(state, { hook_event_name: "PreToolUse", tool_name, tool_use_id: `t${i}` }, T0 + 10 + i * 2);
    state = send(state, {
      hook_event_name: fails(i) ? "PostToolUseFailure" : "PostToolUse", tool_name, tool_use_id: `t${i}`,
      tool_response: fails(i) ? "no such file" : "ok",
    }, T0 + 11 + i * 2);
  }
  return send(state, { hook_event_name: "Stop" }, T0 + 10_000);
}

const recap = (state: GraphState) =>
  renderToStaticMarkup(createElement(SessionSummary, { state, sessionId: "s1", onClose: () => {} }));

const stat = (label: string, value: number) =>
  `<div class="ss-stat-value">${value}</div><div class="ss-stat-label">${label}</div>`;

describe("the session recap counts errors over every call (#1809)", () => {
  it("is a long enough session to have calls out of the window", () => {
    const root = session(() => false).agents.get("s1")!;
    expect(root.toolCount).toBe(CALLS);
    expect(root.tools).toHaveLength(MAX_TOOLS_PER_AGENT);
  });

  it("counts failures older than the window", () => {
    const html = recap(session(i => i < 10));
    expect(html).toContain(stat("tool calls", CALLS));
    expect(html).toContain(stat("errors", 10));
  });

  it("counts them the same when they are the newest calls instead", () => {
    expect(recap(session(i => i >= CALLS - 10))).toContain(stat("errors", 10));
  });

  it("does not count a failure twice when it is delivered again", () => {
    let state = session(i => i < 10 || i === CALLS - 1);
    // One whose call has left the window, and one still in it.
    state = send(state, { hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_use_id: "t3", tool_response: "no such file" }, T0 + 20_000);
    state = send(state, { hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_use_id: `t${CALLS - 1}`, tool_response: "no such file" }, T0 + 20_001);
    expect(recap(state)).toContain(stat("errors", 11));
  });

  it("takes back a failure the stale sweep guessed when the real outcome lands", () => {
    seq = 0;
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "slow" }, T0 + 10);
    sweepStaleTools(state, T0 + 10 * 60_000, 90_000);
    expect(state.agents.get("s1")!.tools[0].ok).toBe(false);
    expect(recap(state)).toContain(stat("errors", 1));
    state = send(state, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "slow", tool_response: "ok" }, T0 + 10 * 60_000 + 1);
    expect(recap(state)).not.toContain(">errors<");
  });

  it("ranks the most-used tools over every call too", () => {
    // 60 Greps first, then 190 Reads: the window holds only the last 10 Greps.
    const html = recap(session(() => false, 60));
    expect(html).toMatch(/<span class="ss-tt-name">Read<\/span>.*?<span class="ss-tt-count">190<\/span>/);
    expect(html).toMatch(/<span class="ss-tt-name">Grep<\/span>.*?<span class="ss-tt-count">60<\/span>/);
  });

  it("ranks a call under the name a later copy of its start supplies", () => {
    seq = 0;
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
    state = send(state, { hook_event_name: "PreToolUse", tool_use_id: "nameless" }, T0 + 10);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "nameless" }, T0 + 11);
    state = send(state, { hook_event_name: "Stop" }, T0 + 1_000);
    const html = recap(state);
    expect(html).toMatch(/<span class="ss-tt-name">Bash<\/span>.*?<span class="ss-tt-count">1<\/span>/);
    expect(html).not.toContain('<span class="ss-tt-name">?</span>');
  });
});
