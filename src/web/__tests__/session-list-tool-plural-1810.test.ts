// #1810: the session list said "1 tools" for a session with one tool call.
//
// The row printed its count before a fixed plural, and the row is a button
// whose accessible name is its content, so a screen reader said it too. The
// peek card and the card's own label already say "1 tool".
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;

function session(calls: number): GraphState {
  let seq = 0;
  const send = (state: GraphState, payload: HookPayload, at: number) =>
    applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: "s1", ...payload } } as HookEnvelope);
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
  state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "look around" }, T0 + 1_000);
  for (let i = 0; i < calls; i++) {
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `t${i}` }, T0 + 2_000 + i);
  }
  return state;
}

const row = (state: GraphState) => renderToStaticMarkup(createElement(SessionList, {
  state, now: T0 + 10_000, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
}));

describe("the session row's tool count (#1810)", () => {
  it("says one tool, not one tools", () => {
    const html = row(session(1));
    expect(html).toContain("<b>1</b> tool<");
    expect(html).not.toContain("<b>1</b> tools");
  });

  it("still says tools for more than one, and for none", () => {
    expect(row(session(2))).toContain("<b>2</b> tools<");
    expect(row(session(0))).toContain("<b>0</b> tools<");
  });
});
