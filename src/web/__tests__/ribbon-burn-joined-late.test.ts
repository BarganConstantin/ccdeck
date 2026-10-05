// The topbar ribbon quoted "$29.60 · $105/min" sixteen seconds after the deck
// joined a session that had been running for hours.
//
// A session whose start this page never saw — every session older than the
// event ring after a reload, every running one after Clear or a restart — gets
// a synthetic root whose clock starts when the deck joined, while its cost is
// the transcript's total for the whole session. The card has not quoted a rate
// for such a root since #822 (card-cost.ts), because the quotient overstates
// the burn by however much of the session was missed. The ribbon naming the
// selected agent was the one place that still divided.
//
// Rendered, not read: the session is built by the reducer, the ribbon is drawn
// by react-dom/server.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SelectedRibbon from "../components/SelectedRibbon";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
let seq = 0;
const send = (state: GraphState, sid: string, payload: HookPayload, source: "hook" | "internal" = "hook") =>
  applyEvent(state, { seq: ++seq, receivedAt: T0 + seq, source, payload: { session_id: sid, ...payload } } as HookEnvelope);

const usage = { input_tokens: 400_000, output_tokens: 600_000, cache_read_input_tokens: 30_000_000, cache_creation_input_tokens: 2_000_000 };

function session(sid: string, seenStart: boolean): AgentNodeData {
  let s = initialState();
  if (seenStart) s = send(s, sid, { hook_event_name: "SessionStart", cwd: "/home/dev/app" });
  s = send(s, sid, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "npm run build" }, cwd: "/home/dev/app" } as HookPayload);
  s = send(s, sid, { hook_event_name: "ModelObserved", model: "claude-opus-5-5", subagentModels: {} } as HookPayload, "internal");
  s = send(s, sid, { hook_event_name: "UsageObserved", usage, usageByModel: null } as HookPayload, "internal");
  return s.agents.get(sid)!;
}

const ribbon = (selected: AgentNodeData, now: number) => renderToStaticMarkup(createElement(SelectedRibbon, {
  selected, now, selectedIds: new Set([selected.id]), focusAgent: () => {}, clearSelection: () => {},
}));

describe("the selected-agent ribbon's burn rate", () => {
  it("is not quoted for a session the deck joined late", () => {
    const late = session("joined-late", false);
    expect(late.synthetic).toBe(true);
    expect(late.state).toBe("active");
    const html = ribbon(late, late.startedAt + 16_000);
    expect(html).toContain("$29.60");
    expect(html).not.toMatch(/\/min/);
  });

  it("is still quoted for a session the deck saw start", () => {
    const seen = session("seen-start", true);
    expect(seen.synthetic).toBeFalsy();
    expect(ribbon(seen, seen.startedAt + 16 * 60_000)).toMatch(/\$29\.60[^<]*<span class="selected-rate"> · [^<]*\/min<\/span>/);
  });
});
