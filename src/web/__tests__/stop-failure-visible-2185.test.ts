// #2185: a session whose turn stopped on an error at once stays on the canvas.
//
// The canvas leaves out a "ghost": a session that ended within three seconds of
// starting having called no tool. A session dispatched on a login that has
// already expired does exactly that — it starts, its first turn stops on
// StopFailure, and it is done — so the ghost rule hid it, and with it the one
// card that says "Stopped · login expired". These cases drive the real reducer
// with the events Claude Code sends, then read the canvas the way the board
// does: the visibility rule, the visible set, the flow nodes and the card.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
import { computeVisibleIds, isAgentVisible } from "../visibility";
import { snapshotToFlow } from "../canvas-flow";
import AgentNode from "../components/AgentNode";

const SID = "s-stopped-at-once";
const START = 1_800_000_000_000;

/** A session that starts, takes a prompt and ends its turn with `end`, one
 *  second apart, so it is over two seconds after it began and called no tool. */
function endedAtOnce(end: Partial<HookPayload>): GraphState {
  const state = initialState();
  let seq = 0;
  let at = START;
  const send = (payload: Partial<HookPayload>) => applyEvent(state, {
    seq: ++seq, receivedAt: at, source: "hook",
    payload: { session_id: SID, provider: "claude", ...payload } as HookPayload,
  } as HookEnvelope);
  send({ hook_event_name: "SessionStart", cwd: "/work/repo" });
  at += 1_000;
  send({ hook_event_name: "UserPromptSubmit", prompt: "fix the build" });
  at += 1_000;
  send({ cwd: "/work/repo", ...end });
  return state;
}

/** The StopFailure Claude Code sends when the login has already expired. */
const loginExpired: Partial<HookPayload> = {
  hook_event_name: "StopFailure",
  error: "authentication_failed",
  last_assistant_message: "Login expired · Please run /login",
} as Partial<HookPayload>;

const root = (state: GraphState): AgentNodeData => state.agents.get(SID)!;

/** Well past the three seconds the ghost rule measures, out to half an hour. */
const LATER = [3_001, 10_000, 60_000, 30 * 60_000];

/** The board's nodes at `now`, built from the visible set the board uses. */
function boardNodes(state: GraphState, now: number) {
  return snapshotToFlow(state, now, 1600, 900, new Map(), new Map(), new Map(), () => {}, true, false,
    new Map(), new Set(), "test", { current: "" }, new Set(), null, computeVisibleIds(state, now), () => {}, true, new Set()).nodes;
}

const card = (data: AgentNodeData) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(AgentNode as never, { id: data.id, data, selected: false })));

describe("a session whose first turn stops on an expired login within three seconds", () => {
  it("is the case the ghost rule measures: done, no tool, over in under three seconds", () => {
    const a = root(endedAtOnce(loginExpired));
    expect(a.kind).toBe("root");
    expect(a.state).toBe("done");
    expect(a.tools).toHaveLength(0);
    expect(a.endedAt! - a.startedAt).toBeLessThan(3000);
    expect(a.stopFailure).toMatchObject({ kind: "login", error: "authentication_failed" });
  });

  it("stays visible past three seconds and long after", () => {
    const s = endedAtOnce(loginExpired);
    const a = root(s);
    for (const after of LATER) {
      const now = a.endedAt! + after;
      expect(isAgentVisible(a, now), `${after} ms after the stop`).toBe(true);
      expect(computeVisibleIds(s, now).has(SID), `${after} ms after the stop`).toBe(true);
      expect(boardNodes(s, now).map(n => n.id), `${after} ms after the stop`).toContain(SID);
    }
  });

  it("has a card on the board that says the login expired and what to do", () => {
    const s = endedAtOnce(loginExpired);
    const node = boardNodes(s, root(s).endedAt! + 60_000).find(n => n.id === SID);
    expect(node, "the session's node on the board").toBeDefined();
    const html = card(node!.data);
    expect(html).toContain('class="stop-row"');
    expect(html).toContain("Stopped · login expired");
    expect(html).toContain("It said: “Login expired · Please run /login”");
    expect(html).toContain("Type “continue” in this session once a working login is active.");
    expect(html).toContain('class="agent-node state-err"');
  });

  for (const [error, label] of [["rate_limit", "Stopped · usage limit"], ["server_error", "Stopped · API error"]] as const) {
    it(`stays drawn, with its card, for the other stop errors too: ${error}`, () => {
      const s = endedAtOnce({ hook_event_name: "StopFailure", error } as Partial<HookPayload>);
      const now = root(s).endedAt! + 60_000;
      expect(computeVisibleIds(s, now).has(SID)).toBe(true);
      const node = boardNodes(s, now).find(n => n.id === SID);
      expect(node, "the session's node on the board").toBeDefined();
      expect(card(node!.data)).toContain(label);
    });
  }
});

describe("a session that simply ended that fast is still left out, as before", () => {
  it("on a plain Stop: no card, no node, at any time after", () => {
    const s = endedAtOnce({ hook_event_name: "Stop" });
    const a = root(s);
    expect(a.state).toBe("done");
    expect(a.tools).toHaveLength(0);
    expect(a.endedAt! - a.startedAt).toBeLessThan(3000);
    expect(a.stopFailure ?? null).toBeNull();
    for (const after of LATER) {
      const now = a.endedAt! + after;
      expect(isAgentVisible(a, now), `${after} ms after the stop`).toBe(false);
      expect(computeVisibleIds(s, now).has(SID), `${after} ms after the stop`).toBe(false);
      expect(boardNodes(s, now).map(n => n.id), `${after} ms after the stop`).not.toContain(SID);
    }
  });

  it("the same stopped session with its stop taken away, either way the reducer leaves it", () => {
    const a = root(endedAtOnce(loginExpired));
    const now = a.endedAt! + 60_000;
    expect(isAgentVisible({ ...a, stopFailure: undefined }, now)).toBe(false);
    expect(isAgentVisible({ ...a, stopFailure: null }, now)).toBe(false);
  });

  it("while one that took three seconds or more, or called a tool, is drawn as before", () => {
    const a = root(endedAtOnce({ hook_event_name: "Stop" }));
    const now = a.endedAt! + 60_000;
    expect(isAgentVisible({ ...a, endedAt: a.startedAt + 3000 }, now)).toBe(true);
    expect(isAgentVisible({ ...a, tools: [{ id: "t1" } as AgentNodeData["tools"][number]] }, now)).toBe(true);
  });
});
