// #1842: the agent card said "1 tools" for an agent with one tool call.
//
// The meta row printed its count before a fixed plural. The session list
// (#1810), the peek and the card's own accessible name already say "1 tool";
// the card's visible text now says it the same way.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;

function agent(calls: number): AgentNodeData {
  let seq = 0;
  const send = (state: GraphState, payload: HookPayload, at: number) =>
    applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: "s1", ...payload } } as HookEnvelope);
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
  state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "look around" }, T0 + 1_000);
  for (let i = 0; i < calls; i++) {
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `t${i}` }, T0 + 2_000 + i);
  }
  return state.agents.get("s1")!;
}

/** The card's meta row, rendered as the canvas renders the card. */
function meta(data: AgentNodeData): string {
  const html = renderToStaticMarkup(createElement(ReactFlowProvider, null,
    // NodeProps carries more than the card reads; only data and selected matter here.
    createElement(AgentNode as any, { id: data.id, data, selected: false })));
  const m = html.match(/<div class="meta">(.*?)<\/div>/);
  expect(m).not.toBeNull();
  return m![1];
}

describe("the agent card's tool count (#1842)", () => {
  it("says one tool, not one tools", () => {
    const row = meta(agent(1));
    expect(row).toContain("<span><b>1</b> tool</span>");
    expect(row).not.toContain("<b>1</b> tools");
  });

  it("still says tools for more than one", () => {
    expect(meta(agent(2))).toContain("<span><b>2</b> tools</span>");
  });
});
