// `ccdeck tui`: the accounts and the sessions waiting on you, on one screen
// that stays up, for somebody on the machine over SSH.
//
// What is pinned here, in the order it can go wrong:
//
//   the frame     exactly as many rows as the screen, none of them reaching its
//                 last column, at every width and in the ASCII tier; what gives
//                 way on a short screen, and the selection always on it;
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
const { accountLines, fitPainted, textWidth } = await import("../../server/cli-lines.mjs");
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

function deckState(over: State = {}): State {
  const s = { ...view.initialState(), deck: { port: 4317, version: "3.46.0" }, source: "deck", auto: AUTO, sessions: SESSIONS };
  return { ...view.withRoster(s, { ok: true, activeNum: 1, accounts: ROWS }), ...over };
}
const frame = (s: State, columns = 80, rows = 24, unicode = true) =>
  view.tuiFrame(s, { columns, rows, tone: unicode ? tone : plainTone, g: unicode ? U : A, unicode, now: NOW });
const text = (lines: string[]) => lines.map((l: string) => stripAnsi(l));

describe("the command", () => {
  it("is a command word, answers and leaves rather than detaching", () => {
    const flags = parseArgs(["tui"]);
    expect(flags.command).toBe("tui");
    expect(isOneShot(flags)).toBe(true);
    expect(parseArgs(["--port", "4320", "tui"]).command).toBe("tui");
  });
});

describe("the frame", () => {
  const states: [string, State][] = [
    ["a deck", deckState()],
    ["help", deckState({ help: true })],
    ["no deck", deckState({ deck: null, source: "local", auto: null, sessions: null })],
    ["nothing read yet", { ...view.initialState() }],
    ["a long notice", deckState({ notice: view.note("err", "x".repeat(300), NOW) })],
    ["many accounts", { ...deckState(), ...view.withRoster(deckState(), { ok: true, accounts: Array.from({ length: 14 }, (_, i) => row(i + 1, `user${i + 1}@a-rather-long-domain.example`, `alias-${i + 1}`)) }) }],
  ];
  for (const [what, s] of states) {
    for (const [columns, rows] of [[40, 12], [64, 16], [80, 24], [104, 30], [160, 50]]) {
      it(`${what} at ${columns}x${rows}: every row is inside the screen`, () => {
        for (const unicode of [true, false]) {
          const { lines } = frame(s, columns, rows, unicode);
          expect(lines).toHaveLength(rows);
          for (const line of lines) expect(textWidth(line)).toBeLessThan(columns);
          if (!unicode) for (const line of text(lines)) expect(line).toMatch(/^[\x20-\x7e]*$/);
        }
      });
    }
  }

  it("says so on a screen too small to draw on", () => {
    const { lines } = frame(deckState(), 30, 8);
    expect(lines).toHaveLength(8);
    expect(text(lines)[0]).toBe("too small — 40×12 at least");
  });

  it("points at the selected account, and marks the live one and the home one", () => {
    const lines = text(frame(deckState({ at: 1 })).lines);
    const bob = lines.find(l => l.includes("bob@home.example") && !l.includes("#2"))!;
    expect(bob.startsWith("›")).toBe(true);
    expect(bob).toContain("⌂");
    const alice = lines.find(l => l.includes("alice@corp.example") && !l.includes("#1"))!;
    expect(alice).toMatch(/^\s+● 1/);
    // The detail is the selected account's, with every lane.
    expect(lines).toContain("  #2 bob@home.example (home)  home  read 1m ago");
    expect(lines.some(l => /^\s+5h\s+[█░]{20}\s+20%\s+resets in 1h/.test(l))).toBe(true);
    expect(lines.some(l => l.includes("Auto-switch on  switches at 90% · next: most room · home #2"))).toBe(true);
  });

  it("lists who is waiting longest first, with the question under each", () => {
    const lines = text(frame(deckState()).lines);
    const title = lines.findIndex(l => l.includes("Waiting on you"));
    expect(lines[title]).toContain("2 sessions · 1 working");
    expect(lines[title + 1]).toContain("docs");
    expect(lines[title + 2]).toContain("Which branch?");
    expect(lines[title + 3]).toContain("api-refactor");
  });

  it("says nobody is waiting when nobody is", () => {
    const lines = text(frame(deckState({ sessions: [SESSIONS[2]] })).lines);
    expect(lines).toContain("  nobody is waiting on you · 1 working");
  });

  it("gives way on a short screen: the waiting count and the selection stay", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...SESSIONS[0], id: `w${i}`, name: `job-${i}`, since: NOW - i * 1000 }));
    const lines = text(frame(deckState({ sessions: many }), 80, 16).lines);
    expect(lines.some(l => l.includes("Waiting on you") && l.includes("6 sessions"))).toBe(true);
    // The detail went before the accounts did.
    expect(lines.some(l => l.includes("read 1m ago"))).toBe(false);
    expect(lines.filter(l => /@/.test(l))).toHaveLength(4);
  });

  it("scrolls a long list so the selection is on it, and says what is off screen", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(i + 1, `user${i + 1}@x.example`, null));
    let s: State = view.withRoster({ ...view.initialState(), deck: { port: 4317 }, auto: AUTO, sessions: [] }, { ok: true, accounts: rows });
    s = { ...s, at: 12 };
    const f = frame(s, 80, 14);
    const lines = text(f.lines);
    expect(lines.find(l => l.startsWith("›"))).toContain("user13@x.example");
    expect(lines.some(l => /\d+ above/.test(l))).toBe(true);
    // Moving back up keeps the list where it was until the selection leaves it.
    const back = text(frame({ ...s, top: f.top, at: 11 }, 80, 14).lines);
    expect(back.find(l => l.startsWith("›"))).toContain("user12@x.example");
    expect(frame({ ...s, top: f.top, at: 11 }, 80, 14).top).toBe(f.top);
  });

  it("shows why the roster is empty, in the commands' own words", () => {
    const s = view.withRoster({ ...view.initialState(), source: "local" }, { ok: false, reason: "no_cswap" }, ["claude-swap is not installed", "or by hand: pipx install claude-swap"]);
    const lines = text(frame(s).lines);
    expect(lines[2]).toBe("  claude-swap is not installed");
    expect(lines[3]).toBe("  or by hand: pipx install claude-swap");
  });

  it("keeps the keys that leave and explain on a narrow screen", () => {
    const last = text(frame(deckState(), 40, 12).lines)[11];
    expect(last).toContain("? keys");
    expect(last).toContain("q quit");
    const wide = text(frame(deckState(), 100, 24).lines)[23];
    expect(wide).toContain("a auto-switch");
    const noDeck = text(frame(deckState({ deck: null, source: "local" }), 100, 24).lines)[23];
    expect(noDeck).toContain("d start the deck");
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
  });

  it("the home mark costs the email two columns and nothing else", () => {
    const opts = { tone: plainTone, g: U, unicode: true, columns: 80, now: NOW };
    const without = text(accountLines(ROWS, opts));
    const withHome = text(accountLines(ROWS, { ...opts, home: 2 }));
    expect(withHome[1]).toContain("⌂ home");
    for (const l of withHome) expect(textWidth(l)).toBeLessThanOrEqual(80);
    // A home no row has changes nothing.
    expect(text(accountLines(ROWS, { ...opts, home: 9 }))).toEqual(without);
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
