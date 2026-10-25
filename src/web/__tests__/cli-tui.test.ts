// `ccdeck tui`: the accounts and the sessions waiting on you, on one screen
// that stays up, for somebody on the machine over SSH.
//
// What is pinned here, in the order it can go wrong:
//
//   the frame     exactly as many rows as the screen, none of them reaching its
//                 last column, at every width, in every colour tier and in the
//                 ASCII one, and not one escape under NO_COLOR; the panels, the
//                 lit row, what gives way on a short screen, the selection
//                 always on it;
//   the keys      which key asks for what, and the refusals a switch is told
//                 before it is asked for, in `ccdeck switch`'s words;
//   the sign-in   the deck's stages, the link drawn whole for a terminal to
//                 wrap, the code's field, and which way out lets go of the
//                 deck's sign-in;
//   the screen    only the rows that changed are written, and the terminal is
//                 handed back whole, however many times it is asked;
//   the loop      a fake terminal and a fake deck: the switch goes THROUGH the
//                 deck with the slot chosen, Auto-switch is the deck's own POST,
//                 an account is added with a pasted code, q puts the terminal
//                 back — the sign-in let go of first — and a pipe or `--json`
//                 is refused.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { parseArgs, isOneShot } = await import("../../server/args.mjs");
// @ts-expect-error — plain .mjs module, no types
const view = await import("../../server/tui-view.mjs");
// @ts-expect-error — plain .mjs module, no types
const { createScreen, framesHeld, ALT_SCREEN_ON, ALT_SCREEN_OFF, SYNC_ON, WRAP_ON, WRAP_OFF } = await import("../../server/tui-screen.mjs");
// @ts-expect-error — plain .mjs module, no types
const { fitPainted, sliceCells, textWidth } = await import("../../server/cli-lines.mjs");
// @ts-expect-error — plain .mjs module, no types
const { glyphs, palette, stripAnsi, CURSOR_SHOW } = await import("../../server/term.mjs");
// @ts-expect-error — plain .js module, no types
const { runTui } = await import("../../../bin/cli/tui.js");

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));

type Row = Record<string, unknown>;
type State = Record<string, unknown>;
const NOW = 1_800_000_000_000;
const lane = (id: string, label: string, pct: number, resetAt: number | null = null) => ({ id, label, pct, resetAt });
function row(num: number, email: string, alias: string | null, over: Row = {}): Row {
  return {
    num, email, alias, org: null, orgUuid: `org-${num}`, alive: true, active: false, disabled: false,
    lanes: [lane("five_hour", "5h", 10 * num, NOW / 1000 + 3600), lane("seven_day", "7d", 20 + num, NOW / 1000 + 86_400)],
    headroom: 90 - 10 * num, fetchedAt: NOW - 60_000, stale: false, error: null, staleCopy: false, stopped: false,
    ...over,
  };
}
const ROWS = [
  row(1, "alice@corp.example", "work", { active: true }),
  row(2, "bob@home.example", "home"),
  row(3, "carol@side.example", null, { error: "invalid_grant" }),
  row(4, "dan@x.example", null, { disabled: true }),
];
const SESSIONS = [
  { id: "a", name: "api-refactor", provider: "claude", model: "claude-opus-4-1-20250805", state: "waiting", since: NOW - 180_000,
    waiting: { kind: "permission", message: "Claude needs your permission to use Bash", tool: "Bash" } },
  { id: "b", name: "docs", provider: "codex", state: "waiting", since: NOW - 720_000, waiting: { kind: "asked", message: "Which branch?" } },
  { id: "c", name: "web", provider: "claude", state: "working", since: NOW - 20_000 },
];
const AUTO = {
  ok: true, enabled: true, external: false, lastTick: null,
  settings: { "autoswitch.threshold": { value: 90 } },
  choice: { next: "room", home: { email: "bob@home.example", orgUuid: "org-2" } },
};

// What `claude auth login` prints, as the deck reports it (cswap-admin.test.ts).
const LOGIN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ipcF4hM7&state=dSuby3fi";
const WAITING_CODE = { state: "awaiting_code", url: LOGIN_URL, error: null, account: null, expiresAt: NOW + 280_000, step: null, restored: true, activeAccount: null };

const tone = palette("ansi16");
const plainTone = palette("none");
const U = glyphs(true);
const A = glyphs(false);
const PROFILES = ["truecolor", "ansi256", "ansi16", "none"];

function deckState(over: State = {}): State {
  const s = { ...view.initialState(), deck: { port: 4317, version: "3.46.0" }, source: "deck", auto: AUTO, sessions: SESSIONS, readAt: NOW - 2_000 };
  return { ...view.withRoster(s, { ok: true, activeNum: 1, accounts: ROWS }), ...over };
}
const frame = (s: State, columns = 80, rows = 24, unicode = true, profile = unicode ? "ansi16" : "none", links = false) =>
  view.tuiFrame(s, { columns, rows, tone: palette(profile), g: unicode ? U : A, unicode, now: NOW, profile, links });
/** The sign-in page once the deck answered its start with `login`. */
function signingIn(login: Row, over: State = {}, email: string | null = null): State {
  const s = { ...deckState(), signin: { ...view.openSignin(email), started: true, lastLive: "link" } };
  return { ...view.withLogin(s, login), ...over };
}
const text = (lines: string[]) => lines.map((l: string) => stripAnsi(l));
/** A panel row's inside: the borders and the padding off. */
const inside = (l: string) => l.replace(/^[│|] /, "").replace(/ *[│|]$/, "");

describe("the frame", () => {
  const states: [string, State][] = [
    ["a deck", deckState()],
    ["help", deckState({ help: true })],
    ["no deck", deckState({ deck: null, source: "local", auto: null, sessions: null })],
    ["nothing read yet", { ...view.initialState() }],
    ["a long notice", deckState({ notice: view.note("err", "x".repeat(300), NOW) })],
    ["many accounts", { ...deckState(), ...view.withRoster(deckState(), { ok: true, accounts: Array.from({ length: 14 }, (_, i) => row(i + 1, `user${i + 1}@a-rather-long-domain.example`, `alias-${i + 1}`)) }) }],
    ["an account with trouble selected", deckState({ at: 2, sessions: [] })],
    ["the sign-in's first page", { ...deckState(), signin: view.openSignin("carol@side.example") }],
    ["the sign-in waiting for the code", signingIn({ ...WAITING_CODE, error: "that code was not accepted — copy it again from the browser" })],
    ["the sign-in saving", signingIn({ ...WAITING_CODE, state: "registering", step: "save" })],
    ["a sign-in that failed", signingIn({ ...WAITING_CODE, state: "failed", error: "y".repeat(300) })],
    ["a sign-in done", signingIn({ state: "done", account: { num: 5, email: "eve@new.example", added: true }, restored: false, activeAccount: { num: 3, email: "carol@side.example" } })],
  ];
  for (const [what, s] of states) {
    for (const [columns, rows] of [[40, 12], [64, 16], [80, 24], [104, 30], [120, 32], [160, 50]]) {
      it(`${what} at ${columns}x${rows}: every row is inside the screen, in every colour tier`, () => {
        for (const profile of PROFILES) {
          for (const unicode of [true, false]) {
            const { lines, run } = frame(s, columns, rows, unicode, profile);
            expect(lines).toHaveLength(rows);
            // The link's rows alone reach the last column: the terminal wraps them.
            const inRun = (i: number) => run != null && i >= run.row && i < run.row + run.rows;
            lines.forEach((line: string, i: number) => expect(textWidth(line)).toBeLessThan(inRun(i) ? columns + 1 : columns));
            if (run) {
              expect(run.row + run.rows).toBeLessThanOrEqual(rows - 2);
              expect(stripAnsi(run.text)).toBe(text(lines.slice(run.row, run.row + run.rows)).join(""));
            }
            if (!unicode) for (const line of text(lines)) expect(line).toMatch(/^[\x20-\x7e]*$/);
            // NO_COLOR: not one escape, the lit row and the keys included.
            if (profile === "none") for (const line of [...lines, run?.text ?? ""]) expect(line).not.toContain("\x1b");
          }
        }
      });
    }
  }

  it("says so on a screen too small to draw on", () => {
    const { lines } = frame(deckState(), 30, 8);
    expect(lines).toHaveLength(8);
    expect(text(lines)[0]).toBe("too small — 40×12 at least");
  });

  it("puts the screen in panels under a title bar, the last panel reaching the foot", () => {
    const lines = text(frame(deckState()).lines);
    expect(lines[0]).toMatch(/^ {2}ccdeck {2}Claude accounts +● live · deck 4317 {2}$/);
    expect(lines[1]).toMatch(/^╭─ Accounts ─+╮$/);
    expect(lines.some(l => l.startsWith("╭─ #1 alice@corp.example (work) ─"))).toBe(true);
    expect(lines.some(l => /^╭─ Waiting on you · 2 ─+ 1 working ─╮$/.test(l))).toBe(true);
    expect(lines[21]).toMatch(/^╰─+╯$/);
    for (const l of lines.slice(1, 22)) expect(textWidth(l)).toBe(79);
  });

  it("says the deck is live while it answers, and how old the reading is once it does not", () => {
    expect(text(frame(deckState()).lines)[0]).toContain("● live · deck 4317");
    expect(text(frame(deckState({ readAt: NOW - 25_000 })).lines)[0]).toContain("○ read 25s ago · deck 4317");
    expect(text(frame(deckState({ readAt: null })).lines)[0]).toMatch(/accounts +deck 4317 {2}$/);
    expect(text(frame(deckState({ deck: null, source: "local" })).lines)[0]).toContain("no deck · claude-swap's store");
  });

  it("points at the selected account, and marks the live one and the home one", () => {
    const lines = text(frame(deckState({ at: 1 })).lines);
    const bob = inside(lines.find(l => l.includes("bob@home.example") && !l.includes("#2"))!);
    expect(bob).toMatch(/^› {3}2 ⌂ home {2}bob@home\.example/);
    const alice = inside(lines.find(l => l.includes("alice@corp.example") && !l.includes("#1"))!);
    expect(alice).toMatch(/^ {2}● 1 {3}work {2}alice@corp\.example/);
    // The detail is the selected account's, with every lane.
    expect(lines.some(l => /^╭─ #2 bob@home\.example \(home\) ─+ home · read 1m ago ─╮$/.test(l))).toBe(true);
    expect(lines.some(l => /^│ 5h {2}[━╸─]+ +20% {3}resets in 1h/.test(l))).toBe(true);
    // Auto-switch, in the list's bottom border.
    expect(lines.some(l => /^╰─+ Auto-switch on · at 90% · next: most room ─╯$/.test(l))).toBe(true);
  });

  it("says what an account's trouble means for a switch to it", () => {
    const lines = text(frame(deckState({ at: 2 })).lines);
    expect(lines.some(l => inside(l).startsWith("sign-in needed — its login has expired"))).toBe(true);
    const off = text(frame(deckState({ at: 3 })).lines);
    expect(off.some(l => inside(l).startsWith("disabled — kept out of Auto-switch's rotation"))).toBe(true);
  });

  it("lights the selected row across the panel, as far as the terminal's colours reach", () => {
    const lit = (profile: string) => frame(deckState({ at: 1 }), 80, 24, true, profile).lines.find((l: string) => stripAnsi(l).startsWith("│ ›"))!;
    const SELECT = "\x1b[48;2;46;67;110m";
    expect(lit("truecolor")).toContain(SELECT);
    expect(lit("ansi256")).toContain("\x1b[48;5;60m");
    expect(lit("ansi16")).toContain("\x1b[44;97m");
    expect(lit("none")).not.toContain("\x1b");
    // Every reset inside the row puts the light back, so it runs to the border.
    const row = lit("truecolor");
    const parts = row.slice(row.indexOf(SELECT), row.lastIndexOf("│")).split("\x1b[0m");
    for (const part of parts.slice(1, -1)) expect(part.startsWith(SELECT)).toBe(true);
  });

  it("draws the chrome and the keys only where it has the colours for them", () => {
    const deep = frame(deckState(), 80, 24, true, "truecolor").lines;
    expect(deep[0].startsWith("\x1b[48;2;43;45;48m")).toBe(true);
    expect(deep.at(-1)).toContain("\x1b[48;2;57;59;64m\x1b[38;2;223;225;229m enter ");
    // 256 colours take the grey ramp for the chrome, not the cube's first grey.
    expect(frame(deckState(), 80, 24, true, "ansi256").lines[0].startsWith("\x1b[48;5;236m")).toBe(true);
    const sixteen = frame(deckState(), 80, 24, true, "ansi16").lines;
    expect(sixteen[0]).not.toContain("\x1b[48");
    expect(sixteen.at(-1)).toContain("\x1b[7m enter ");
  });

  it("draws a meter as a line to the half cell, its track in text colour alone", () => {
    // 14% of the detail's 40-cell meter is 5.6 cells: five whole and a half.
    const one = [row(1, "a@x.example", null, { active: true, lanes: [lane("five_hour", "5h", 14, NOW / 1000 + 3600)] })];
    const s = view.withRoster(deckState(), { ok: true, accounts: one });
    for (const profile of PROFILES) {
      const lines = frame(s, 80, 24, true, profile).lines;
      expect(text(lines).some(l => l.startsWith(`│ 5h  ━━━━━╸${"─".repeat(34)}  14%`))).toBe(true);
      // No background under a meter: it sits on a light terminal as on a dark one.
      const meterRow = lines.find((l: string) => stripAnsi(l).startsWith("│ 5h  ━"))!;
      expect(meterRow).not.toContain("\x1b[48");
    }
    expect(frame(s, 80, 24, true, "truecolor").lines.join("")).toContain("\x1b[38;2;78;81;88m─");
    expect(text(frame(s, 80, 24, false, "none").lines).some(l => l.startsWith("| 5h  ######......"))).toBe(true);
  });

  it("from 120 columns puts the detail and the waiting sessions side by side", () => {
    const pair = text(frame(deckState(), 120, 32).lines).find(l => l.includes("#1 alice@corp.example") && l.includes("Waiting on you"));
    expect(pair).toMatch(/^╭─ #1 alice@corp\.example \(work\) ─.*╮ ╭─ Waiting on you · 2 ─.*╮$/);
    expect(text(frame(deckState(), 119, 32).lines).some(l => l.includes("#1 alice") && l.includes("Waiting"))).toBe(false);
  });

  it("opens the keys in a box over the screen, the screen under it faded", () => {
    const f = frame(deckState({ help: true }), 80, 24, true, "truecolor").lines;
    const lines = text(f);
    const top = lines.findIndex(l => l.includes("╭─ Keys "));
    const bottom = lines.findIndex(l => l.includes("any key closes ─╯"));
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeGreaterThan(top);
    expect(lines.slice(top, bottom).some(l => l.includes("enter  s   switch to the selected account"))).toBe(true);
    expect(lines.some(l => l.includes("⌂          Auto-switch's home account"))).toBe(true);
    expect(lines[top].indexOf("╭")).toBe(lines[bottom].indexOf("╰"));
    // The screen around it is still there, faded.
    expect(lines[0]).toContain("ccdeck  Claude accounts");
    expect(f[0].startsWith("\x1b[38;2;92;95;102m")).toBe(true);
  });

  it("lists who is waiting longest first, with the question under each", () => {
    const lines = text(frame(deckState()).lines);
    const title = lines.findIndex(l => l.includes("Waiting on you"));
    expect(lines[title]).toMatch(/Waiting on you · 2 ─+ 1 working ─╮$/);
    expect(inside(lines[title + 1])).toMatch(/^⚠ {2}12m {2}docs +Codex$/);
    expect(inside(lines[title + 2]).trim()).toBe("Which branch?");
    expect(inside(lines[title + 2]).indexOf("Which")).toBe(inside(lines[title + 1]).indexOf("docs"));
    expect(inside(lines[title + 3])).toMatch(/^⚠ {3}3m {2}api-refactor +Claude · opus-4-1$/);
    expect(inside(lines[title + 4]).trim()).toBe("Claude needs your permission to use Bash");
  });

  it("says nobody is waiting when nobody is", () => {
    const lines = text(frame(deckState({ sessions: [SESSIONS[2]] })).lines);
    expect(lines.some(l => /^╭─ Sessions ─+ 1 working ─╮$/.test(l))).toBe(true);
    expect(lines.some(l => inside(l) === "nobody is waiting on you")).toBe(true);
  });

  it("gives way on a short screen: the waiting count and the selection stay", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...SESSIONS[0], id: `w${i}`, name: `job-${i}`, since: NOW - i * 1000 }));
    const lines = text(frame(deckState({ sessions: many }), 80, 16).lines);
    expect(lines.some(l => l.includes("Waiting on you · 6"))).toBe(true);
    // The detail went before the accounts did, and its rows went to the waiting.
    expect(lines.some(l => l.includes("read 1m ago"))).toBe(false);
    expect(lines.filter(l => /@/.test(l))).toHaveLength(4);
    expect(lines.some(l => /^╰─ 4 more — ccdeck sessions ─+╯$/.test(l))).toBe(true);
  });

  it("scrolls a long list so the selection is on it, its border saying which rows show", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(i + 1, `user${i + 1}@x.example`, null));
    let s: State = view.withRoster({ ...view.initialState(), deck: { port: 4317 }, auto: AUTO, sessions: [] }, { ok: true, accounts: rows });
    s = { ...s, at: 12 };
    const f = frame(s, 80, 14);
    const lines = text(f.lines);
    expect(lines.find(l => l.startsWith("│ ›"))).toContain("user13@x.example");
    expect(lines.some(l => /^╰─ 8–13 of 14 ─/.test(l))).toBe(true);
    // Moving back up keeps the list where it was until the selection leaves it.
    const back = frame({ ...s, top: f.top, at: 11 }, 80, 14);
    expect(text(back.lines).find(l => l.startsWith("│ ›"))).toContain("user12@x.example");
    expect(back.top).toBe(f.top);
  });

  it("shows why the roster is empty, in the commands' own words", () => {
    const s = view.withRoster({ ...view.initialState(), source: "local" }, { ok: false, reason: "no_cswap" }, ["claude-swap is not installed", "or by hand: pipx install claude-swap"]);
    const lines = text(frame(s).lines);
    expect(inside(lines[2])).toBe("claude-swap is not installed");
    expect(inside(lines[3])).toBe("or by hand: pipx install claude-swap");
  });

  it("keeps the keys that leave and explain on a narrow screen", () => {
    const last = text(frame(deckState(), 40, 12).lines)[11];
    expect(last).toMatch(/\? +keys/);
    expect(last).toMatch(/q +quit/);
    const wide = text(frame(deckState(), 100, 24).lines)[23];
    expect(wide).toMatch(/a +auto-switch/);
    const noDeck = text(frame(deckState({ deck: null, source: "local" }), 100, 24).lines)[23];
    expect(noDeck).toMatch(/d +start the deck/);
  });
});

describe("the keys", () => {
  const key = (s: State, str: string | undefined, k: Row = {}) => view.tuiKey(s, str, { name: str, ...k }, { now: NOW, g: U });

  it("moves, wrapping at both ends, and jumps by slot", () => {
    const s = deckState({ at: 0 });
    expect(key(s, undefined, { name: "up" }).state.at).toBe(3);
    expect(key(s, "j").state.at).toBe(1);
    expect(key(deckState({ at: 3 }), undefined, { name: "down" }).state.at).toBe(0);
    expect(key(s, "3").state.at).toBe(2);
    expect(key(s, "G").state.at).toBe(3);
    expect(key(deckState({ at: 2 }), "g").state.at).toBe(0);
  });

  it("Enter asks for the selected account's switch", () => {
    const { effect } = key(deckState({ at: 1 }), "\r", { name: "return" });
    expect(effect).toEqual({ type: "switch", account: ROWS[1] });
    expect(key(deckState({ at: 1 }), "s").effect?.type).toBe("switch");
  });

  it("answers the switches it can refuse before asking", () => {
    const already = key(deckState({ at: 0 }), "\r", { name: "return" });
    expect(already.effect).toBeNull();
    expect(already.state.notice.text).toBe("already on #1 alice@corp.example (work)");
    // A dead login is not switched to: enter offers its sign-in instead.
    const dead = key(deckState({ at: 2 }), "\r", { name: "return" });
    expect(dead.effect).toBeNull();
    expect(dead.state.signin).toMatchObject({ email: "carol@side.example", started: false });
    const deadNoDeck = key(deckState({ at: 2, deck: null }), "\r", { name: "return" });
    expect(deadNoDeck.state.signin).toBeNull();
    expect(deadNoDeck.state.notice.tone).toBe("err");
    expect(deadNoDeck.state.notice.text).toContain("needs a fresh sign-in");
    expect(deadNoDeck.state.notice.text).toContain("d starts the deck");
    // A disabled slot is somebody's own "keep out of rotation": it switches.
    expect(key(deckState({ at: 3 }), "\r", { name: "return" }).effect?.type).toBe("switch");
    const silent = key(deckState({ at: 1, deck: null, silent: [{ port: 4317 }] }), "\r", { name: "return" });
    expect(silent.effect).toBeNull();
    expect(silent.state.notice.text).toContain("not switching behind its back");
    const busy = key(deckState({ at: 1, busy: { text: "switching to #3", since: NOW } }), "\r", { name: "return" });
    expect(busy.effect).toBeNull();
  });

  it("a turns Auto-switch the other way, through the deck only", () => {
    expect(key(deckState(), "a").effect).toEqual({ type: "auto", enabled: false });
    expect(key(deckState({ auto: { ...AUTO, enabled: false } }), "a").effect).toEqual({ type: "auto", enabled: true });
    const none = key(deckState({ deck: null }), "a");
    expect(none.effect).toBeNull();
    expect(none.state.notice.text).toContain("Auto-switch runs inside the deck");
    // Not while a switch is under way: one change to the login at a time.
    expect(key(deckState({ busy: { text: "switching to #2", since: NOW } }), "a").effect).toBeNull();
  });

  it("b, r and d ask the app; d only with no deck", () => {
    expect(key(deckState(), "b").effect).toEqual({ type: "best" });
    expect(key(deckState(), "r").effect).toEqual({ type: "refresh" });
    expect(key(deckState({ deck: null }), "d").effect).toEqual({ type: "start" });
    expect(key(deckState(), "d").effect).toBeNull();
    expect(key(deckState({ deck: null, starting: true }), "d").effect).toBeNull();
  });

  it("help is a page any key closes; q quits only from the view, Ctrl+C from anywhere", () => {
    const open = key(deckState(), "?").state;
    expect(open.help).toBe(true);
    const q = key(open, "q");
    expect(q.effect).toBeNull();
    expect(q.state.help).toBe(false);
    expect(key(deckState(), "q").effect).toEqual({ type: "quit" });
    expect(key(deckState(), undefined, { name: "escape" }).effect).toEqual({ type: "quit" });
    expect(key(open, "c", { name: "c", ctrl: true }).effect).toEqual({ type: "quit" });
  });

  it("a fresh roster keeps the selection on its account, wherever the list moved it", () => {
    const s = deckState({ at: 1 });
    const moved = view.withRoster(s, { ok: true, accounts: [ROWS[2], ROWS[0], ROWS[1], ROWS[3]] });
    expect(moved.at).toBe(2);
    const first = view.withRoster(view.initialState(), { ok: true, accounts: [ROWS[1], ROWS[0]] });
    expect(first.at).toBe(1);
  });

  it("a notice that worked fades, a failure stays", () => {
    const ok = deckState({ notice: view.note("ok", "switched", NOW) });
    expect(text(view.tuiFrame(ok, { columns: 80, rows: 24, tone, g: U, now: NOW + view.NOTICE_MS + 1 }).lines)[22]).toBe("");
    const err = deckState({ notice: view.note("err", "could not", NOW) });
    expect(text(view.tuiFrame(err, { columns: 80, rows: 24, tone, g: U, now: NOW + 60 * 60_000 }).lines)[22]).toContain("could not");
  });
});

describe("the sign-in", () => {
  const key = (s: State, str: string | undefined, k: Row = {}) => view.tuiKey(s, str, { name: str, ...k }, { now: NOW, g: U });
  const enter = (s: State) => key(s, "\r", { name: "return" });
  const esc = (s: State) => key(s, undefined, { name: "escape" });
  /** The page's words as one text, the borders and the wrapping off. */
  const prose = (lines: string[]) => text(lines).map(l => inside(l).trim()).filter(Boolean).join(" ");

  it("+ opens it, and is refused where no sign-in could end well", () => {
    expect(key(deckState(), "+").state.signin).toMatchObject({ email: null, started: false, code: "" });
    const told = (s: State) => { const r = key(s, "+"); expect(r.state.signin).toBeNull(); return r.state.notice; };
    expect(told(deckState({ deck: null })).text).toBe("accounts are added through the deck — d starts one");
    expect(told(deckState({ busy: { text: "switching to #2", since: NOW } })).text).toContain("one thing at a time");
    const noCswap = view.withRoster(deckState(), { ok: false, reason: "no_cswap" }, ["claude-swap is not installed"]);
    expect(told(noCswap)).toMatchObject({ tone: "err", text: "claude-swap is not installed" });
    // No accounts yet is where the first one comes from.
    const none = view.withRoster(deckState(), { ok: false, reason: "no_accounts" }, ["no accounts yet"]);
    expect(key(none, "+").state.signin).not.toBeNull();
    expect(text(frame(none).lines).some(l => inside(l) === "no Claude accounts yet — + signs one in")).toBe(true);
  });

  it("says what will happen first: enter asks for the link, esc and q go back", () => {
    const s = key(deckState(), "+").state;
    const lines = text(frame(s).lines);
    expect(lines[1]).toMatch(/^╭─ Add a Claude account ─+╮$/);
    expect(inside(lines[2])).toBe("Sign in to Anthropic");
    expect(prose(frame(s).lines)).toContain("anywhere else the page shows a code to paste here.");
    expect(prose(frame(s).lines)).toContain("the account you use now stays active.");
    expect(lines[23]).toMatch(/^ {2}enter +get the sign-in link +esc +back/);
    expect(enter(s).effect).toEqual({ type: "signin-start" });
    for (const back of [esc(s), key(s, "q")]) {
      expect(back.state.signin).toBeNull();
      expect(back.effect).toBeNull();
    }
    // An expired login is signed in again in place, for its own address.
    const again = enter(deckState({ at: 2 })).state;
    const said = text(frame(again).lines);
    expect(said[1]).toMatch(/^╭─ Sign in again ─/);
    expect(inside(said[2])).toBe("Sign in again as carol@side.example");
    expect(prose(frame(again).lines)).toContain("keeps its slot, its alias and its history");
  });

  it("follows the deck's stages, the one under way spinning", () => {
    const stages = (login: Row) => text(frame(signingIn(login)).lines).slice(2, 6).map(inside);
    expect(stages({ state: "awaiting_url", url: null })).toEqual([
      expect.stringMatching(/^\S {2}Asking the claude CLI for a sign-in link$/),
      "·  Approve in your browser", "·  Confirm who signed in", "·  Save the credentials",
    ]);
    expect(stages(WAITING_CODE).slice(0, 2)).toEqual(["✓  Sign-in link ready", expect.stringMatching(/^\S {2}Waiting for you to approve in the browser$/)]);
    expect(stages({ ...WAITING_CODE, state: "registering", step: "confirm" })[2]).toMatch(/^\S {2}Confirming who signed in$/);
    expect(stages({ ...WAITING_CODE, state: "registering", step: "restore" })[3]).toMatch(/^\S {2}Saving the credentials$/);
    expect(stages({ state: "done", account: { num: 5 } })).toEqual(["✓  Sign-in link ready", "✓  Approved in the browser", "✓  Sign-in confirmed", "✓  Credentials saved"]);
    // A failure is marked where it happened.
    expect(view.signinStage({ started: true, login: { state: "failed", step: "save" } })).toEqual({ failed: "save" });
    expect(view.signinStage({ started: true, login: { state: "failed", url: LOGIN_URL } })).toEqual({ failed: "approve" });
    expect(view.signinStage({ started: true, login: { state: "failed" } })).toEqual({ failed: "link" });
    // A flow the deck no longer has ended where it was last seen.
    const gone = view.withLogin(signingIn(WAITING_CODE), { state: "idle" });
    expect(view.signinStage(gone.signin)).toEqual({ failed: "approve", vanished: true });
    expect(view.signinRunning(gone.signin)).toBe(false);
    expect(prose(frame(gone).lines)).toContain("The sign-in ended before it finished — the deck restarted, or it was cancelled elsewhere.");
    // The deck is asked more often while it writes the account.
    expect(view.signinPollMs(signingIn(WAITING_CODE).signin)).toBe(1_500);
    expect(view.signinPollMs(signingIn({ ...WAITING_CODE, state: "registering" }).signin)).toBe(400);
  });

  it("draws the link whole, as one run the terminal wraps, the code's field under it", () => {
    const f = frame(signingIn(WAITING_CODE));
    const lines = text(f.lines);
    expect(lines[1]).toMatch(/^╭─ Add a Claude account ─+ 5 min left ─╮$/);
    expect(f.run).toMatchObject({ rows: Math.ceil(LOGIN_URL.length / 80), full: LOGIN_URL.length % 80 === 0 });
    expect(stripAnsi(f.run.text)).toBe(LOGIN_URL);
    expect(lines.slice(f.run.row, f.run.row + f.run.rows).join("")).toBe(LOGIN_URL);
    expect(lines[f.run.row - 1]).toBe("  Open this link in any browser and approve the sign-in:");
    expect(lines).toContain("  › ▏");
    expect(lines[23]).toMatch(/^ {2}enter +send the code +esc +cancel/);
    // Where the terminal knows links, the run is one: OSC 8 around it.
    expect(frame(signingIn(WAITING_CODE), 80, 24, true, "ansi16", true).run.text).toContain(`\x1b]8;;${LOGIN_URL}`);
    expect(text(frame(signingIn(WAITING_CODE), 80, 24, false).lines)).toContain("  > _");
    // A last piece that reaches the last column says so: clearing the row would take its last character.
    const exact = "https://x.example/" + "a".repeat(80 * 2 - 18);
    expect(frame(signingIn({ ...WAITING_CODE, url: exact })).run).toMatchObject({ rows: 2, full: true });
  });

  it("draws a link it cannot vouch for as a warning, never as a run", () => {
    for (const url of ["http://claude.ai/oauth", `https://claude.ai/\x1b]8;;evil\x07x`, "https://claude.ai/a b", 42]) {
      const f = frame(signingIn({ ...WAITING_CODE, url }));
      expect(f.run).toBeNull();
      expect(prose(f.lines)).toContain("the deck's sign-in link could not be shown — sign in from its Accounts panel");
    }
  });

  it("gives way on a short screen, the link and the field last of all", () => {
    const short = text(frame(signingIn(WAITING_CODE), 80, 16).lines);
    expect(short.join("")).toContain(LOGIN_URL);
    expect(short).toContain("  › ▏");
    expect(short.some(l => l.includes("is not kept"))).toBe(false);
    expect(frame(signingIn(WAITING_CODE), 40, 12).run).toMatchObject({ rows: Math.ceil(LOGIN_URL.length / 40) });
    // A link that cannot fit whole is no link at all: it says so.
    const long = `${LOGIN_URL}&scope_more=${"x".repeat(120)}`;
    const tiny = frame(signingIn({ ...WAITING_CODE, url: long }), 40, 12);
    expect(tiny.run).toBeNull();
    expect(prose(tiny.lines)).toContain(`make the window taller to see the sign-in link — it needs ${Math.ceil(long.length / 40)} rows`);
    expect(text(tiny.lines)).toContain("  › ▏");
  });

  it("takes the code as typed or pasted, q and all, and enter sends it once", () => {
    let s = signingIn(WAITING_CODE);
    for (const ch of ["a", "q", "-", "Z", "9"]) s = key(s, ch).state;
    expect(s.signin.code).toBe("aq-Z9");
    expect(key(s, undefined, { name: "backspace" }).state.signin.code).toBe("aq-Z");
    expect(key(s, "u", { name: "u", ctrl: true }).state.signin.code).toBe("");
    // A space, a tab or a control key is not a character of a code.
    for (const [str, k] of [[" ", { name: "space" }], ["\t", { name: "tab" }], ["\x1b[A", { name: "up" }]] as [string, Row][]) {
      expect(key(s, str, k).state.signin.code).toBe("aq-Z9");
    }
    expect(key(s, "x".repeat(5_000)).state.signin.code).toHaveLength(1_024);
    const sent = enter(s);
    expect(sent.effect).toEqual({ type: "signin-code", code: "aq-Z9" });
    expect(sent.state.signin.sending).toBe(true);
    expect(text(frame(sent.state).lines).some(l => l.includes("aq-Z9  sending the code…"))).toBe(true);
    expect(enter(sent.state).effect).toBeNull();
    expect(enter(signingIn(WAITING_CODE)).effect).toBeNull();
    // Before the link there is no field to type into.
    expect(key(signingIn({ state: "awaiting_url", url: null }), "a").state.signin.code).toBe("");
  });

  it("puts a refused code's reason under the field, for the next one", () => {
    const why = "that code was not accepted — copy it again from the browser";
    const lines = text(frame(signingIn({ ...WAITING_CODE, error: why })).lines);
    expect(lines[lines.indexOf("  › ▏") + 1]).toBe(`  ✗  ${why}`);
    // What the CLI printed is shown, never obeyed: no escape reaches the terminal.
    const hostile = frame(signingIn({ ...WAITING_CODE, error: "rejected\x1b]0;owned\x07 \x1b[2Jcode\nagain" }, {}, "x\x1b[31m@y.example"), 80, 24, true, "none");
    expect(hostile.lines.join("")).not.toContain("\x1b");
    expect(text(hostile.lines)).toContain("  ✗  rejected ]0;owned [2Jcode again");
    // On a console that draws ASCII alone, the deck's own sentence is ASCII too.
    expect(text(frame(signingIn({ ...WAITING_CODE, error: why }), 80, 24, false).lines)).toContain("  x  that code was not accepted - copy it again from the browser");
  });

  it("esc lets go of the deck's sign-in while it waits, and not once it writes the account", () => {
    for (const login of [{ state: "awaiting_url", url: null }, WAITING_CODE]) {
      const r = esc(signingIn(login));
      expect(r.effect).toEqual({ type: "signin-cancel" });
      expect(r.state.signin).toBeNull();
    }
    const saving = esc(signingIn({ ...WAITING_CODE, state: "registering", step: "save" }));
    expect(saving.effect).toBeNull();
    expect(saving.state.signin).not.toBeNull();
    expect(saving.state.notice.text).toBe("saving the account — a moment");
    // q is a character of the code there, and quits nowhere on the page but the first.
    expect(key(signingIn(WAITING_CODE), "q").effect).toBeNull();
    expect(key(signingIn(WAITING_CODE), "c", { name: "c", ctrl: true }).effect).toEqual({ type: "quit" });
  });

  it("says how it ended: added, refreshed, or why not, and enter tries again", () => {
    const added = signingIn({ state: "done", account: { num: 5, email: "eve@new.example", added: true }, restored: true });
    const said = prose(frame(added).lines);
    expect(said).toContain("✓  Account 5 added");
    expect(said).toContain("eve@new.example is in the rotation. The account you were using is still active.");
    expect(enter(added)).toMatchObject({ state: { signin: null }, effect: { type: "signin-done", account: { num: 5, email: "eve@new.example" } } });
    expect(esc(added).effect?.type).toBe("signin-done");
    const again = signingIn({ state: "done", account: { num: 3, email: "carol@side.example", added: false }, restored: true }, {}, "carol@side.example");
    expect(text(frame(again).lines).join("\n")).toContain("✓  Credentials refreshed");
    // The one outcome nobody may miss: the account in use did not go back.
    const moved = signingIn({ state: "done", account: { num: 5, email: "eve@new.example" }, restored: false, activeAccount: { num: 5, email: "eve@new.example" } });
    expect(prose(frame(moved).lines)).toContain("This machine is now signed in as eve@new.example — the account you were using could not be put back.");

    const failed = signingIn({ ...WAITING_CODE, state: "failed", error: "the sign-in window expired" });
    const lines = text(frame(failed).lines);
    expect(inside(lines[3])).toBe("✗  The sign-in did not finish in the browser");
    expect(lines).toContain("  The sign-in window expired.");
    expect(lines[23]).toMatch(/^ {2}enter +try again +esc +back/);
    expect(enter(failed).effect).toEqual({ type: "signin-start" });
    expect(esc(failed)).toMatchObject({ state: { signin: null }, effect: { type: "signin-cancel", quiet: true } });
    // A start the deck refused holds nothing of ours to let go of.
    const refused = signingIn({ state: "failed", error: "another sign-in is saving an account right now", local: true });
    expect(esc(refused)).toMatchObject({ state: { signin: null }, effect: null });
  });
});

describe("the screen", () => {
  it("writes only the rows that changed, and everything after a resize", () => {
    const writes: string[] = [];
    const screen = createScreen((s: string) => writes.push(s));
    screen.enter();
    expect(writes[0]).toContain(ALT_SCREEN_ON);
    screen.paint(["one", "two", "three"]);
    expect(writes.at(-1)).toContain("\x1b[1;1Hone");
    expect(writes.at(-1)).toContain("\x1b[3;1Hthree");
    const before = writes.length;
    screen.paint(["one", "two", "three"]);
    expect(writes.length).toBe(before);
    screen.paint(["one", "TWO", "three"]);
    expect(writes.at(-1)).toContain("\x1b[2;1HTWO");
    expect(writes.at(-1)).not.toContain("one");
    screen.invalidate();
    screen.paint(["one", "TWO", "three"]);
    expect(writes.at(-1)).toContain("\x1b[1;1Hone");
  });

  // A sign-in link, written edge to edge with wrapping on so the terminal
  // knows it for one line: one a mouse copies whole and a click opens.
  it("writes a frame's run with wrapping on, and again only when it changed", () => {
    const writes: string[] = [];
    const screen = createScreen((s: string) => writes.push(s), { held: false });
    screen.enter();
    const run = { row: 1, rows: 2, text: "https://a.example/0123456789", full: false };
    screen.paint(["title", "https://a.example/01", "23456789", "below"], run);
    const first = writes.at(-1)!;
    expect(first).toContain(`\x1b[2;1H\x1b[0m${WRAP_ON}https://a.example/0123456789\x1b[0m${WRAP_OFF}\x1b[K`);
    // Its rows are the run's: not written a second time, cut, over it.
    expect(first).not.toContain("\x1b[3;1H");
    expect(first).toContain("\x1b[4;1Hbelow");
    const before = writes.length;
    screen.paint(["title", "https://a.example/01", "23456789", "below"], run);
    expect(writes.length).toBe(before);
    screen.paint(["title", "https://a.example/01", "23456789", "BELOW"], run);
    expect(writes.at(-1)).not.toContain(WRAP_ON);
    // A run gone leaves its rows marked as wrapped in the terminal, joined to
    // the row above for selecting and for finding links: the screen is cleared
    // and written whole, the one erase that takes the mark off everywhere —
    // over conhost too, which passes on only what changed.
    screen.paint(["title", "two", "three", "BELOW"]);
    expect(writes.at(-1)).toContain("\x1b[2J");
    expect(writes.at(-1)).toContain("\x1b[1;1Htitle");
    screen.paint(["title", "two", "THREE", "BELOW"]);
    expect(writes.at(-1)).toBe("\x1b[3;1HTHREE\x1b[0m\x1b[K");
    // A run that grows in place keeps its rows: no clear.
    screen.paint(["title", "ab", "cd", "BELOW"], { row: 1, rows: 2, text: "abcd", full: false });
    screen.paint(["title", "ab", "cd", "ef"], { row: 1, rows: 3, text: "abcdef", full: false });
    expect(writes.at(-1)).not.toContain("\x1b[2J");
  });

  it("does not clear the row after a run that reaches the last column", () => {
    const writes: string[] = [];
    const screen = createScreen((s: string) => writes.push(s), { held: false });
    screen.enter();
    screen.paint(["title", "abcd", "efgh"], { row: 1, rows: 2, text: "abcdefgh", full: true });
    expect(writes.at(-1)).toContain(`abcdefgh\x1b[0m${WRAP_OFF}`);
    expect(writes.at(-1)).not.toContain(`${WRAP_OFF}\x1b[K`);
  });

  it("hands the terminal back once, however many ways out ask", () => {
    const writes: string[] = [];
    const screen = createScreen((s: string) => writes.push(s));
    screen.leave();
    expect(writes).toHaveLength(0);
    screen.enter();
    screen.leave();
    screen.leave();
    const back = writes.filter(w => w.includes(ALT_SCREEN_OFF));
    expect(back).toHaveLength(1);
    expect(back[0]).toContain(CURSOR_SHOW);
    expect(back[0]).toContain(WRAP_ON);
  });

  it("survives a terminal that went away", () => {
    const screen = createScreen(() => { throw new Error("EIO"); });
    expect(() => { screen.enter(); screen.paint(["x"]); screen.leave(); }).not.toThrow();
  });

  // Conhost froze on the first frame held between the marks (Windows 11 24H2,
  // under sshd): the accounts were read in 0.4 s and shown only on the way out.
  it("holds a frame between the synchronized-output marks except on Windows", () => {
    expect(framesHeld("linux")).toBe(true);
    expect(framesHeld("darwin")).toBe(true);
    expect(framesHeld("win32")).toBe(false);
    const sent = (held: boolean) => {
      const writes: string[] = [];
      const screen = createScreen((s: string) => writes.push(s), { held });
      screen.enter();
      screen.paint(["one", "two"]);
      screen.paint(["one", "TWO"]);
      screen.leave();
      return writes.join("");
    };
    expect(sent(true)).toContain(`${SYNC_ON}\x1b[2;1HTWO`);
    expect(sent(false)).not.toMatch(/\x1b\[\?2026[hl]/);
    expect(sent(false)).toContain("\x1b[2;1HTWO");
    expect(sent(false)).toContain(ALT_SCREEN_OFF);
  });
});

describe("the painted lines", () => {
  it("cut a painted line by what shows, keeping its colours", () => {
    const line = `${tone.ok}abcdef${tone.reset}ghij`;
    const cut = fitPainted(line, 6, "…");
    expect(stripAnsi(cut)).toBe("abcde…");
    expect(cut.startsWith(tone.ok)).toBe(true);
    expect(fitPainted("short", 10, "…")).toBe("short");
    // A line with no colour is cut without gaining any: NO_COLOR stays escape-free.
    expect(fitPainted("abcdefghij", 6, "…")).toBe("abcde…");
  });

  it("slice a plain line by columns, a wide character cut in half a space", () => {
    expect(sliceCells("ab日本c", 1, 4)).toBe("b日");
    expect(sliceCells("ab日本c", 3, 6)).toBe(" 本");
    expect(sliceCells("ab", 1, 5)).toBe("b   ");
    expect(textWidth(sliceCells("日本語のテキスト", 0, 7))).toBe(7);
  });
});

// ── the loop, with a fake terminal and a fake deck ─────────────────────────

function fakeTerminal(columns = 100, rows = 30) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (on: boolean) => void; raw: boolean[]; order: string[] };
  input.isTTY = true;
  input.isRaw = false;
  input.raw = [];
  input.order = [];
  input.setRawMode = (on: boolean) => { input.raw.push(on); input.order.push(`raw ${on}`); input.isRaw = on; };
  const pause = input.pause.bind(input);
  input.pause = () => { input.order.push("pause"); return pause(); };
  let written = "";
  const output = new Writable({ write(chunk, _enc, done) { written += String(chunk); done(); } }) as Writable & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  return { input, output, written: () => written, screenText: () => stripAnsi(written) };
}

function fakeDeck(over: Row = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const switched: number[] = [];
  let accounts = ROWS.map(r => ({ ...r }));
  const source = {
    find: async () => ({ port: 4999, version: "3.46.0", token: "t" }),
    silent: async () => [],
    ask: async (_deck: unknown, { method = "GET", path, body }: { method?: string; path: string; body?: unknown }) => {
      calls.push({ method, path, body });
      if (path.startsWith("/api/claude-accounts")) return { ok: true, status: 200, body: { ok: true, activeNum: 1, accounts } };
      if (path === "/api/cswap-auto" && method === "POST") return { ok: true, status: 200, body: { ok: true } };
      if (path === "/api/cswap-auto") return { ok: true, status: 200, body: AUTO };
      if (path === "/api/sessions") return { ok: true, status: 200, body: { ok: true, now: Date.now(), sessions: SESSIONS } };
      return { ok: false, status: 404, body: null };
    },
    localRoster: async () => ({ ok: false, reason: "no_cswap" }),
    switchDeck: async (_deck: unknown, num: number) => {
      switched.push(num);
      accounts = accounts.map(a => ({ ...a, active: a.num === num }));
      return { ok: true, output: "switched" };
    },
    switchHere: async () => ({ ok: false, reason: "should_not_be_called" }),
    rules: async () => null,
    startDeck: () => {},
    wait: (ms: number) => new Promise(r => setTimeout(r, ms)),
    ...over,
  };
  return { source, calls, switched };
}

function quietOut() {
  const failed: { code: number; reason: string; text: unknown }[] = [];
  return {
    failed,
    out: {
      json: false, say() {}, done: (_d: unknown, code = 0) => code,
      fail(code: number, reason: string, t: unknown) { failed.push({ code, reason, text: t }); return code; },
    },
  };
}

async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 10));
  }
}

// The loop is drawn in the Unicode look whatever runs the tests: the host's own
// answer is ASCII on a Windows runner and under TERM=linux, and the words these
// tests wait for carry the Unicode dash, dot and corners.
const LOOK = { unicode: true, g: glyphs(true) };

describe("the loop", () => {
  it("switches through the deck to the account chosen, and q hands the terminal back", async () => {
    const term = fakeTerminal();
    const deck = fakeDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("bob@home.example"));
    expect(term.written()).toContain(ALT_SCREEN_ON);
    expect(term.input.raw).toEqual([true]);
    term.input.write("\x1b[B");      // down, onto #2
    term.input.write("\r");
    await until(() => deck.switched.length > 0);
    expect(deck.switched).toEqual([2]);
    await until(() => term.screenText().includes("switched to #2 bob@home.example (home)"));
    // Two Claude sessions are running, and the notice says they follow.
    expect(term.screenText()).toContain("2 Claude sessions move with it");
    // The roster was read again, forced, after the switch.
    expect(deck.calls.filter(c => c.path === "/api/claude-accounts?refresh=1").length).toBeGreaterThanOrEqual(2);
    term.input.write("q");
    expect(await done).toBe(0);
    expect(term.written().endsWith(ALT_SCREEN_OFF)).toBe(true);
    expect(term.input.raw).toEqual([true, false]);
  });

  // On Windows, raw mode ended while the keys were still being read left the
  // PowerShell that ran `ccdeck tui` dead behind it: not one more line ran, and
  // the SSH session closed with the screen.
  it("stops reading the keys before it gives the terminal its mode back", async () => {
    const term = fakeTerminal();
    const deck = fakeDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("bob@home.example"));
    term.input.write("q");
    expect(await done).toBe(0);
    expect(term.input.order.slice(-2)).toEqual(["pause", "raw false"]);
  });

  it("a turns Auto-switch off with the deck's own POST", async () => {
    const term = fakeTerminal();
    const deck = fakeDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("Auto-switch on"));
    term.input.write("a");
    await until(() => deck.calls.some(c => c.method === "POST"));
    expect(deck.calls.find(c => c.method === "POST")).toEqual({ method: "POST", path: "/api/cswap-auto", body: { action: "enable", enabled: false } });
    term.input.write("\x03");        // Ctrl+C quits
    expect(await done).toBe(0);
  });

  it("b selects the account with the most room and says Enter switches to it", async () => {
    const term = fakeTerminal();
    const roomy = ROWS.map(r => (r.num === 2 ? { ...r, headroom: 95 } : r));
    const deck = fakeDeck();
    const ask = deck.source.ask;
    deck.source.ask = async (d: unknown, o: { method?: string; path: string; body?: unknown }) =>
      (o.path.startsWith("/api/claude-accounts") ? { ok: true, status: 200, body: { ok: true, accounts: roomy } } : ask(d, o));
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("bob@home.example"));
    term.input.write("b");
    await until(() => term.screenText().includes("enter switches to #2 bob@home.example (home) — the most room"));
    expect(deck.switched).toEqual([]);
    term.input.write("q");
    await done;
  });

  it("a deck that stops answering is looked for again, and the store read meanwhile", async () => {
    const term = fakeTerminal();
    let up = true;
    const deck = fakeDeck({
      find: async () => (up ? { port: 4999, version: "3.46.0" } : null),
      localRoster: async () => ({ ok: true, accounts: ROWS }),
    });
    const ask = deck.source.ask;
    deck.source.ask = async (d: unknown, o: { method?: string; path: string; body?: unknown }) =>
      (up ? ask(d, o) : { ok: false, status: 0, reason: "ECONNREFUSED", body: null });
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("deck 4999"));
    up = false;
    term.input.write("r");
    await until(() => term.screenText().includes("no deck · claude-swap's store"));
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("names a --port nobody listens on before taking the screen", async () => {
    const term = fakeTerminal();
    const deck = fakeDeck({ find: async () => null });
    const { out, failed } = quietOut();
    const code = await runTui({ port: "4321" }, out, { input: term.input, output: term.output, source: deck.source });
    expect(code).toBe(3);
    expect(failed[0].reason).toBe("no_deck");
    expect(term.written()).toBe("");
  });

  it("with no deck, reads the store and offers to start one", async () => {
    const term = fakeTerminal();
    let started = 0;
    const deck = fakeDeck({
      find: async () => (started ? { port: 4998, version: "3.46.0" } : null),
      localRoster: async () => ({ ok: true, accounts: ROWS }),
      startDeck: () => { started++; },
      wait: () => new Promise(r => setTimeout(r, 5)),
    });
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("no deck is running"));
    term.input.write("d");
    await until(() => term.screenText().includes("the deck is running on 4998"));
    expect(started).toBe(1);
    term.input.write("q");
    await done;
  });

  it("a deck that will not start says why at once, in its launcher's last words", async () => {
    const term = fakeTerminal();
    const deck = fakeDeck({
      find: async () => null,
      localRoster: async () => ({ ok: true, accounts: ROWS }),
      startDeck: () => ({ exited: Promise.resolve({ code: 1, said: "ccdeck: ui not built. run `npm run build` first." }) }),
      wait: () => new Promise(r => setTimeout(r, 5)),
    });
    const { out } = quietOut();
    const started = Date.now();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("no deck is running"));
    term.input.write("d");
    await until(() => term.screenText().includes("the deck did not start — ccdeck: ui not built."));
    expect(Date.now() - started).toBeLessThan(5_000);
    term.input.write("q");
    await done;
  });

  // The deck's sign-in as cswap-admin.mjs runs it: a link once the CLI printed
  // one, a wrong code asked for again, a right one saved as a new slot.
  function signinDeck(over: { start?: (body: Row) => { status: number; body: Row } } = {}) {
    const deck = fakeDeck();
    let login: Row = { state: "idle" };
    let accounts = ROWS;
    const ask = deck.source.ask;
    const answer = (status: number, body: Row) => ({ ok: status === 200, status, body });
    deck.source.ask = async (d: unknown, o: { method?: string; path: string; body?: Row }) => {
      if (o.path === "/api/claude-accounts/login") {
        deck.calls.push({ method: "GET", path: o.path });
        return answer(200, { ok: true, ...login });
      }
      if (o.path === "/api/claude-accounts/admin") {
        deck.calls.push({ method: "POST", path: o.path, body: o.body });
        const b = o.body ?? {};
        if (b.action === "login") {
          if (over.start) return over.start(b);
          login = { ...WAITING_CODE, expiresAt: Date.now() + 300_000 };
          return answer(200, { ok: true, ...login });
        }
        if (b.action === "login-code" && b.code === "good") {
          accounts = [...ROWS, row(5, "eve@new.example", null)];
          login = { state: "done", url: LOGIN_URL, account: { num: 5, email: "eve@new.example", added: true }, restored: true };
          return answer(200, { ok: true, ...login });
        }
        if (b.action === "login-code") {
          login = { ...login, error: "that code was not accepted — copy it again from the browser" };
          return answer(400, { ok: false, reason: "code_rejected", ...login });
        }
        if (b.action === "login-cancel") {
          login = { state: "idle" };
          return answer(200, { ok: true, state: "idle", restored: true, activeAccount: null });
        }
      }
      if (o.path.startsWith("/api/claude-accounts")) {
        deck.calls.push({ method: "GET", path: o.path });
        return answer(200, { ok: true, activeNum: 1, accounts });
      }
      return ask(d, o);
    };
    const posts = () => deck.calls.filter(c => c.method === "POST").map(c => c.body);
    return { ...deck, posts };
  }

  it("adds an account: the link, a code pasted, and the new slot selected", async () => {
    const term = fakeTerminal(80, 24);
    const deck = signinDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("bob@home.example"));
    term.input.write("+");
    await until(() => term.screenText().includes("Sign in to Anthropic"));
    term.input.write("\r");
    await until(() => term.screenText().includes("Open this link in any browser"));
    // The link went out whole, with wrapping on for the terminal to wrap it.
    expect(term.written()).toContain(`${WRAP_ON}`);
    expect(term.screenText()).toContain(LOGIN_URL);
    term.input.write("bad\r");
    await until(() => term.screenText().includes("that code was not accepted"));
    term.input.write("good\r");
    await until(() => term.screenText().includes("Account 5 added"));
    term.input.write("\r");
    await until(() => term.screenText().includes("added: eve@new.example"));
    // The account just added is the one selected, its detail under the list.
    await until(() => term.screenText().includes("╭─ #5 eve@new.example"));
    expect(deck.posts()).toEqual([
      { action: "login" },
      { action: "login-code", code: "bad" },
      { action: "login-code", code: "good" },
    ]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("signs an expired login in again for its own address, and esc lets the deck's go", async () => {
    const term = fakeTerminal(80, 24);
    const deck = signinDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("carol@side.example"));
    term.input.write("3");
    term.input.write("\r");
    await until(() => term.screenText().includes("Sign in again as carol@side.example"));
    term.input.write("\r");
    await until(() => term.screenText().includes("Open this link in any browser"));
    term.input.write("\x1b");
    await until(() => term.screenText().includes("sign-in cancelled"));
    expect(deck.posts()).toEqual([{ action: "login", email: "carol@side.example" }, { action: "login-cancel" }]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  // Left running, `claude auth login` would hold the next sign-in for the
  // rest of its five minutes.
  it("quitting in the middle of a sign-in lets go of the deck's first", async () => {
    const term = fakeTerminal(80, 24);
    const deck = signinDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("bob@home.example"));
    term.input.write("+");
    term.input.write("\r");
    await until(() => term.screenText().includes("Open this link in any browser"));
    term.input.write("\x03");
    expect(await done).toBe(0);
    expect(deck.posts().at(-1)).toEqual({ action: "login-cancel" });
    expect(term.written().endsWith(ALT_SCREEN_OFF)).toBe(true);
  });

  it("a start the deck refused is not cancelled: the sign-in it holds is somebody else's", async () => {
    const term = fakeTerminal(80, 24);
    const deck = signinDeck({ start: () => ({ ok: false, status: 400, body: { ok: false, reason: "already_running", state: "registering", step: "save" } }) as never });
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20, ...LOOK });
    await until(() => term.screenText().includes("bob@home.example"));
    term.input.write("+");
    term.input.write("\r");
    await until(() => term.screenText().includes("Another sign-in is saving an account right now"));
    term.input.write("\x1b");
    await until(() => term.screenText().includes("bob@home.example"));
    term.input.write("+");
    term.input.write("\r");
    await until(() => deck.posts().length === 2);
    term.input.write("\x03");
    expect(await done).toBe(0);
    expect(deck.posts()).toEqual([{ action: "login" }, { action: "login" }]);
  });

  it("refuses --json and a pipe, pointing at the commands that print once", async () => {
    const { out, failed } = quietOut();
    expect(await runTui({}, { ...out, json: true }, {})).toBe(2);
    expect(failed[0].reason).toBe("interactive_only");
    const home = mkdtempSync(join(tmpdir(), "ccdeck-tui-"));
    try {
      const r = await new Promise<{ code: number | null; err: string }>((resolve, reject) => {
        let err = "";
        const c = spawn(process.execPath, [DECK, "tui"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), NO_COLOR: "1", AGENTS_DECK_NO_LAN: "1" },
        });
        c.stderr!.on("data", d => { err += String(d); });
        c.on("error", reject);
        c.on("exit", code => resolve({ code, err }));
      });
      expect(r.code).toBe(2);
      expect(r.err).toContain("needs a terminal at both ends");
    } finally {
      rmTempDir(home);
    }
  });
});
