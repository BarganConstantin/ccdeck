// V4 top-10, inbox: the Sessions list reads like herdr's Inbox.
//
// 1. The order is an inbox's: Needs you, then Done · new (a finished turn you
//    have not looked at is your turn), then Working, then Done (seen), then
//    Ready. Each group's own order is as it was.
// 2. An unseen finished turn wears a small dot in the accent, with ", unread"
//    after its name for a screen reader; a seen one has none.
// 3. The owner keeps the model below the full-width title. Finished turns
//    share one Done heading, while retaining their unread marker.
// 4. The right edge is an age, not a stopwatch: "now", "4m", "1h 12m", "2h",
//    "3d", in the UI face with tabular figures, moving at most once a minute.
// 5. A look-alike's start time ends its second line in tabular sans; it no
//    longer leads it, and a row that reads like no other has none.
//
// Rendered, not read: the sessions are built by the real reducer and the list
// is drawn by react-dom/server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList, { buildRows, rank } from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { markSeen, resetSessionsSeen } from "../session-seen";
import { ageShort } from "../elapsed-short";
import { railTime } from "../rail-row-copy";
import { RAIL_GROUP_LABEL_MSGS } from "../rail-model";
import { clockTime } from "../i18n/format";
import { en } from "../i18n/en";
import { sheetRules } from "./sheet-cascade";

const T0 = 1_700_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
let seq = 0;
const send = (s: GraphState, sid: string, payload: Record<string, unknown>, at: number) =>
  applyEvent(s, { seq: ++seq, receivedAt: T0 + at, source: "hook", payload: { session_id: sid, ...payload } as HookPayload } as HookEnvelope);
const begin = (s: GraphState, sid: string, cwd: string, prompt: string | null, at: number) => {
  s = send(s, sid, { hook_event_name: "SessionStart", cwd }, at);
  return prompt == null ? s : send(s, sid, { hook_event_name: "UserPromptSubmit", prompt }, at + 1);
};
const stop = (s: GraphState, sid: string, at: number) => send(s, sid, { hook_event_name: "Stop" }, at);

/** One of each: "blocked" waits on a permission, "fresh-done" and "old-done"
 *  finished and were never looked at, "seen-done" finished and was looked at,
 *  "busy" works, "ready" was never given a prompt. Each with a model. */
function board(): GraphState {
  let s = initialState();
  s = begin(s, "busy", "/code/busy", "Refactor the parser", 0);
  s = begin(s, "blocked", "/code/blocked", "Clean the build", 0);
  s = send(s, "blocked", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "rm -rf build" } }, 10 * SEC);
  s = send(s, "blocked", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 20 * SEC);
  s = begin(s, "old-done", "/code/old", "Write the changelog", 0);
  s = stop(s, "old-done", 30 * SEC);
  s = begin(s, "fresh-done", "/code/fresh", "Fix the flaky test", 0);
  s = stop(s, "fresh-done", 50 * SEC);
  s = begin(s, "seen-done", "/code/seen", "Bump the version", 0);
  s = stop(s, "seen-done", 40 * SEC);
  markSeen("seen-done", s.agents.get("seen-done")!.endedAt);
  s = begin(s, "ready", "/code/ready", null, 0);
  for (const a of s.agents.values()) { a.model = "claude-opus-4-5"; a.effort = "high"; }
  return s;
}

const draw = (s: GraphState, now: number) => renderToStaticMarkup(createElement(SessionList, {
  state: s, now, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
}));
/** One row's markup, by its session. */
const rowOf = (html: string, id: string) => {
  const at = html.slice(html.indexOf(`data-rail-id="${id}"`));
  return at.slice(0, at.indexOf("</li>"));
};
/** A row's age as drawn: the figure after the screen reader's word. */
const ageOf = (row: string) => /<span class="sl-time (?:warn|quiet)"><span class="vis-hidden">[^<]*<\/span>([^<]*)<\/span>/.exec(row)?.[1] ?? null;

beforeEach(() => { seq = 0; resetSessionsSeen(); });
afterEach(() => { vi.useRealTimers(); resetSessionsSeen(); });

describe("the order is an inbox's", () => {
  it("reads Needs you, Done · new, Working, Done, Ready", () => {
    const rows = buildRows(board(), T0 + 2 * MIN);
    expect(rows.map(r => r.sessionId)).toEqual(["blocked", "fresh-done", "old-done", "busy", "seen-done", "ready"]);
    expect(rows.map(rank)).toEqual([0, 1, 1, 2, 3, 4]);
    expect(RAIL_GROUP_LABEL_MSGS.map(k => en[k])).toEqual(["Needs you", "Done · new", "Working", "Done", "Ready"]);
  });

  it("draws the group headings, words and counts, in that order", () => {
    const html = draw(board(), T0 + 2 * MIN);
    const heads = [...html.matchAll(/<span class="sl-group-label">([^<]*)<\/span><span class="sl-group-count">(\d+)<\/span>/g)].map(m => `${m[1]} ${m[2]}`);
    // CHANGED ON PURPOSE (#2591): "Done · new" and "Done" are one Done group
    // now (the owner's session-chrome change); an unseen turn keeps its dot.
    expect(heads).toEqual(["Needs you 1", "Working 1", "Done 3", "Ready 1"]);
  });

  it("keeps each group's own order: Done · new newest end first, Working newest turn first", () => {
    let s = board();
    s = begin(s, "busy-later", "/code/later", "Write the docs", 5 * SEC);
    const rows = buildRows(s, T0 + 2 * MIN);
    expect(rows.filter(r => rank(r) === 1).map(r => r.sessionId)).toEqual(["fresh-done", "old-done"]);
    expect(rows.filter(r => rank(r) === 2).map(r => r.sessionId)).toEqual(["busy-later", "busy"]);
  });

  it("moves a finished turn below Working once it is looked at", () => {
    const s = board();
    const rows = buildRows(s, T0 + 2 * MIN, new Set(["fresh-done"]));
    expect(rows.map(r => r.sessionId)).toEqual(["blocked", "old-done", "busy", "fresh-done", "seen-done", "ready"]);
  });
});

describe("the unread dot", () => {
  const html = () => draw(board(), T0 + 2 * MIN);

  it("is drawn on an unseen finished turn, and only there", () => {
    const out = html();
    expect(out.match(/class="sl-unread"/g)).toHaveLength(2);
    for (const id of ["fresh-done", "old-done"]) expect(rowOf(out, id)).toContain('<span class="sl-unread" aria-hidden="true"></span>');
    for (const id of ["blocked", "busy", "seen-done", "ready"]) expect(rowOf(out, id)).not.toContain("sl-unread");
  });

  it("says unread after the name for a screen reader, in the words the Feedback list uses", () => {
    const row = rowOf(html(), "fresh-done");
    expect(row).toMatch(/<span class="sl-label">fresh<\/span><span class="vis-hidden">, unread<\/span>/);
    expect(rowOf(html(), "seen-done")).not.toContain(", unread");
  });

  it("is a 6px disc in the accent before the age, and the theme's highlight in forced colours", () => {
    const rules = sheetRules();
    const decl = (selector: string, prop: string, media: string | null = null) => {
      let found: string | undefined;
      for (const r of rules) {
        if (r.media !== media || !r.selectors.includes(selector)) continue;
        const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
        if (m) found = m[1].trim();
      }
      return found;
    };
    expect(decl(".session-list .sl-unread", "background")).toBe("var(--accent)");
    expect(decl(".session-list .sl-unread", "width")).toBe("6px");
    expect(decl(".session-list .sl-unread", "height")).toBe("6px");
    expect(decl(".session-list .sl-unread", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".session-list .sl-unread", "margin-left")).toBe("auto");
    const forced = rules.find(r => r.media?.includes("forced-colors") && r.selectors.includes(".session-list .sl-unread"));
    expect(forced?.body).toMatch(/background:\s*Highlight/);
    const row = rowOf(html(), "fresh-done");
    expect(row.indexOf("sl-unread")).toBeLessThan(row.indexOf("sl-time"));
  });
});

// CHANGED ON PURPOSE (#2591): the row draws its model again, below the
// full-width title (the owner's session-chrome change); it was the Inspector's.
describe("model metadata below the title", () => {
  it("leaves the title its own row and shows model and effort below", () => {
    const out = draw(board(), T0 + 2 * MIN);
    const rows = out.split('<li class="sl-row-item"').slice(1);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      const title = row.split('class="sl-line1"')[1].split('class="sl-line2')[0].split('class="sl-meta"')[0];
      expect(title).not.toContain('sl-model');
      expect(row).toContain('class="sl-meta"');
      expect(row).toContain('class="sl-model"');
      expect(row).toMatch(/opus/i);
    }
  });
});

describe("the age at the right edge", () => {
  it("is now under a minute, then minutes, hours and minutes, round hours and days", () => {
    const now = T0;
    expect(ageShort(now - 59 * SEC, now, "now")).toBe("now");
    expect(ageShort(now + 5 * SEC, now, "now")).toBe("now");
    expect(ageShort(now - MIN, now, "now")).toBe("1m");
    expect(ageShort(now - (4 * MIN + 59 * SEC), now, "now")).toBe("4m");
    expect(ageShort(now - (72 * MIN + 30 * SEC), now, "now")).toBe("1h 12m");
    expect(ageShort(now - 120 * MIN, now, "now")).toBe("2h");
    expect(ageShort(now - (23 * 60 + 59) * MIN, now, "now")).toBe("23h 59m");
    expect(ageShort(now - 3 * 24 * 60 * MIN, now, "now")).toBe("3d");
  });

  it("measures what each group is about: the wait, the turn, the end", () => {
    const s = board();
    const now = T0 + 4 * MIN + 30 * SEC;
    const out = draw(s, now);
    // Blocked at 20s: waiting 4m 10s. Busy's turn began at 1ms: 4m 29s. Old
    // ended at 30s: 4m ago. Ready has no age.
    expect(ageOf(rowOf(out, "blocked"))).toBe("4m");
    expect(rowOf(out, "blocked")).toContain('<span class="sl-time warn"><span class="vis-hidden">waiting </span>4m</span>');
    expect(ageOf(rowOf(out, "busy"))).toBe("4m");
    expect(rowOf(out, "busy")).toContain('<span class="vis-hidden">running </span>');
    expect(ageOf(rowOf(out, "old-done"))).toBe("4m");
    expect(rowOf(out, "old-done")).toContain('<span class="vis-hidden">ended </span>');
    expect(ageOf(rowOf(out, "ready"))).toBeNull();
    // "now" in the reader's own word, under a minute.
    expect(railTime(buildRows(s, T0 + 55 * SEC).find(r => r.sessionId === "fresh-done")!, 1, T0 + 55 * SEC)?.text).toBe("now");
  });

  it("never prints a second, and moves at most once a minute while the list redraws four times a second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 20 * SEC);
    const s = board();
    const seen: Record<string, string[]> = {};
    // Five minutes of the deck's 250 ms clock.
    for (let tick = 0; tick < 5 * 60 * 4; tick++) {
      const out = draw(s, Date.now());
      for (const id of ["blocked", "busy", "fresh-done"]) {
        const age = ageOf(rowOf(out, id))!;
        expect(age).not.toMatch(/\d+s\b/);
        const list = (seen[id] ??= []);
        if (list.at(-1) !== age) list.push(age);
      }
      vi.advanceTimersByTime(250);
    }
    // Each row changed its figure once a minute at most: six readings at most
    // over five minutes, its first included. The wait began as the clock did,
    // so it reads now, then a minute more each minute.
    for (const id of Object.keys(seen)) expect(seen[id].length, id).toBeLessThanOrEqual(6);
    expect(seen.blocked).toEqual(["now", "1m", "2m", "3m", "4m"]);
    expect(seen.busy).toEqual(["now", "1m", "2m", "3m", "4m", "5m"]);
  });

  it("is set in the UI face with tabular figures, as every count in the list", () => {
    const rules = sheetRules();
    const has = (selector: string, prop: string) => rules.some(r => r.media === null && r.selectors.includes(selector) && new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(r.body));
    for (const sel of [".session-list .sl-time", ".session-list .sl-count", ".session-list .sl-group-count", ".session-list .sl-start"]) {
      expect(has(sel, "font-family"), sel).toBe(false);
      expect(rules.some(r => r.media === null && r.selectors.includes(sel) && /font-variant-numeric:\s*tabular-nums/.test(r.body)), sel).toBe(true);
    }
    // Mono is kept for what a person could type: a blocked tool's command.
    expect(rules.some(r => r.media === null && r.selectors.includes(".session-list .sl-line2.mono") && /font-family:\s*var\(--font-mono\)/.test(r.body))).toBe(true);
    expect(rowOf(draw(board(), T0 + 2 * MIN), "blocked")).toMatch(/<span class="sl-line2 mono"><b class="sl-tool">Bash<\/b> · rm -rf build<\/span>/);
  });
});

describe("look-alike rows", () => {
  /** Two sessions that read "twin" over "Write the release notes", 20 s apart. */
  function twins(): GraphState {
    let s = initialState();
    s = begin(s, "t1", "/code/twin", "Write the release notes", 0);
    s = begin(s, "t2", "/code/twin", "Write the release notes", 20 * SEC);
    s = begin(s, "solo", "/code/solo", "Write the release notes", 0);
    return s;
  }

  it("end the second line with the start time, in tabular sans, and do not lead it with a clock", () => {
    const out = draw(twins(), T0 + 2 * MIN);
    const t1 = rowOf(out, "t1");
    expect(t1).toContain(`<span class="sl-line2 sl-twin"><span class="sl-words">Write the release notes</span><span class="sl-start">· ${clockTime(T0, true)}</span></span>`);
    expect(rowOf(out, "t2")).toContain(`<span class="sl-start">· ${clockTime(T0 + 20 * SEC, true)}</span>`);
    expect(out).not.toMatch(/class="sl-line2[^"]*"><span class="sl-start">/);
  });

  it("leave a row that reads like no other as it was", () => {
    const solo = rowOf(draw(twins(), T0 + 2 * MIN), "solo");
    expect(solo).not.toContain("sl-start");
    expect(solo).toContain('<span class="sl-line2">Write the release notes</span>');
  });
});
