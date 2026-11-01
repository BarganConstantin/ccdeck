// The session list's "waiting" word and the number beside it are one set.
//
// The list once counted the sessions blocked on a decision in its header — a
// permission prompt or a question, the set isAlarming names, which is also what
// the topbar pill and the tab title count — and a row printed "waiting 50m" for
// any waiting block, the idle one included: a turn that simply ended, which the
// same session's card and peek call "Your turn". So the word and the number
// disagreed.
//
// V4's Attention rail says it with groups instead: Needs you holds exactly the
// alarming blocks and its header counts them; a row there is read as "waiting"
// and its clock is the wait. A turn that ended is a row of Done · unseen or
// Idle, read as "your turn, ended" with the time it ended. Rendered, not read:
// the sessions are built by the reducer and the list is drawn by
// react-dom/server.
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

/** Each row's clock by the session's label: the word a screen reader hears
 *  first, and the figure. */
function clocks(html: string): Record<string, { spoken: string; text: string }> {
  const out: Record<string, { spoken: string; text: string }> = {};
  for (const row of html.split('<li class="sl-row-item"').slice(1)) {
    const label = /class="sl-label">([^<]*)</.exec(row)?.[1] ?? "?";
    const m = /<span class="sl-time (?:warn|quiet)"><span class="vis-hidden">([^<]*)<\/span>([^<]*)<\/span>/.exec(row);
    if (m) out[label] = { spoken: m[1], text: m[2] };
  }
  return out;
}

describe("the session list's waiting word", () => {
  const s = board();
  const now = T0 + 60 * 60_000;
  const html = renderToStaticMarkup(createElement(SessionList, {
    state: s, now, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
  }));

  it("means the set the Needs you group counts", () => {
    expect(html).toMatch(/<span class="sl-group-label">Needs you<\/span><span class="sl-group-count">1<\/span>/);
    const rows = clocks(html);
    expect(rows.blocked.spoken).toBe("waiting ");
    expect(rows.blocked.text).toMatch(/^\d+m$/);
    expect(Object.values(rows).filter(r => r.spoken.startsWith("waiting")).length).toBe(1);
    // The old readout ended "· Bash": the tool still shows, on the row's
    // second line now, with what it was asked to run.
    const blocked = html.split('<li class="sl-row-item"').find(r => r.includes('class="sl-label">blocked<'))!;
    expect(blocked).toMatch(/<span class="sl-line2 mono"><b class="sl-tool">Bash<\/b> · rm -rf build<\/span>/);
  });

  it("calls an ended turn what the card calls it", () => {
    const ended = clocks(html).ended;
    expect(ended.spoken).toBe("your turn, ended ");
    expect(ended.text).toMatch(/^\d+m ago$/);
  });
});
