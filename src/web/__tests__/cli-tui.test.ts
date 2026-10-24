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
//   the screen    only the rows that changed are written, and the terminal is
//                 handed back whole, however many times it is asked;
//   the loop      a fake terminal and a fake deck: the switch goes THROUGH the
//                 deck with the slot chosen, Auto-switch is the deck's own POST,
//                 q puts the terminal back, and a pipe or `--json` is refused.
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
const { createScreen, ALT_SCREEN_ON, ALT_SCREEN_OFF, WRAP_ON } = await import("../../server/tui-screen.mjs");
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

const tone = palette("ansi16");
const plainTone = palette("none");
const U = glyphs(true);
const A = glyphs(false);
const PROFILES = ["truecolor", "ansi256", "ansi16", "none"];

function deckState(over: State = {}): State {
  const s = { ...view.initialState(), deck: { port: 4317, version: "3.46.0" }, source: "deck", auto: AUTO, sessions: SESSIONS, readAt: NOW - 2_000 };
  return { ...view.withRoster(s, { ok: true, activeNum: 1, accounts: ROWS }), ...over };
}
const frame = (s: State, columns = 80, rows = 24, unicode = true, profile = unicode ? "ansi16" : "none") =>
  view.tuiFrame(s, { columns, rows, tone: palette(profile), g: unicode ? U : A, unicode, now: NOW, profile });
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
  ];
  for (const [what, s] of states) {
    for (const [columns, rows] of [[40, 12], [64, 16], [80, 24], [104, 30], [120, 32], [160, 50]]) {
      it(`${what} at ${columns}x${rows}: every row is inside the screen, in every colour tier`, () => {
        for (const profile of PROFILES) {
          for (const unicode of [true, false]) {
            const { lines } = frame(s, columns, rows, unicode, profile);
            expect(lines).toHaveLength(rows);
            for (const line of lines) expect(textWidth(line)).toBeLessThan(columns);
            if (!unicode) for (const line of text(lines)) expect(line).toMatch(/^[\x20-\x7e]*$/);
            // NO_COLOR: not one escape, the lit row and the keys included.
            if (profile === "none") for (const line of lines) expect(line).not.toContain("\x1b");
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
    const dead = key(deckState({ at: 2 }), "\r", { name: "return" });
    expect(dead.effect).toBeNull();
    expect(dead.state.notice.tone).toBe("err");
    expect(dead.state.notice.text).toContain("needs a fresh sign-in");
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
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (on: boolean) => void; raw: boolean[] };
  input.isTTY = true;
  input.isRaw = false;
  input.raw = [];
  input.setRawMode = (on: boolean) => { input.raw.push(on); input.isRaw = on; };
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

describe("the loop", () => {
  it("switches through the deck to the account chosen, and q hands the terminal back", async () => {
    const term = fakeTerminal();
    const deck = fakeDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20 });
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

  it("a turns Auto-switch off with the deck's own POST", async () => {
    const term = fakeTerminal();
    const deck = fakeDeck();
    const { out } = quietOut();
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20 });
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
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20 });
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
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20 });
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
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20 });
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
    const done = runTui({}, out, { input: term.input, output: term.output, source: deck.source, tickMs: 20 });
    await until(() => term.screenText().includes("no deck is running"));
    term.input.write("d");
    await until(() => term.screenText().includes("the deck did not start — ccdeck: ui not built."));
    expect(Date.now() - started).toBeLessThan(5_000);
    term.input.write("q");
    await done;
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
