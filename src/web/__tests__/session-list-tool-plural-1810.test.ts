// #1810: the session list said "1 tools" for a session with one tool call.
//
// The row printed its count before a fixed plural, and the row is a button
// whose accessible name is its content, so a screen reader said it too. The
// peek card and the card's own label already say "1 tool".
//
// V4's Attention rail moved the count off the row and into its tooltip, where
// the same rule still has to hold (rail-row-copy.ts rowTooltip): the row draws
// the name, the model, a clock and one line, and the figures it used to print
// are the title's.
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

/** The row's tooltip: the first `title` on the list's one row. */
const tooltip = (state: GraphState) => {
  const html = renderToStaticMarkup(createElement(SessionList, {
    state, now: T0 + 10_000, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
  }));
  return /<button[^>]*class="sl-row[^"]*"[^>]*title="([^"]*)"/.exec(html)?.[1] ?? "";
};

describe("the session row's tool count (#1810)", () => {
  it("says one tool, not one tools", () => {
    const title = tooltip(session(1));
    expect(title).toMatch(/\n1 tool(?: ·[^\n]*)?(?:\n|$)/);
    expect(title).not.toContain("1 tools");
  });

  it("still says tools for more than one, and for none", () => {
    expect(tooltip(session(2))).toMatch(/\n2 tools(?: ·[^\n]*)?(?:\n|$)/);
    expect(tooltip(session(0))).toMatch(/\n0 tools(?: ·[^\n]*)?(?:\n|$)/);
  });
});
