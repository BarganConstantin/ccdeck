// What a session is called, one rule for every surface that names it (owner's
// critique, 2026-11-11, point 2): the board's pill and hover card, the
// navigator's tile, the Sessions list, the Inspector's head, the command menu
// and the stage. One session read "CCDECK · 2886" on the board, "ccdeck" over
// "7d4a" in the list and "ccdeck · 2886" under a floating "retention job" in
// the navigator.
//
// CHANGED ON PURPOSE (owner's critique, 2026-11-11): the row's second line led
// with one quiet "tell" (the folder, the first prompt, the clock time it
// started or a piece of its id) chosen to tell rows of one name apart. It is
// "folder · task" now (rail-row-copy.ts railLine), the task being what a person
// last asked, and when it started with its id's tail is in the row's tooltip.
// The list is for triage, so a row waiting on you still says what it waits on,
// and a row never given a prompt says Ready. A row with no second line is
// still 44 on a phone, the touch floor, where a two-line row stays 62.
//
// And point 6: a background task's notice arrives on the hook a person's
// typing does (injected-prompt.ts). It is never the task.
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList, { buildRows, type Row } from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
import { resetSessionsSeen } from "../session-seen";
import { namesLine, railLine, rowSpoken, rowTooltip, sessionNames, sessionTask, startedHover, startedLine } from "../rail-row-copy";
import { waitingSentence } from "../agent-copy";
import type { WaitingBlock } from "../types";
import { LANGUAGES } from "../i18n/registry";
import { currentLanguage } from "../i18n";
import { sheetRules } from "./sheet-cascade";

/** 15:00:30 today, by this machine's clock: the hover says a clock time. */
const NOW = new Date(2026, 10, 10, 15, 0, 30).getTime();
const MIN = 60_000;
const PHONE = "(max-width: 640px)";

const NOTICE = [
  "<task-notification>",
  "<task-id>b055gq9k8</task-id>",
  "<status>completed</status>",
  '<summary>Background command "Watch CI" completed (exit code 0)</summary>',
  "</task-notification>",
].join("\n");

/** A root's naming fields, as the reducer leaves them. */
const agent = (o: Partial<AgentNodeData>) =>
  ({ label: "api", cwdBasename: "api", prompts: [], ...o }) as Pick<AgentNodeData, "label" | "cwdBasename" | "sessionName" | "sessionTitle" | "prompts" | "firstPrompt">;

/** "Started 14:55": the hour and minute, `ago` before NOW, in the reader's language. */
const started = (ago: number) =>
  `Started ${new Date(NOW - ago).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit" })}`;

describe("what a session is called", () => {
  it("is its name, else Claude Code's title, else its folder; the folder too only when the title is something else", () => {
    expect(sessionNames(agent({ sessionName: "loroloop", sessionTitle: "Fix the login page", cwdBasename: "Desktop", label: "Desktop" })))
      .toEqual({ title: "loroloop", folder: "Desktop" });
    expect(sessionNames(agent({ sessionTitle: "Add Codex accounts", cwdBasename: "constantin", label: "constantin" })))
      .toEqual({ title: "Add Codex accounts", folder: "constantin" });
    expect(sessionNames(agent({}))).toEqual({ title: "api" });
    // A name that only says the folder again, case and spaces aside, is said once.
    expect(sessionNames(agent({ sessionName: "API ", label: "api" }))).toEqual({ title: "API" });
  });

  it("takes as its task what a person last asked, one line of it, and never the title again", () => {
    const prompts = [{ at: 1, text: "Fix login" }, { at: 3, text: "Now the logout\nand its tests" }, { at: 2, text: "between" }];
    expect(sessionNames(agent({ prompts, firstPrompt: "Fix login" }))).toEqual({ title: "api", task: "Now the logout" });
    // Before the prompts list holds anything, the first prompt the deck kept.
    expect(sessionTask({ prompts: [], firstPrompt: "Fix login" })).toBe("Fix login");
    expect(sessionNames(agent({ prompts: [{ at: 1, text: "api" }] }))).toEqual({ title: "api" });
  });

  it("reads the prompt before a background task's notice, and has no task under notices alone", () => {
    const prompts = [{ at: 1, text: "Fix login" }, { at: 2, text: NOTICE }];
    expect(sessionTask({ prompts, firstPrompt: "Fix login" })).toBe("Fix login");
    expect(sessionTask({ prompts: [{ at: 2, text: NOTICE }], firstPrompt: NOTICE })).toBe("");
    expect(sessionNames(agent({ prompts: [{ at: 2, text: NOTICE }] }))).toEqual({ title: "api" });
  });

  it("draws folder · task on the second line, the task alone under a title that is the folder, nothing before anything was asked", () => {
    expect(namesLine({ title: "loroloop", folder: "Desktop", task: "Fix login" })).toBe("Desktop · Fix login");
    expect(namesLine({ title: "api", task: "Fix login" })).toBe("Fix login");
    expect(namesLine({ title: "loroloop", folder: "Desktop" })).toBe("Desktop");
    expect(namesLine({ title: "api" })).toBe("");
  });
});

describe("what tells two sessions of one name apart, kept for the hover", () => {
  it("says when it started, by the reader's clock, and the tail of its id", () => {
    expect(startedHover(NOW - 5 * MIN, "6f1c2a9e-1d2b-4c3d-8e4f-00000000a1b2", [], NOW)).toBe(`${started(5 * MIN)} · a1b2`);
    expect(started(5 * MIN)).toMatch(/^Started \d\d\D\d\d/);
  });

  it("grows the tail until the ids differ", () => {
    expect(startedHover(NOW, "aaaa-1111abcd", ["bbbb-2222abcd"], NOW)).toMatch(/ · 1abcd$/);
  });

  it("does not change while you look at it", () => {
    expect(startedHover(NOW - 5 * MIN, "s-a1b2", [], NOW + 40 * MIN)).toBe(startedHover(NOW - 5 * MIN, "s-a1b2", [], NOW));
  });

  it("leads with the weekday for a start on an earlier day, so it is not today's same minute", () => {
    const day = 24 * 60 * MIN;
    const yesterday = new Date(NOW - day);
    const lang = currentLanguage();
    const time = yesterday.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    expect(startedLine(NOW - day, "a1b2", NOW)).toBe(`Started ${yesterday.toLocaleDateString(lang, { weekday: "short" })} ${time} · a1b2`);
  });

  it("is worded in every language, with the time in it", () => {
    for (const l of LANGUAGES) {
      expect(l.catalog["board.row.startedAt"], l.code).toContain("{time}");
      expect(l.catalog, l.code).not.toHaveProperty(["board.row.startedAgo"]);
      expect(l.catalog, l.code).not.toHaveProperty(["board.row.started"]);
      expect(l.catalog["board.row.inFolder"], l.code).toContain("{folder}");
      expect(l.catalog["board.row.blockedSince"], l.code).not.toContain("{started}");
      expect(l.catalog["board.row.yourTurnSince"], l.code).not.toContain("{started}");
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
const ask = (s: GraphState, sid: string, at: number, prompt: string) =>
  send(s, sid, { hook_event_name: "UserPromptSubmit", prompt } as HookPayload, at);
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
/** The text of a row's second line, tags stripped. */
const line2 = (b: string) => /<span class="sl-line2">([\s\S]*?)<\/span>(?=<\/span>)/.exec(b)?.[1].replace(/<[^>]+>/g, "") ?? null;
const byId = (rows: Row[]) => Object.fromEntries(rows.map(r => [r.sessionId, r]));

beforeEach(() => { seq = 0; resetSessionsSeen(); });

describe("the rail row", () => {
  it("is titled by the session's name, else Claude Code's title, else the folder", () => {
    let s = initialState();
    s = begin(s, "named", "/home/me/Desktop", 0, "go on");
    s = named(s, "named", 10, "loroloop", "Fix the login page");
    s = begin(s, "titled", "/home/me/constantin", 0, "go on");
    s = named(s, "titled", 10, null, "Add Codex accounts");
    s = begin(s, "plain", "/home/me/api", 0, "Make the phone rows tellable apart");
    const rows = byId(buildRows(s, NOW + MIN));
    expect([rows.named.label, rows.named.folder, rows.named.task]).toEqual(["loroloop", "Desktop", "go on"]);
    expect([rows.titled.label, rows.titled.folder]).toEqual(["Add Codex accounts", "constantin"]);
    // Neither: the folder, and the prompt is the task, never the title.
    expect([rows.plain.label, rows.plain.folder, rows.plain.task]).toEqual(["api", undefined, "Make the phone rows tellable apart"]);
  });

  it("follows a rename, the newest name being the current one", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/Desktop", 0, "go");
    s = named(s, "one", 10, "loroloop");
    expect(buildRows(s, NOW + MIN)[0].label).toBe("loroloop");
    s = named(s, "one", 20, "ccdeck v4");
    expect(buildRows(s, NOW + MIN)[0].label).toBe("ccdeck v4");
  });

  it("draws folder · task under its title, and neither the start time nor the id", () => {
    let s = initialState();
    s = begin(s, "one-0000-aaaa", "/home/me/Desktop", 0, "Fix the phone rows");
    s = named(s, "one-0000-aaaa", 10, "loroloop");
    s = stop(s, "one-0000-aaaa", 1_000);
    s = begin(s, "two-0000-bbbb", "/home/me/api", 0, "Fix logout");
    s = send(s, "two-0000-bbbb", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: "/home/me/api/src/a.ts" } }, 2_000);
    const html = draw(s, NOW + 10 * MIN);
    const one = button(html, "one-0000-aaaa");
    const two = button(html, "two-0000-bbbb");
    expect(one).toContain('<span class="sl-label">loroloop</span>');
    expect(line2(one)).toBe("Desktop · Fix the phone rows");
    // A title that is the folder: the task alone, and the running call is the tooltip's.
    expect(two).toContain('<span class="sl-label">api</span>');
    expect(line2(two)).toBe("Fix logout");
    for (const b of [one, two]) {
      expect(b).not.toMatch(/sl-tell|sl-tool|sl-line2 mono/);
      expect(line2(b)).not.toMatch(/Started|aaaa|bbbb/);
    }
    expect(two).toMatch(/title="[^"]*Edit · [^"]*src\/a\.ts/);
  });

  it("keeps when it started and its id's tail in the tooltip, as long a tail as the board needs", () => {
    let s = initialState();
    s = begin(s, "aaaa-1111abcd", "/home/me/api", 0, "go");
    s = begin(s, "bbbb-2222abcd", "/home/me/api", 0, "go");
    const rows = byId(buildRows(s, NOW + MIN));
    const tip = rowTooltip(rows["aaaa-1111abcd"], false).split("\n");
    expect(tip[0]).toBe("Focus api");
    expect(tip).toContain(`${started(0)} · 1abcd`);
    expect(rowTooltip(rows["bbbb-2222abcd"], false)).toContain(" · 2abcd");
  });

  it("says the folder in the tooltip, and leaves a folder-titled row without it", () => {
    let s = initialState();
    s = begin(s, "one", "/home/me/Desktop", 0, "go");
    s = named(s, "one", 10, "loroloop");
    s = begin(s, "two", "/home/me/api", 0, "go");
    const rows = byId(buildRows(s, NOW + MIN));
    expect(rowTooltip(rows.one, false).split("\n").slice(0, 2)).toEqual(["Focus loroloop", "In Desktop"]);
    expect(rowTooltip(rows.two, false)).not.toContain("In api");
    expect(rowTooltip(rows.one, true).split("\n")[0]).toBe("Bring loroloop back to the board");
    expect(rowSpoken(rows.one)).not.toContain("Desktop");
  });

  it("reads the prompt before a background task's notice, and draws one line under notices alone", () => {
    let s = initialState();
    s = begin(s, "asked", "/home/me/api", 0, "Fix login");
    s = ask(s, "asked", 5_000, NOTICE);
    s = begin(s, "noticed", "/home/me/web", 0);
    s = ask(s, "noticed", 5_000, NOTICE);
    const rows = byId(buildRows(s, NOW + MIN));
    expect(rows.asked.task).toBe("Fix login");
    expect(rows.noticed.task).toBeUndefined();
    const html = draw(s, NOW + MIN);
    expect(line2(button(html, "asked"))).toBe("Fix login");
    expect(button(html, "noticed")).not.toContain("sl-line2");
    expect(html).not.toContain("task-notification");
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
    s = begin(s, "quiet", "/home/me/api", 0, "api");
    s = stop(s, "quiet", 1_000);
    s = begin(s, "fresh", "/home/me/web", 0);
    s = begin(s, "named", "/home/me/docs", 0, "go");
    s = named(s, "named", 10, "loroloop");
    s = stop(s, "named", 1_000);
    const html = draw(s, NOW + MIN);
    // Its only prompt says the title again: nothing to draw under it.
    expect(button(html, "quiet")).toContain('data-one-line="true"');
    expect(button(html, "quiet")).not.toContain("sl-line2");
    // Never asked anything: it says Ready, so it keeps its second line.
    expect(line2(button(html, "fresh"))).toBe("Ready for a first prompt");
    expect(button(html, "fresh")).not.toContain("data-one-line");
    // A named session keeps its folder under the name: two lines.
    expect(button(html, "named")).not.toContain("data-one-line");
  });

  it("sets words in the interface's own face, and only a blocked tool's line in mono", () => {
    expect(decl(".session-list .sl-line2", "font-family", null)).toBeUndefined();
    expect(decl(".session-list .sl-line2.mono", "font-family", null)).toBe("var(--font-mono)");
    expect(rules.some(r => r.selectors.some(s => /\.sl-tell/.test(s)))).toBe(false);
  });
});

describe("a row waiting on you says what it waits on", () => {
  const base: Row = { sessionId: "s", label: "api", state: "active", toolCount: 3, cost: 0, startedAt: 0, lastActivity: 0, plan: null, planTitle: "", task: "Fix login" };
  const waiting = (w: Partial<WaitingBlock>): Row => ({ ...base, cwd: "/home/me/api", waiting: { kind: "permission", since: 1, message: "Claude needs your permission to use Bash", ...w } as WaitingBlock });

  it("says the question an asking session put to you", () => {
    const r = waiting({ kind: "asked", message: "Which database should I use?" });
    expect(railLine(r, 0)).toEqual({ kind: "words", text: `Asks · ${waitingSentence(r.waiting!)}` });
  });

  it("names the blocked tool and what it works on, a path as the row has room for it", () => {
    expect(railLine(waiting({ tool: { name: "Bash", preview: "rm -rf build" } }), 0)).toEqual({ kind: "tool", name: "Bash", rest: "rm -rf build" });
    expect(railLine(waiting({ tool: { name: "Edit", preview: "/home/me/api/src/a.ts", path: true } }), 0)).toEqual({ kind: "tool", name: "Edit", rest: "src/a.ts" });
  });

  it("says the waiting sentence when no tool is known", () => {
    const r = waiting({});
    expect(railLine(r, 0)).toEqual({ kind: "words", text: waitingSentence(r.waiting!) });
  });

  it("reads folder · task in every other group, and Ready before a first prompt", () => {
    expect(railLine({ ...waiting({ kind: "idle", message: "Claude is waiting for your input" }), folder: "Desktop" }, 3)).toEqual({ kind: "words", text: "Desktop · Fix login" });
    expect(railLine({ ...base, task: undefined, neverPrompted: true }, 4)).toEqual({ kind: "words", text: "Ready for a first prompt" });
    expect(railLine({ ...base, task: undefined, neverPrompted: true, folder: "Desktop" }, 4)).toEqual({ kind: "words", text: "Desktop · Ready for a first prompt" });
    expect(railLine({ ...base, task: undefined }, 3)).toBeNull();
  });

  it("keeps when it started and its id's tail in the hover of a waiting row", () => {
    const r = { ...waiting({ tool: { name: "Bash", preview: "rm -rf build" } }), hover: "Started 14:32 · 4efa" };
    expect(rowTooltip(r, false).split("\n")).toContain("Started 14:32 · 4efa");
  });
});
