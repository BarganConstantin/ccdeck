// The card's "err", its spoken "failed", the peek's count, the small face and
// the branch summary counted failures only among the last 200 calls.
//
// An agent keeps a 200-call window (MAX_TOOLS_PER_AGENT) and counts every call
// it ever made in `toolCount` and every failure in `toolErrorCount` (#1809).
// The detail panel and the recap read the lifetime count; these five surfaces
// filtered the window instead, so a long session's early failures fell off the
// card while the detail panel beside it still said "err 3" — against the card's
// own comment that its count does not expire.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { agentAriaLabel } from "../agent-copy";
import { branchSummaries, faceSignal } from "../node-face";
import { applyEvent, initialState, MAX_TOOLS_PER_AGENT, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload, ToolCall, WaitingBlock } from "../types";
import { sourceOf } from "./client-source";

const T0 = 1_700_000_000_000;
let seq = 0;
const send = (state: GraphState, payload: HookPayload) =>
  applyEvent(state, { seq: ++seq, receivedAt: T0 + seq, source: "hook", payload: { session_id: "s1", ...payload } } as HookEnvelope);

/** Ten calls with three failures among them, then a window's worth of
 *  successes, made by the root or, with `agent_id`, by one subagent. */
function calls(state: GraphState, by: Partial<HookPayload> = {}, tag = "r"): GraphState {
  for (let i = 0; i < 10 + MAX_TOOLS_PER_AGENT; i++) {
    const id = `${tag}${i}`;
    state = send(state, { ...by, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command: "npm test" } } as HookPayload);
    state = i < 10 && i % 3 === 0 && i > 0
      ? send(state, { ...by, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: id, error: "exit 1" } as HookPayload)
      : send(state, { ...by, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_response: { stdout: "ok" } } as HookPayload);
  }
  return state;
}

function board() {
  let s = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
  s = send(s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
  s = calls(s);
  s = send(s, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" } as HookPayload);
  s = calls(s, { agent_id: "a1", agent_type: "Explore" } as Partial<HookPayload>, "a");
  return s;
}

const words = {
  sayWaiting: (w: WaitingBlock) => w.message ?? "",
  describeCall: (t: ToolCall) => ({ name: t.name, subject: null }),
};

describe("a failure counts for the agent's whole life, on every surface", () => {
  const s = board();
  const root = s.agents.get("s1")!;
  const sub = s.agents.get("s1::a1")!;

  it("is a case the window has already forgotten", () => {
    // The ground the five surfaces stood on: none of the three is left in the
    // window, and the lifetime count the detail panel reads still has them.
    for (const a of [root, sub]) {
      expect(a.tools.filter(t => t.ok === false)).toHaveLength(0);
      expect(a.toolErrorCount).toBe(3);
    }
  });

  it("is on the card", () => {
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null,
      createElement(AgentNode as any, { id: root.id, data: root as AgentNodeData, selected: false })));
    expect(html).toContain("<b>3</b> err");
    expect(html).toContain('title="3 tool calls returned an error"');
  });

  it("is in the card's spoken name", () => {
    expect(agentAriaLabel(root, T0)).toContain("3 failed");
  });

  it("is on the small face", () => {
    expect(faceSignal({ ...root, waiting: null }, undefined, words)).toMatchObject({ tone: "err", short: "3 failed" });
  });

  it("is in the branch summary", () => {
    expect(branchSummaries(s.agents.values()).get("s1")?.failed).toBe(3);
  });

  it("is in the peek, which reads the same count", () => {
    // The peek draws into a portal on document.body, which this suite has no
    // DOM for; its count is read off the same field as the card's.
    expect(sourceOf("components/SessionPeek.tsx")).toMatch(/const failed = a\.toolErrorCount \?\? 0;/);
    expect(sourceOf("components/SessionPeek.tsx")).not.toMatch(/ok === false/);
  });
});
