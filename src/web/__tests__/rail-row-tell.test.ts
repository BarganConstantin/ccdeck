// Point 10 of the owner's V4 critique (2026-11-10), on a phone at 390×844:
// four Sessions rows read the project folder's name one under another, and a
// row with nothing under its name kept an empty second line's height.
//
// CHANGED ON PURPOSE (owner 2026-11-10): rail rows show the session's name.
// A row is titled as its card is: the name the user gave the session, else
// Claude Code's title, and the folder only when there is neither, at the size
// the phone row name (#2449) gave it. Its second line carries at most one
// quiet lead before the live line (rail-row-copy.ts rowTells): the folder
// under a name of its own, or, where titles collide, what tells the rows apart
// (the folder, the first prompt, the clock time it started, the short id), on the phone and the
// desktop rail alike, since both draw SessionList. A row with no second line
// is 44 on a phone, the touch floor, where a two-line row stays 62.
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList, { buildRows, type Row } from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { resetSessionsSeen } from "../session-seen";
import { lineAfterTell, railLine, rowSpoken, rowTells, rowTooltip } from "../rail-row-copy";
import { LANGUAGES } from "../i18n/registry";
import { currentLanguage } from "../i18n";
import { sheetRules } from "./sheet-cascade";

/** 15:00:30 today, by this machine's clock: the tell is a clock time. */
const NOW = new Date(2026, 10, 10, 15, 0, 30).getTime();
const MIN = 60_000;
const PHONE = "(max-width: 640px)";

/** A bare row titled `label`, started `ago` ms before NOW; `folder` and `task`
 *  are set only when the title is something else, as buildRows sets them. */
const row = (sessionId: string, label: string, ago: number, folder?: string, task?: string): Row => ({
  sessionId, label, state: "done", toolCount: 0, cost: 0, startedAt: NOW - ago, lastActivity: NOW - ago,
  plan: null, planTitle: "", ...(folder ? { folder } : {}), ...(task ? { task } : {}),
});
const tellsOf = (rows: Row[], now = NOW) => Object.fromEntries([...rowTells(rows, now)].map(([id, tell]) => [id, tell.text]));
/** "Started 14:55": the hour and minute, `ago` before NOW, in the reader's language. */
const started = (ago: number) =>
  `Started ${new Date(NOW - ago).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit" })}`;

describe("the one quiet lead of a row's second line", () => {
  // CHANGED ON PURPOSE (owner 2026-11-10): rail rows show the session's name
  it("gives a row titled by its folder nothing, and a row with a name of its own its folder", () => {
    const tells = rowTells([row("a", "api", MIN), row("b", "loroloop", MIN, "Desktop")], NOW);
    expect(tells.has("a")).toBe(false);
    expect(tells.get("b")).toEqual({ kind: "folder", text: "Desktop" });
  });

  // CHANGED ON PURPOSE (owner 2026-11-10): rail rows show the session's name
  it("two rows of one name: the folder first, when it tells them apart", () => {
    expect(tellsOf([row("a", "ccdeck v4", MIN, "ccdeck-pro"), row("b", "ccdeck v4", MIN, "ccdeck-site")]))
      .toEqual({ a: "ccdeck-pro", b: "ccdeck-site" });
    expect(rowTells([row("a", "ccdeck v4", MIN, "ccdeck-pro"), row("b", "ccdeck v4", MIN, "ccdeck-site")], NOW).get("a")?.kind)
      .toBe("folder");
  });

  // CHANGED ON PURPOSE (owner 2026-11-10): rail rows show the session's name
  it("two rows: the clock time they started, once the folder is the same or is the title itself", () => {
    expect(tellsOf([row("a", "ccdeck v4", 5 * MIN, "Desktop"), row("b", "ccdeck v4", 75 * MIN, "Desktop")]))
      .toEqual({ a: started(5 * MIN), b: started(75 * MIN) });
    expect(tellsOf([row("a", "ccdeck-pro", 5 * MIN), row("b", "ccdeck-pro", 30_000)]))
      .toEqual({ a: started(5 * MIN), b: started(30_000) });
    expect(started(5 * MIN)).toMatch(/^Started \d\d\D\d\d/);
  });

  it("does not change while you look at it", () => {
    const rows = [row("a", "api", 5 * MIN), row("b", "api", 75 * MIN)];
    expect(tellsOf(rows, NOW + 40 * MIN)).toEqual(tellsOf(rows));
  });

  it("leads with the weekday for a start on an earlier day, so it is not today's same minute", () => {
    const day = 24 * 60 * MIN;
    const yesterday = new Date(NOW - day);
    const lang = currentLanguage();
    const time = yesterday.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    expect(tellsOf([row("a", "api", day), row("b", "api", 0)]))
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

  // CHANGED ON PURPOSE (owner 2026-11-10): rail rows show the session's name
  it("four rows of one name: each takes the first step that tells it from the rest, folder, clock, id", () => {
    const rows = [
      row("s1-0000-a1a1", "ccdeck v4", 10 * MIN, "ccdeck-site"),
      row("s2-0000-b2b2", "ccdeck v4", 120 * MIN, "ccdeck-pro"),
      row("s3-0000-c3c3", "ccdeck v4", 3 * MIN, "ccdeck-pro"),
      row("s4-0000-d4d4", "ccdeck v4", 3 * MIN, "ccdeck-pro"),
      row("s5-0000-e5e5", "docs", 3 * MIN),
    ];
    const tells = rowTells(rows, NOW);
    expect(Object.fromEntries([...tells].map(([id, tell]) => [id, [tell.kind, tell.text]]))).toEqual({
      "s1-0000-a1a1": ["folder", "ccdeck-site"],
      "s2-0000-b2b2": ["started", started(120 * MIN)],
      "s3-0000-c3c3": ["id", "c3c3"],
      "s4-0000-d4d4": ["id", "d4d4"],
    });
    expect(tells.has("s5-0000-e5e5")).toBe(false);
  });

  // CHANGED ON PURPOSE (owner 2026-11-10): rail rows show the session's name
  it("four rows sharing a folder: a start that is theirs alone, else the id", () => {
    const rows = [
      row("t1-0000-a1a1", "loroloop", 10 * MIN, "Desktop"),
      row("t2-0000-b2b2", "loroloop", 40 * MIN, "Desktop"),
      row("t3-0000-c3c3", "loroloop", 40 * MIN, "Desktop"),
      row("t4-0000-d4d4", "loroloop", 10 * MIN, "constantin"),
    ];
    // t4's folder is its own, so its start is not held against t1's.
    expect(tellsOf(rows)).toEqual({
      "t1-0000-a1a1": started(10 * MIN),
      "t2-0000-b2b2": "b2b2",
      "t3-0000-c3c3": "c3c3",
      "t4-0000-d4d4": "constantin",
    });
  });

  it("four unnamed rows in one repo: what each was asked to do, else the clock, else the id", () => {
    const rows = [
      row("u1-0000-a1a1", "api", 10 * MIN, undefined, "Fix login"),
      row("u2-0000-b2b2", "api", 40 * MIN, undefined, "Add tests"),
      row("u3-0000-c3c3", "api", 10 * MIN, undefined, "Add tests"),
      row("u4-0000-d4d4", "api", 40 * MIN, undefined, "Add tests"),
      row("u5-0000-e5e5", "api", 3 * MIN),
    ];
    // u1's prompt is its own; u3's start is no longer held against u1's, which
    // its prompt already told apart; u5 was never asked anything.
    expect(Object.fromEntries([...rowTells(rows, NOW)].map(([id, tell]) => [id, [tell.kind, tell.text]]))).toEqual({
      "u1-0000-a1a1": ["task", "Fix login"],
      "u2-0000-b2b2": ["id", "b2b2"],
      "u3-0000-c3c3": ["started", started(10 * MIN)],
      "u4-0000-d4d4": ["id", "d4d4"],
      "u5-0000-e5e5": ["started", started(3 * MIN)],
    });
  });

  it("is worded in every language, with the time in it, and the relative wording is gone", () => {
    for (const l of LANGUAGES) {
      expect(l.catalog["board.row.startedAt"], l.code).toContain("{time}");
      expect(l.catalog, l.code).not.toHaveProperty(["board.row.startedAgo"]);
      expect(l.catalog["board.row.inFolder"], l.code).toContain("{folder}");
    }
    expect(LANGUAGES.find(l => l.code === "ro")!.catalog["board.row.startedAt"]).toBe("Pornită la {time}");
    expect(LANGUAGES.find(l => l.code === "ro")!.catalog["board.row.inFolder"]).toBe("În {folder}");
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
/** What the server sends off the transcript: the user's name (else Claude Code's) and the title. */
const named = (s: GraphState, sid: string, at: number, sessionName: string | null, sessionTitle: string | null = null) =>
  send(s, sid, { hook_event_name: "SessionNamed", sessionName, sessionTitle } as HookPayload, at);
const draw = (s: GraphState, now: number) => renderToStaticMarkup(createElement(SessionList, {
  state: s, now, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
}));
/** The markup of one row's button. */
const button = (html: string, sid: string) =>
  [...html.matchAll(/<button[^>]*data-session="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)].find(m => m[1] === sid)?.[0] ?? "";
const byId = (rows: Row[]) => Object.fromEntries(rows.map(r => [r.sessionId, r]));

beforeEach(() => { seq = 0; resetSessionsSeen(); });

describe("the rail row's title", () => {
  it("is the session's name, else Claude Code's title, else the folder", () => {
    let s = initialState();
    s = begin(s, "named", "/home/me/Desktop", 0, "go");
    s = named(s, "named", 10, "loroloop", "Fix the login page");
    s = begin(s, "titled", "/home/me/constantin", 0, "go");
    s = named(s, "titled", 10, null, "Add Codex accounts");
    s = begin(s, "plain", "/home/me/api", 0, "Make the phone rows tellable apart");
    const rows = byId(buildRows(s, NOW + MIN));
    expect([rows.named.label, rows.named.folder]).toEqual(["loroloop", "Desktop"]);
    expect([rows.titled.label, rows.titled.folder]).toEqual(["Add Codex accounts", "constantin"]);
    // Neither: the folder, and the first prompt is never the title.
    expect([rows.plain.label, rows.plain.folder]).toEqual(["api", undefined]);
    expect(rows.plain.tell).toBeUndefined();
  });

  it("follows a rename, the newest name being the current one", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/Desktop", 0, "go");
    s = named(s, "one", 10, "loroloop");
    expect(buildRows(s, NOW + MIN)[0].label).toBe("loroloop");
    s = named(s, "one", 20, "ccdeck v4");
    expect(buildRows(s, NOW + MIN)[0].label).toBe("ccdeck v4");
  });

  it("does not lead with a folder that only says the name again", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/ccdeck-pro", 0, "go");
    s = named(s, "one", 10, "CCDeck-Pro");
    const r = buildRows(s, NOW + MIN)[0];
    expect(r.label).toBe("CCDeck-Pro");
    expect(r.folder).toBeUndefined();
    expect(r.tell).toBeUndefined();
  });
});

describe("the rail draws the lead", () => {
  it("leads the second line with the folder under a name, and the name keeps the first line whole", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/Desktop", 0, "Fix the phone rows");
    s = named(s, "one", 10, "loroloop");
    s = stop(s, "one", 1_000);
    s = begin(s, "two", "/home/me/constantin", 0, "Add Codex accounts");
    s = named(s, "two", 10, "ccdeck v4");
    s = send(s, "two", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: "/home/me/constantin/src/a.ts" } }, 2_000);
    const html = draw(s, NOW + 10 * MIN);
    const one = button(html, "one");
    const two = button(html, "two");
    expect(one).toContain('<span class="sl-label">loroloop</span>');
    // Alone, the folder is the line, in the UI face, and the row is two lines.
    expect(one).toMatch(/<span class="sl-line2 sans"><span class="sl-tell words">Desktop<\/span><\/span>/);
    expect(one).not.toContain("data-one-line");
    // Ahead of a live line it is the lead, and the tool still follows it. The
    // line is mono (a tool), and the folder keeps the UI face: mono is for
    // figures and ids (the owner's point 8).
    expect(two).toContain('<span class="sl-label">ccdeck v4</span>');
    expect(two).toMatch(/<span class="sl-line2 mono"><span class="sl-tell words lead">constantin<\/span> · <b class="sl-tool">Edit<\/b> · src\/a\.ts/);
  });

  it("tells two sessions of one name apart by folder, and by the clock where the folder is the same", () => {
    let s = initialState();
    s = begin(s, "pro", "/home/me/ccdeck-pro", 0, "go");
    s = named(s, "pro", 10, "ccdeck v4");
    s = stop(s, "pro", 1_000);
    s = begin(s, "site", "/home/me/ccdeck-site", 0, "go");
    s = named(s, "site", 10, "ccdeck v4");
    s = stop(s, "site", 1_000);
    let rows = byId(buildRows(s, NOW + 10 * MIN));
    expect(rows.pro.tell).toEqual({ kind: "folder", text: "ccdeck-pro" });
    expect(rows.site.tell).toEqual({ kind: "folder", text: "ccdeck-site" });

    let t = initialState();
    t = begin(t, "early", "/home/me/Desktop", -40 * MIN, "go");
    t = named(t, "early", -40 * MIN + 10, "loroloop");
    t = stop(t, "early", -39 * MIN);
    t = begin(t, "late", "/home/me/Desktop", -5 * MIN, "go");
    t = named(t, "late", -5 * MIN + 10, "loroloop");
    t = stop(t, "late", -4 * MIN);
    rows = byId(buildRows(t, NOW));
    expect(rows.early.tell).toEqual({ kind: "started", text: started(40 * MIN) });
    expect(rows.late.tell).toEqual({ kind: "started", text: started(5 * MIN) });
    // The folder the line no longer draws is still said, and in the tooltip.
    expect(rowSpoken(rows.early)).toContain("In Desktop");
    expect(rowTooltip(rows.early, false).split("\n").slice(0, 2)).toEqual(["Focus loroloop", "In Desktop"]);
    const html = draw(t, NOW);
    expect(button(html, "early")).toMatch(/<span class="sl-line2 sans"><span class="sl-tell words">Started /);
  });

  it("says the folder once to a screen reader where the line draws it, and leaves a folder-titled row as it was", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/Desktop", 0, "go");
    s = named(s, "one", 10, "loroloop");
    s = begin(s, "two", "/home/me/api", 0, "go");
    const rows = byId(buildRows(s, NOW + MIN));
    expect(rowSpoken(rows.one)).not.toContain("Desktop");
    expect(rowTooltip(rows.one, false)).toContain("In Desktop");
    expect(rowTooltip(rows.two, false).split("\n")[0]).toBe("Focus api");
    expect(rowTooltip(rows.two, false)).not.toContain("In api");
    expect(rowTooltip(rows.one, true).split("\n")[0]).toBe("Bring loroloop back to the board");
  });

  // CHANGED ON PURPOSE (owner 2026-11-10): rail rows show the session's name
  // CHANGED ON PURPOSE (owner 2026-11-10): unnamed rows in one folder read by their first prompt, not an id
  it("tells unnamed rows in one folder apart by what each was asked, and draws the prompt once", () => {
    let s = initialState();
    s = begin(s, "one-0000-aaaa", "/home/me/api", 0, "Fix login");
    s = begin(s, "two-0000-bbbb", "/home/me/api", 0, "Fix logout");
    s = begin(s, "three-000-cccc", "/home/me/api", 0, "api");
    const rows = byId(buildRows(s, NOW + MIN));
    const one = rows["one-0000-aaaa"];
    // The running turn's note is the prompt that started it (session-note.ts).
    expect(railLine(one, 1)).toEqual({ kind: "mono", text: "Fix login" });
    expect(one.tell).toEqual({ kind: "task", text: "Fix login" });
    expect(rows["two-0000-bbbb"].tell).toEqual({ kind: "task", text: "Fix logout" });
    // A prompt that only says the title again is no tell.
    expect(rows["three-000-cccc"].task).toBeUndefined();
    expect(rows["three-000-cccc"].tell?.kind).toBe("started");
    // The live line only said the prompt again, so it is left out: the prompt
    // is drawn once, as words, in the interface's face.
    const b = button(draw(s, NOW + MIN), "one-0000-aaaa");
    expect(b.slice(b.indexOf('class="sl-line2'))).toMatch(/^class="sl-line2 sans"><span class="sl-tell words">Fix login<\/span><\/span>/);
    // A line that only says the lead again is left out; one that says more is kept.
    expect(lineAfterTell({ kind: "mono", text: "Desktop" }, { kind: "folder", text: "Desktop" })).toBeNull();
    expect(lineAfterTell({ kind: "mono", text: "Fix the login form…" }, { kind: "folder", text: "Fix the login form and its tests" })).toBeNull();
    expect(lineAfterTell({ kind: "mono", text: "Fix login and the tests" }, { kind: "folder", text: "Fix login" }))
      .toEqual({ kind: "mono", text: "Fix login and the tests" });
    expect(lineAfterTell({ kind: "tool", name: "Edit", rest: "a.ts" }, { kind: "folder", text: "Edit" }))
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
    s = begin(s, "named", "/home/me/docs", 0, "go");
    s = named(s, "named", 10, "loroloop");
    s = stop(s, "named", 1_000);
    const html = draw(s, NOW + MIN);
    expect(button(html, "quiet")).toContain('data-one-line="true"');
    expect(button(html, "quiet")).not.toContain("sl-line2");
    // A session not yet prompted says Ready on its second line: two lines.
    expect(button(html, "fresh")).not.toContain("data-one-line");
    expect(button(html, "fresh")).toContain("sl-line2");
    // A named session keeps its folder under the name: two lines.
    expect(button(html, "named")).not.toContain("data-one-line");
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
