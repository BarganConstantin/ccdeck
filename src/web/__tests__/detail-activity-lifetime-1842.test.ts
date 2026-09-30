// #1842: the detail panel's "err" count and its tool chips covered only the
// agent's last 200 calls.
//
// "250 calls" beside them is the agent's lifetime counter, but the errors and
// the chips were read off `tools`, the window `trimTools` keeps at
// MAX_TOOLS_PER_AGENT. So a long session's early failures vanished from the
// panel while the recap, which reads the lifetime counters #1809 added, still
// counted them, and a tool used heavily early on had no chip at all. The panel
// now reads the same counters the recap does.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Detail from "../components/Detail";
import { applyEvent, initialState, MAX_TOOLS_PER_AGENT, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
const CALLS = 250;

let seq = 0;
const send = (state: GraphState, payload: HookPayload, at: number) =>
  applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: "s1", ...payload } } as HookEnvelope);

/** A session of `CALLS` settled calls: call `i` is named by `name` and failed
 *  when `fails` says so. */
function agent(name: (i: number) => string, fails: (i: number) => boolean = () => false): AgentNodeData {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
  state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "look around" }, T0 + 1);
  for (let i = 0; i < CALLS; i++) {
    const tool_name = name(i);
    state = send(state, { hook_event_name: "PreToolUse", tool_name, tool_use_id: `t${i}` }, T0 + 10 + i * 2);
    state = send(state, {
      hook_event_name: fails(i) ? "PostToolUseFailure" : "PostToolUse", tool_name, tool_use_id: `t${i}`,
      tool_response: fails(i) ? "exit 1" : "ok",
    }, T0 + 11 + i * 2);
  }
  return send(state, { hook_event_name: "Stop" }, T0 + 10_000).agents.get("s1")!;
}

const panel = (a: AgentNodeData) =>
  renderToStaticMarkup(createElement(Detail, { agent: a, now: T0 + 20_000, onOpenTool: () => {} }));

/** The chip for one category, or null: its tooltip and the count it shows. */
function chip(html: string, cat: string): { title: string; count: number } | null {
  const m = html.match(new RegExp(`<span class="cat-chip cat-${cat}[^"]*"[^>]*title="([^"]*)".*?<span class="cat-count">(\\d+)</span>`));
  return m ? { title: m[1], count: Number(m[2]) } : null;
}

describe("the detail panel counts errors and chips over every call (#1842)", () => {
  // The first 60 are failed Bash calls, the other 190 Reads that worked: the
  // window holds only the last ten of the Bash calls.
  const early = agent(i => (i < 60 ? "Bash" : "Read"), i => i < 60);

  it("is a long enough session to have calls out of the window", () => {
    expect(early.toolCount).toBe(CALLS);
    expect(early.tools).toHaveLength(MAX_TOOLS_PER_AGENT);
    expect(early.tools.filter(t => t.name === "Bash")).toHaveLength(10);
  });

  it("counts failures older than the window", () => {
    const html = panel(early);
    expect(html).toContain(`<b>${CALLS}</b> calls`);
    expect(html).toContain('<span class="ac-item ac-err"><b>60</b> err</span>');
  });

  it("counts each chip over every call", () => {
    const html = panel(early);
    expect(chip(html, "shell")).toEqual({ title: "60 shell calls", count: 60 });
    expect(chip(html, "file")).toEqual({ title: "190 file calls", count: 190 });
  });

  it("keeps the chip, and the errors, of a tool used only before the window", () => {
    // Fifty failed Bash calls: every one of them has left the window.
    const html = panel(agent(i => (i < 50 ? "Bash" : "Read"), i => i < 50));
    expect(chip(html, "shell")).toEqual({ title: "50 shell calls", count: 50 });
    expect(html).toContain('<span class="ac-item ac-err"><b>50</b> err</span>');
  });

  it("names an MCP chip's server only when every call went to it, not only the recent ones", () => {
    // Ten calls to one server early on, then the rest to another.
    const two = agent(i => (i < 10 ? "mcp__github__search" : "mcp__linear__list_issues"));
    expect(two.tools.some(t => t.name === "mcp__github__search")).toBe(false);
    expect(chip(panel(two), "mcp")).toEqual({ title: `${CALLS} mcp calls`, count: CALLS });
    // One server throughout still names it.
    const one = agent(() => "mcp__linear__list_issues");
    expect(chip(panel(one), "mcp")?.title).toMatch(new RegExp(`^${CALLS} mcp calls, all to `));
  });
});
