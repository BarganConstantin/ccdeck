// The session list's header said "1 waiting" over two rows reading "waiting …".
//
// The header counts the sessions blocked on a decision — a permission prompt or
// a question, the set isAlarming names, which is also what the topbar pill and
// the tab title count. A row printed "waiting 50m" for any waiting block, the
// idle one included: a turn that simply ended, which the same session's card
// and peek call "Your turn". So the word and the number beside it disagreed.
//
// Rendered, not read: the sessions are built by the reducer and the list is
// drawn by react-dom/server.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
let seq = 0;
const send = (state: GraphState, sid: string, payload: HookPayload) =>
  applyEvent(state, { seq: ++seq, receivedAt: T0 + seq * 1_000, source: "hook", payload: { session_id: sid, ...payload } } as HookEnvelope);

function board(): GraphState {
  let s = initialState();
  s = send(s, "blocked", { hook_event_name: "SessionStart", cwd: "/home/dev/blocked" });
  s = send(s, "blocked", { hook_event_name: "UserPromptSubmit", prompt: "build" });
  s = send(s, "blocked", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "rm -rf build" } });
  s = send(s, "blocked", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" } as HookPayload);
  s = send(s, "ended", { hook_event_name: "SessionStart", cwd: "/home/dev/ended" });
  s = send(s, "ended", { hook_event_name: "UserPromptSubmit", prompt: "fix it" });
  s = send(s, "ended", { hook_event_name: "Stop" } as HookPayload);
  s = send(s, "ended", { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" } as HookPayload);
  return s;
}

/** Each row's readout in the elapsed slot, by the session's label. */
function readouts(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of html.split('<li class="sl-row-item">').slice(1)) {
    const label = /class="sl-label">([^<]*)</.exec(row)?.[1] ?? "?";
    const slot = /<span class="sl-(?:waiting|your-turn|elapsed)"[^>]*>(.*?)<\/span>(?:<\/div>)/.exec(row)?.[1] ?? "";
    out[label] = slot.replace(/<[^>]+>/g, "");
  }
  return out;
}

describe("the session list's waiting word", () => {
  const s = board();
  const now = T0 + 60 * 60_000;
  const html = renderToStaticMarkup(createElement(SessionList, {
    state: s, now, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
  }));

  it("means the set the header counts", () => {
    expect(html).toContain('<span class="sl-waiting-count">1 waiting</span>');
    const rows = readouts(html);
    expect(rows.blocked).toMatch(/^waiting \d+m · Bash$/);
    expect(rows.ended).not.toMatch(/waiting/);
    expect(Object.values(rows).filter(r => r.startsWith("waiting")).length).toBe(1);
  });

  it("calls an ended turn what the card calls it", () => {
    expect(readouts(html).ended).toMatch(/^your turn \d+m$/);
  });
});
