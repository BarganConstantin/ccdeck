// Point 10 of the owner's V4 critique (2026-11-10), on a phone at 390×844:
// four Sessions rows read the project folder's name one under another, and a
// row with nothing under its name kept an empty second line's height.
//
// The row's name stays the folder's, at the size the phone row name (#2449)
// gave it. Rows whose names collide lead their second line with what tells
// them apart (rail-row-copy.ts rowTells), on the phone and the desktop rail
// alike, since both draw SessionList. A row with no second line is 44 on a
// phone, the touch floor, where a two-line row stays 62.
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList, { buildRows, type Row } from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { resetSessionsSeen } from "../session-seen";
import { lineAfterTell, railLine, rowTells } from "../rail-row-copy";
import { LANGUAGES } from "../i18n/registry";
import { currentLanguage } from "../i18n";
import { sheetRules } from "./sheet-cascade";

/** 15:00:30 today, by this machine's clock: the tell is a clock time. */
const NOW = new Date(2026, 10, 10, 15, 0, 30).getTime();
const MIN = 60_000;
const PHONE = "(max-width: 640px)";

/** A bare row in the folder `label`, started `ago` ms before NOW. */
const row = (sessionId: string, label: string, ago: number, task?: string): Row => ({
  sessionId, label, state: "done", toolCount: 0, cost: 0, startedAt: NOW - ago, lastActivity: NOW - ago,
  plan: null, planTitle: "", ...(task ? { task } : {}),
});
const tellsOf = (rows: Row[], now = NOW) => Object.fromEntries([...rowTells(rows, now)].map(([id, tell]) => [id, tell.text]));
/** "Started 14:55": the hour and minute, `ago` before NOW, in the reader's language. */
const started = (ago: number) =>
  `Started ${new Date(NOW - ago).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit" })}`;

describe("what tells two rows of one name apart", () => {
  it("gives a row whose name is the list's only one nothing", () => {
    expect(rowTells([row("a", "api", MIN, "Fix login"), row("b", "web", MIN, "Fix login")], NOW).size).toBe(0);
  });

  it("two rows: the session's own words first", () => {
    expect(tellsOf([row("a", "ccdeck-pro", MIN, "Fix the phone rows"), row("b", "ccdeck-pro", MIN, "Add Codex accounts")]))
      .toEqual({ a: "Fix the phone rows", b: "Add Codex accounts" });
  });

  it("two rows: the clock time they started, once the words are the same or only the folder's name again", () => {
    expect(tellsOf([row("a", "ccdeck-pro", 5 * MIN, "go"), row("b", "ccdeck-pro", 75 * MIN, "go")]))
      .toEqual({ a: started(5 * MIN), b: started(75 * MIN) });
    expect(tellsOf([row("a", "ccdeck-pro", 5 * MIN, "CCDeck-Pro"), row("b", "ccdeck-pro", 30_000)]))
      .toEqual({ a: started(5 * MIN), b: started(30_000) });
    expect(started(5 * MIN)).toMatch(/^Started \d\d\D\d\d/);
  });

  it("does not change while you look at it", () => {
    const rows = [row("a", "api", 5 * MIN, "go"), row("b", "api", 75 * MIN, "go")];
    expect(tellsOf(rows, NOW + 40 * MIN)).toEqual(tellsOf(rows));
  });

  it("leads with the weekday for a start on an earlier day, so it is not today's same minute", () => {
    const day = 24 * 60 * MIN;
    const yesterday = new Date(NOW - day);
    const lang = currentLanguage();
    const time = yesterday.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    expect(tellsOf([row("a", "api", day, "go"), row("b", "api", 0, "go")]))
      .toEqual({ a: `Started ${yesterday.toLocaleDateString(lang, { weekday: "short" })} ${time}`, b: `Started ${time}` });
  });

  it("two rows: as much of the id as it takes, once they started in the same minute", () => {
    const ids = ["6f1c2a9e-1d2b-4c3d-8e4f-00000000a1b2", "0b9d8c7a-6e5f-4a3b-9c2d-00000000c3d4"];
    expect(tellsOf([row(ids[0], "api", 5 * MIN), row(ids[1], "api", 5 * MIN + 20_000)]))
      .toEqual({ [ids[0]]: "a1b2", [ids[1]]: "c3d4" });
    // Two ids ending alike are told apart by one more character, not a fixed four.
    const alike = ["aaaa-1111abcd", "bbbb-2222abcd"];
    expect(tellsOf([row(alike[0], "api", MIN), row(alike[1], "api", MIN)])).toEqual({ [alike[0]]: "1abcd", [alike[1]]: "2abcd" });
    expect(rowTells([row(ids[0], "api", MIN), row(ids[1], "api", MIN)], NOW).get(ids[0])?.kind).toBe("id");
  });

  it("four rows of one name: each takes the first step that tells it from the rest", () => {
    const rows = [
      row("s1-0000-a1a1", "ccdeck-pro", 10 * MIN, "Fix the phone rows"),
      row("s2-0000-b2b2", "ccdeck-pro", 120 * MIN, "ccdeck-pro"),
      row("s3-0000-c3c3", "ccdeck-pro", 3 * MIN),
      row("s4-0000-d4d4", "ccdeck-pro", 3 * MIN),
      row("s5-0000-e5e5", "docs", 3 * MIN),
    ];
    const tells = rowTells(rows, NOW);
    expect(Object.fromEntries([...tells].map(([id, tell]) => [id, [tell.kind, tell.text]]))).toEqual({
      "s1-0000-a1a1": ["task", "Fix the phone rows"],
      "s2-0000-b2b2": ["started", started(120 * MIN)],
      "s3-0000-c3c3": ["id", "c3c3"],
      "s4-0000-d4d4": ["id", "d4d4"],
    });
    expect(tells.has("s5-0000-e5e5")).toBe(false);
  });

  it("four rows sharing their first prompt: a start that is theirs alone, else the id", () => {
    const rows = [
      row("t1-0000-a1a1", "api", 10 * MIN, "continue"),
      row("t2-0000-b2b2", "api", 40 * MIN, "continue"),
      row("t3-0000-c3c3", "api", 40 * MIN, "continue"),
      row("t4-0000-d4d4", "api", 10 * MIN, "Review the migration"),
    ];
    // t4's words are its own, so its start is not held against t1's.
    expect(tellsOf(rows)).toEqual({
      "t1-0000-a1a1": started(10 * MIN),
      "t2-0000-b2b2": "b2b2",
      "t3-0000-c3c3": "c3c3",
      "t4-0000-d4d4": "Review the migration",
    });
  });

  it("is worded in every language, with the time in it, and the relative wording is gone", () => {
    for (const l of LANGUAGES) {
      expect(l.catalog["board.row.startedAt"], l.code).toContain("{time}");
      expect(l.catalog, l.code).not.toHaveProperty(["board.row.startedAgo"]);
    }
    expect(LANGUAGES.find(l => l.code === "ro")!.catalog["board.row.startedAt"]).toBe("Pornită la {time}");
  });
});

// ── on sessions the reducer built, and drawn ────────────────────────────────

let seq = 0;
const send = (state: GraphState, sid: string, payload: HookPayload, at: number) =>
  applyEvent(state, { seq: ++seq, receivedAt: NOW + at, source: "hook", payload: { session_id: sid, ...payload } } as HookEnvelope);
const begin = (s: GraphState, sid: string, cwd: string, at: number, prompt?: string) => {
  s = send(s, sid, { hook_event_name: "SessionStart", cwd }, at);
  return prompt ? send(s, sid, { hook_event_name: "UserPromptSubmit", prompt }, at + 1) : s;
};
const stop = (s: GraphState, sid: string, at: number) => send(s, sid, { hook_event_name: "Stop" } as HookPayload, at);
const draw = (s: GraphState, now: number) => renderToStaticMarkup(createElement(SessionList, {
  state: s, now, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
}));
/** The markup of one row's button. */
const button = (html: string, sid: string) =>
  [...html.matchAll(/<button[^>]*data-session="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)].find(m => m[1] === sid)?.[0] ?? "";

beforeEach(() => { seq = 0; resetSessionsSeen(); });

describe("the rail draws the tell", () => {
  it("takes the card's words: Claude Code's title first, else the first prompt", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/ccdeck-pro", 0, "Make the phone rows tellable apart");
    s = stop(s, "one", 1_000);
    s = begin(s, "two", "/home/me/ccdeck-pro", 0, "go");
    s = stop(s, "two", 2_000);
    s.agents.get("two")!.sessionTitle = "Add Codex accounts";
    s = begin(s, "solo", "/home/me/docs", 0, "go");
    const rows = buildRows(s, NOW + 10 * MIN);
    const byId = Object.fromEntries(rows.map(r => [r.sessionId, r]));
    expect(byId.one.label).toBe("ccdeck-pro");
    expect(byId.one.tell).toEqual({ kind: "task", text: "Make the phone rows tellable apart" });
    expect(byId.two.tell).toEqual({ kind: "task", text: "Add Codex accounts" });
    expect(byId.solo.tell).toBeUndefined();
  });

  it("leads the second line with it, and the name keeps the first line whole", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/ccdeck-pro", 0, "Fix the phone rows");
    s = stop(s, "one", 1_000);
    s = begin(s, "two", "/home/me/ccdeck-pro", 0, "Add Codex accounts");
    s = send(s, "two", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: "/home/me/ccdeck-pro/src/a.ts" } }, 2_000);
    const html = draw(s, NOW + 10 * MIN);
    const one = button(html, "one");
    const two = button(html, "two");
    expect(one).toContain('<span class="sl-label">ccdeck-pro</span>');
    // Alone, the tell is the line, in the UI face, and the row is two lines.
    expect(one).toMatch(/<span class="sl-line2 sans"><span class="sl-tell words">Fix the phone rows<\/span><\/span>/);
    expect(one).not.toContain("data-one-line");
    // Ahead of a live line it is the lead, and the tool still follows it. The
    // line is mono (a tool), and the words keep the UI face: mono is for
    // figures and ids (the owner's point 8).
    expect(two).toMatch(/<span class="sl-line2 mono"><span class="sl-tell words lead">Add Codex accounts<\/span> · <b class="sl-tool">Edit<\/b> · src\/a\.ts/);
  });

  it("says a first turn's prompt once, where it is the tell and the note alike", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/api", 0, "Fix login");
    s = begin(s, "two", "/home/me/api", 0, "Fix logout");
    const one = buildRows(s, NOW + MIN).find(r => r.sessionId === "one")!;
    // The running turn's note is the prompt that started it (session-note.ts).
    expect(railLine(one, 1)).toEqual({ kind: "mono", text: "Fix login" });
    const b = button(draw(s, NOW + MIN), "one");
    expect(b.slice(b.indexOf('class="sl-line2'))).toMatch(/^class="sl-line2 sans"><span class="sl-tell words">Fix login<\/span><\/span>/);
    // A long first line: the deck keeps the first prompt cut at 120 and the note at 160.
    const long = `Make the phone's Sessions rows tell apart ${"every session in one folder ".repeat(6)}`.trim();
    let t2 = initialState();
    t2 = begin(t2, "a", "/home/me/api", 0, long);
    t2 = begin(t2, "b", "/home/me/api", 0, "Something else");
    const a = buildRows(t2, NOW + MIN).find(r => r.sessionId === "a")!;
    expect(a.tell!.text.endsWith("…")).toBe(true);
    expect(railLine(a, 1)!).not.toEqual({ kind: "mono", text: a.tell!.text });
    expect(lineAfterTell(railLine(a, 1), a.tell)).toBeNull();
    // A note that says more than the tell is kept.
    expect(lineAfterTell({ kind: "mono", text: "Fix login and the tests" }, { kind: "task", text: "Fix login" }))
      .toEqual({ kind: "mono", text: "Fix login and the tests" });
    expect(lineAfterTell({ kind: "tool", name: "Edit", rest: "a.ts" }, { kind: "task", text: "Edit" }))
      .toEqual({ kind: "tool", name: "Edit", rest: "a.ts" });
  });

  it("draws an id in the mono face", () => {
    let s = initialState();
    s = begin(s, "0000-aaaa-1111", "/home/me/api", 0, "go");
    s = stop(s, "0000-aaaa-1111", 1_000);
    s = begin(s, "0000-bbbb-2222", "/home/me/api", 0, "go");
    s = stop(s, "0000-bbbb-2222", 2_000);
    const html = draw(s, NOW + MIN);
    expect(button(html, "0000-aaaa-1111")).toContain('<span class="sl-line2 mono"><span class="sl-tell">1111</span></span>');
    expect(button(html, "0000-bbbb-2222")).toContain('<span class="sl-line2 mono"><span class="sl-tell">2222</span></span>');
  });
});

describe("a row with nothing under its name is shorter on a phone", () => {
  const rules = sheetRules();
  const decl = (selector: string, prop: string, media: string | null) => {
    let found: string | undefined;
    for (const r of rules) {
      if (r.media !== media || !r.selectors.includes(selector)) continue;
      const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
      if (m) found = m[1].trim();
    }
    return found;
  };

  it("is 44, the touch floor, where a two-line row stays 62, and the desktop's rows are as they were", () => {
    expect(decl(".session-list .sl-row[data-one-line]", "min-height", PHONE)).toBe("44px");
    expect(decl(".session-list .sl-row", "min-height", PHONE)).toBe("62px");
    expect(decl(".session-list .sl-row", "min-height", null)).toBe("var(--row-rail)");
    expect(decl(".session-list .sl-row[data-one-line]", "min-height", null)).toBeUndefined();
  });

  it("is marked on a row that draws no second line, and only on one", () => {
    let s = initialState();
    s = begin(s, "quiet", "/home/me/api", 0, "go");
    s = stop(s, "quiet", 1_000);
    s = begin(s, "fresh", "/home/me/web", 0);
    const html = draw(s, NOW + MIN);
    expect(button(html, "quiet")).toContain('data-one-line="true"');
    expect(button(html, "quiet")).not.toContain("sl-line2");
    // A session not yet prompted says Ready on its second line: two lines.
    expect(button(html, "fresh")).not.toContain("data-one-line");
    expect(button(html, "fresh")).toContain("sl-line2");
  });

  it("keeps a tell that leads a line to half of it, so the live line still shows", () => {
    expect(decl(".session-list .sl-tell.lead", "max-width", null)).toBe("50%");
    expect(decl(".session-list .sl-tell.lead", "text-overflow", null)).toBe("ellipsis");
    expect(decl(".session-list .sl-tell.lead", "color", null)).toBeUndefined();
  });

  it("sets a word tell in the interface's own face, the one the page is set in, and leaves the id mono", () => {
    const page = rules.find(r => r.media == null && r.selectors.includes("html") && /(?:^|[;{\s])font\s*:/.test(r.body));
    const face = /font\s*:\s*[^;]*?\/[\d.]+\s+([^;]+)/.exec(page!.body)![1].trim();
    expect(face).toMatch(/sans-serif$/);
    expect(decl(".session-list .sl-tell.words", "font-family", null)).toBe(face);
    // An id tell has no face of its own: it takes the mono line's (drawn above).
    expect(decl(".session-list .sl-tell", "font-family", null)).toBeUndefined();
  });
});
