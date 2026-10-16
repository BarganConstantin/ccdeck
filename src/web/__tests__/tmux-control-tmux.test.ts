// tmux-control.mjs against a real tmux, on a private socket, with real programs
// in the panes.
//
// tmux-control.test.ts pins the protocol against a scripted peer; this file
// asks the question that peer cannot answer: does the panel show what tmux
// shows? The control is tmux itself, as in the phase-0 spike: `capture-pane`
// reads back tmux's own idea of the pane, and an emulator fed only by this
// module's seed and its 'output' stream is compared with it — text row by row,
// every attribute cell by cell, and the cursor — after typing, bursts, resizes,
// a reseed in the middle of a burst and a forced %pause. The rest of the file is
// the behaviour the panel leans on: bytes typed arrive exactly, a paste is
// bracketed only when the program asked, quoting survives tmux's parser,
// ignore-size leaves the user's window alone, and closing the panel leaves the
// session running.
//
// NO SKIP GATE, ON PURPOSE. Every case starts by checking for tmux and returns
// when there is none, rather than `skipIf` — a register entry in
// skip-gates.mjs, and a skipped case CI would have to account for on every leg
// (see codex-compressed-rollout.test.ts for the house reasoning). tmux comes
// from CCDECK_TMUX or PATH and must be 3.2 or newer. The emulator is
// @xterm/headless with the graphemes addon the stage itself loads (headless is
// not a dependency of the deck): it is resolved from CCDECK_TEST_XTERM (a
// directory whose node_modules holds both) or from this checkout, and without
// it the screen comparisons
// fall back to checks that need no emulator. To run the whole of it:
//
//   CCDECK_TMUX=/path/to/tmux CCDECK_TEST_XTERM=/dir/with/node_modules \
//     npx vitest run tmux-control-tmux
//
// Each run gets its own `-L ccdeck-test-tc-*` server, started with no config
// file and killed afterwards, so neither the user's tmux nor the deck's own
// `-L ccdeck` server is ever touched. The programs in the panes come from
// tmux-control-tui.mjs.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { openControl, quoteTmuxArg } from "../../server/tmux-control.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { liveChildPids } from "../../server/exec-children.mjs";

/** A tmux this file may use, or null: CCDECK_TMUX, else `tmux` on PATH, 3.2+. */
function realTmux(): string | null {
  if (process.platform === "win32") return null;
  for (const bin of [process.env.CCDECK_TMUX, "tmux"]) {
    if (!bin) continue;
    const r = spawnSync(bin, ["-V"], { encoding: "utf8", timeout: 5000 });
    const m = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(r.stdout ?? "");
    if (r.status === 0 && m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2))) return bin;
  }
  return null;
}

interface Xterm { Terminal: new (o: object) => any; Widths: new () => object }
/** @xterm/headless and the graphemes addon, if this machine has them. */
function headlessXterm(): Xterm | null {
  const roots = [process.env.CCDECK_TEST_XTERM, fileURLToPath(new URL("../../../", import.meta.url))];
  for (const root of roots) {
    if (!root) continue;
    try {
      const req = createRequire(join(root, "resolve-from-here.js"));
      return { Terminal: req("@xterm/headless").Terminal, Widths: req("@xterm/addon-unicode-graphemes").UnicodeGraphemesAddon };
    } catch { /* not here */ }
  }
  return null;
}

const TMUX = realTmux();
const X = headlessXterm();
const SOCKET = `ccdeck-test-tc-${process.pid}-${randomBytes(3).toString("hex")}`;
const FIXTURE = fileURLToPath(new URL("./tmux-control-tui.mjs", import.meta.url));
const NODE = process.execPath;
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-tc-"));
// The tmux server's environment, which every pane inherits. Not nested in the
// developer's own tmux, and no $ENV for `sh` to source.
const ENV: NodeJS.ProcessEnv = { ...process.env, PS1: "$ " };
delete ENV.TMUX;
delete ENV.TMUX_PANE;
delete ENV.ENV;

/** Run tmux on this file's own server. `-u` so a capture is never degraded for
 *  a client tmux thinks cannot show UTF-8; `-f /dev/null` so no user config. */
function tm(...args: string[]): string {
  return execFileSync(TMUX!, ["-u", "-L", SOCKET, "-f", "/dev/null", ...args], { env: ENV, encoding: "utf8", timeout: 5000 });
}

const opened: any[] = [];
function open(opts: Record<string, unknown>) {
  const c = openControl({ tmux: TMUX, socket: { name: SOCKET }, ...opts });
  opened.push(c);
  return c;
}
afterEach(async () => { await Promise.all(opened.splice(0).map(c => c.close())); });
afterAll(() => {
  if (TMUX) {
    // tmux leaves its socket file behind when the server is killed, so it is
    // asked where that is first and the file is removed after — this run's
    // socket and nothing else.
    let socketPath = "";
    try { socketPath = tm("list-sessions", "-F", "#{socket_path}").split("\n")[0]; } catch { /* no server */ }
    try { tm("kill-server"); } catch { /* already gone */ }
    if (basename(socketPath) === SOCKET) rmSync(socketPath, { force: true });
  }
  rmTempDir(DIR);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const onAlt = (target: string) => tm("display-message", "-p", "-t", target, "#{alternate_on}").trim() === "1";
const paneOf = (target: string) => tm("display-message", "-p", "-t", target, "#{pane_id}").trim();

// ── the comparison with tmux's own screen ────────────────────────────────────

function makeTerm(cols: number, rows: number, scrollback = 0) {
  const t = new X!.Terminal({ cols, rows, scrollback, allowProposedApi: true });
  // The widths the stage draws with (use-terminal-session.ts): an emoji
  // sequence is one cluster, as tmux and Claude Code count it.
  t.loadAddon(new X!.Widths());
  return t;
}
const write = (t: any, data: string | Uint8Array) => new Promise<void>(r => t.write(data, r));

function cellKey(cell: any): string {
  if (!cell) return "∅";
  return [cell.getChars() || " ", cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(),
    cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isDim(), cell.isUnderline(), cell.isInverse(),
    cell.isStrikethrough()].join("|");
}

const isBlank = (cell: any) => !!cell && (cell.getChars() === "" || cell.getChars() === " ") && cell.getWidth() === 1;

/** Where the live emulator and tmux disagree about `pane`, if anywhere. */
async function differences(live: any, pane: string): Promise<string[]> {
  const [cx, cy, w, h] = tm("display-message", "-p", "-t", pane, "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}")
    .trim().split(" ").map(Number);
  const plain = tm("capture-pane", "-p", "-t", pane).split("\n").slice(0, h);
  const sgr = tm("capture-pane", "-p", "-e", "-N", "-t", pane).split("\n").slice(0, h);
  // tmux's rows written into an emulator of the same make, so attributes are
  // compared in one emulator's terms. Placed per row with no reset between
  // rows, because capture-pane carries attributes across a line end.
  const truth = makeTerm(w, h);
  let s = "\x1b[0m\x1b[H\x1b[2J";
  sgr.forEach((row, y) => { s += `\x1b[${y + 1};1H${row}`; });
  await write(truth, `${s}\x1b[0m\x1b[${cy + 1};${cx + 1}H`);
  const out: string[] = [];
  if (live.cols !== w || live.rows !== h) out.push(`size: live ${live.cols}x${live.rows}, tmux ${w}x${h}`);
  const lb = live.buffer.active, tb = truth.buffer.active;
  for (let y = 0; y < h && out.length < 8; y++) {
    const ll = lb.getLine(lb.baseY + y), tl = tb.getLine(tb.baseY + y);
    const liveText = (ll ? ll.translateToString(true) : "").replace(/\s+$/, "");
    const tmuxText = (plain[y] ?? "").replace(/\s+$/, "");
    if (liveText !== tmuxText) out.push(`row ${y}\n  live: ${JSON.stringify(liveText)}\n  tmux: ${JSON.stringify(tmuxText)}`);
    for (let x = 0; x < w; x++) {
      const lc = ll?.getCell(x), tc = tl?.getCell(x);
      const a = cellKey(lc), b = cellKey(tc);
      if (a === b) continue;
      // ONE KNOWN DISAGREEMENT, AND IT IS THE EMULATORS'. When a narrow glyph
      // overwrites half of a wide one (世, 🚀), the orphaned half becomes a
      // blank: xterm.js gives it the CURRENT pen, tmux the default. The stress
      // TUI does that constantly, so blank cells may differ in colour — and
      // only blank cells: with the wide glyphs taken out of the fixture, every
      // cell of these comparisons matched, attributes included. A byte lost on
      // the wire moves or changes glyphs, which the text and non-blank checks
      // still catch.
      if (isBlank(lc) && isBlank(tc)) continue;
      out.push(`cell ${x},${y}: live ${a} tmux ${b}`);
      break;
    }
  }
  if (lb.cursorX !== cx || lb.cursorY !== cy) out.push(`cursor: live ${lb.cursorX},${lb.cursorY} tmux ${cx},${cy}`);
  truth.dispose();
  return out;
}

/**
 * An emulator fed the way the panel feeds one: reset and seeded from seed(),
 * then every 'output' in order, resized at each 'size' at its place in the
 * stream. `settle` waits for the pane to go quiet and the writes to land.
 */
function mirror(c: any) {
  const term = makeTerm(80, 24, 3000);
  let chain: Promise<unknown> = Promise.resolve();
  let last = Date.now();
  c.on("output", (d: Buffer) => {
    last = Date.now();
    const copy = Buffer.from(d);
    chain = chain.then(() => write(term, copy));
  });
  c.on("size", ({ cols, rows }: { cols: number; rows: number }) => {
    last = Date.now();
    chain = chain.then(() => term.resize(cols, rows));
  });
  return {
    term,
    touch() { last = Date.now(); },
    async seed() {
      const s = await c.seed();
      // Queued before anything else can run, as seed() requires.
      chain = chain.then(async () => { term.reset(); term.resize(s.cols, s.rows); await write(term, s.bytes); });
      last = Date.now();
      await chain;
      return s;
    },
    async settle(quietMs = 400, maxMs = 8000) {
      const start = Date.now();
      while (Date.now() - start < maxMs && Date.now() - last < quietMs) await sleep(50);
      await chain;
    },
  };
}

// ── the cases ────────────────────────────────────────────────────────────────

describe("against a real tmux", () => {
  it("draws what tmux draws: seed then stream match tmux's own screen through bursts, resizes and a reseed mid-burst", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "fid", "-x", "120", "-y", "40", NODE, FIXTURE, "stress");
    await waitFor(() => onAlt("fid"), "the TUI to take the alternate screen");
    const c = open({ target: "fid" });
    await c.ready;
    expect(await c.resize(100, 30), "the dock sizes a window nobody else is attached to").toEqual({ ok: true, lines: [] });
    if (!X) {
      // No emulator here: the stream must still flow after a seed that says
      // "alternate screen", and stop being dropped once seeded.
      let bytes = 0;
      c.on("output", (d: Buffer) => { bytes += d.length; });
      const s = await c.seed();
      expect([s.cols, s.rows, s.alternate]).toEqual([100, 30, true]);
      expect(s.bytes.includes("\x1b[?1049h"), "the seed enters the alternate screen").toBe(true);
      await c.input("s");
      await waitFor(() => bytes > 10_000, "a burst of output");
      return;
    }
    const m = mirror(c);
    await m.seed();
    await m.settle();
    expect(await differences(m.term, "fid"), "as seeded").toEqual([]);

    m.touch();
    await c.input("s");
    await m.settle();
    expect(await differences(m.term, "fid"), "after a burst of 60 frames").toEqual([]);

    m.touch();
    await c.input("s");
    await sleep(300);
    await c.resize(80, 24);
    await sleep(300);
    await c.resize(110, 35);
    await m.settle();
    expect(await differences(m.term, "fid"), "after a burst through two resizes").toEqual([]);

    // The boundary rule under load: a second seed taken while the TUI is
    // writing flat out, then the stream that follows it.
    await c.input("r");
    await sleep(300);
    await m.seed();
    await sleep(600);
    m.touch();
    await c.input("q");
    await m.settle();
    expect(await differences(m.term, "fid"), "after a reseed in the middle of a burst").toEqual([]);
  }, 40_000);

  it("seeds the alternate screen with its modes, and the shell under it is there when the program leaves", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "alt", "-x", "100", "-y", "20", "sh");
    await sleep(200);
    tm("send-keys", "-t", "alt", "-l", "seq 1 30");
    tm("send-keys", "-t", "alt", "Enter");
    tm("send-keys", "-t", "alt", "-l", `'${NODE}' '${FIXTURE}' alt`);
    tm("send-keys", "-t", "alt", "Enter");
    await waitFor(() => onAlt("alt"), "the program to take the alternate screen");
    await sleep(200);
    // The panel opens now, late: everything below was set before it attached.
    const c = open({ target: "alt" });
    await c.ready;
    await c.resize(100, 20);
    if (!X) {
      const s = await c.seed();
      const text = s.bytes.toString("utf8");
      const enter = text.indexOf("\x1b[?1049h");
      expect(s.alternate).toBe(true);
      expect(enter, "the seed enters the alternate screen").toBeGreaterThan(0);
      expect(text.slice(0, enter), "after rebuilding the shell's screen under it").toMatch(/\r\n29 *\r\n30 *\r\n/);
      expect(text.slice(enter), "mouse and keypad modes are restated").toContain("\x1b[?1003h");
      return;
    }
    const m = mirror(c);
    await m.seed();
    await m.settle();
    expect(await differences(m.term, "alt"), "the alternate screen, as seeded").toEqual([]);
    expect(m.term.modes.mouseTrackingMode, "any-event mouse, set before the attach, is known").toBe("any");
    expect(m.term.modes.applicationCursorKeysMode, "cursor keys in application mode").toBe(true);
    expect(m.term.modes.applicationKeypadMode, "keypad in application mode").toBe(true);
    m.touch();
    await c.input("q");
    await waitFor(() => !onAlt("alt"), "the program to leave");
    await m.settle();
    expect(await differences(m.term, "alt"), "back on the shell, prompt where tmux puts it").toEqual([]);
    expect(m.term.modes.mouseTrackingMode, "and the program's own exit turned the mouse off again").toBe("none");
  }, 30_000);

  it("types raw bytes into the pane exactly, in order across send-keys chunks", async () => {
    if (!TMUX) return;
    const file = join(DIR, "typed.bin");
    tm("new-session", "-d", "-s", "rec", "-x", "80", "-y", "24", NODE, FIXTURE, "record", file);
    await waitFor(() => existsSync(`${file}.ready`), "the recorder");
    const c = open({ target: "rec" });
    await c.ready;
    const long = Buffer.alloc(1300);
    for (let i = 0; i < long.length; i++) long[i] = 0x61 + (i % 26);
    const sent = Buffer.concat([
      Buffer.from([0x03, 0x1b, 0x5b, 0x41, 0x0d, 0x7f, 0x09, 0x1b]),
      Buffer.from("héllo 世界 🚀 —\r", "utf8"),
      long,
    ]);
    expect(await c.input(sent), "1.3 KB is three send-keys commands").toEqual({ ok: true, lines: [] });
    expect(await c.input("tail")).toEqual({ ok: true, lines: [] });
    const want = Buffer.concat([sent, Buffer.from("tail")]);
    await waitFor(() => existsSync(file) && statSync(file).size >= want.length, "every byte to arrive");
    expect(readFileSync(file).equals(want), "Ctrl-C, ESC, DEL, UTF-8 and a long run, byte for byte and in order").toBe(true);
  });

  it("pastes text with newlines bracketed when the program asked for it, and plain when it did not", async () => {
    if (!TMUX) return;
    const asked = join(DIR, "bracketed.bin");
    const plain = join(DIR, "plain.bin");
    tm("new-session", "-d", "-s", "pb", "-x", "80", "-y", "24", NODE, FIXTURE, "record", asked, "bracketed");
    tm("new-session", "-d", "-s", "pp", "-x", "80", "-y", "24", NODE, FIXTURE, "record", plain);
    await waitFor(() => existsSync(`${asked}.ready`) && existsSync(`${plain}.ready`), "the recorders");
    const text = "first line\nsecond \"quoted\" $HOME ~/x ; #{pane_id}\r\nthird \\ end — 世界";
    // tmux turns each LF into CR, as a terminal paste does; CRLF was folded first.
    const body = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r");
    const a = open({ target: "pb" });
    const p = open({ target: "pp" });
    expect(await a.paste(text)).toEqual({ ok: true, lines: [] });
    expect(await p.paste(text)).toEqual({ ok: true, lines: [] });
    await waitFor(() => existsSync(asked) && existsSync(plain) && statSync(plain).size >= Buffer.byteLength(body), "the pastes");
    await waitFor(() => statSync(asked).size >= Buffer.byteLength(body) + 12, "the bracketed paste");
    expect(readFileSync(asked, "utf8"), "the program enabled bracketed paste, so the paste is wrapped")
      .toBe(`\x1b[200~${body}\x1b[201~`);
    expect(readFileSync(plain, "utf8"), "this one did not, so it is not").toBe(body);
    expect(tm("list-buffers", "-F", "#{buffer_name}"), "the staging buffers were deleted after use").not.toContain("ccdeck-paste");
  });

  it("quotes arguments so tmux's own parser hands back exactly the string", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "quote", "-x", "80", "-y", "24", "sh");
    const c = open({ target: "quote" });
    await c.ready;
    const file = join(DIR, "buffer.out");
    const samples = [
      "two words", "say \"hi\" and 'bye'", "$HOME and ${HOME} and $", "a;b; c ;", "~/notes", "~", "x ~y",
      "line\nbreak\n\n  indented", "tab\tand cr\r", "\x01\x1b[31mred\x7f", "héllo 世界 🚀 — ﬁ é",
      "back\\slash\\", "\\n is not a newline", "#{pane_id} #(echo hi) ##", "-looks-like-a-flag", "%if 1", "{ braces }",
    ];
    for (const s of samples) {
      const set = await c.cmd(`set-buffer -b ccdeck-test-quote -- ${quoteTmuxArg(s)}`);
      expect(set.ok, `set-buffer took ${JSON.stringify(s)}: ${set.lines.join(" ")}`).toBe(true);
      const save = await c.cmd(`save-buffer -b ccdeck-test-quote ${quoteTmuxArg(file)}`);
      expect(save.ok, `save-buffer: ${save.lines.join(" ")}`).toBe(true);
      await waitFor(() => existsSync(file), "the saved buffer");
      expect(readFileSync(file, "utf8"), "the buffer holds exactly what was quoted").toBe(s);
    }
  });

  it("with ignoreSize, leaves a 200-column window at 200, reports the pane's size, and does not move the user's window", async () => {
    if (!TMUX) return;
    const idle = join(DIR, "idle.bin");
    tm("new-session", "-d", "-s", "wide", "-x", "200", "-y", "50", NODE, FIXTURE, "record", idle);
    tm("new-window", "-t", "wide", NODE, FIXTURE, "record", `${idle}.2`);
    tm("select-window", "-t", "wide:0");
    // The user's own terminal, 200 columns wide.
    const user = open({ target: "wide" });
    await user.ready;
    await user.resize(200, 50);
    const pane = paneOf("wide:1");
    // Case B: the panel attaches by pane, ignoring size.
    const dock = open({ target: pane, ignoreSize: true });
    const r = await dock.ready;
    expect([r.pane, r.cols, r.rows], "it streams the pane it was given, at that pane's size").toEqual([pane, 200, 50]);
    expect(tm("display-message", "-p", "-t", "wide", "#{window_index}").trim(),
      "attaching by pane would have made window 1 current; attaching by its session does not").toBe("0");
    expect(await dock.resize(80, 24), "the panel's own size is not asked for").toEqual({ ok: true, lines: [] });
    await sleep(200);
    expect(tm("display-message", "-p", "-t", pane, "#{window_width}x#{window_height}").trim(), "the window kept its size")
      .toBe("200x50");
    const seed = await dock.seed();
    expect([seed.cols, seed.rows], "the panel draws at the pane's size").toEqual([200, 50]);

    const sizes: unknown[] = [];
    dock.on("size", (s: unknown) => sizes.push(s));
    tm("resize-window", "-t", "wide:1", "-x", "150", "-y", "40");
    await waitFor(() => sizes.length > 0, "the size event");
    expect(sizes, "a change made elsewhere is reported").toEqual([{ cols: 150, rows: 40 }]);

    // The control this case is measured against: the same attach WITHOUT
    // ignore-size takes the window to its own size.
    tm("resize-window", "-t", "wide:1", "-A");
    const shrinking = open({ target: "wide" });
    await shrinking.ready;
    await shrinking.resize(120, 40);
    await waitFor(() => tm("display-message", "-p", "-t", "wide:0", "#{window_width}").trim() === "120", "the shrink");
  }, 30_000);

  it("leaves the user's session environment as it was: update-environment is not applied from the deck's", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "envs", NODE, FIXTURE, "record", join(DIR, "envs.bin"));
    // What the user's own desktop terminal put there when it made the session.
    tm("set-environment", "-t", "envs", "SSH_AUTH_SOCK", "/run/user/1000/agent.sock");
    tm("set-environment", "-t", "envs", "DISPLAY", ":0");
    const sessionEnv = () => tm("show-environment", "-t", "envs").split("\n").filter(l => /^-?(SSH_AUTH_SOCK|DISPLAY)\b/.test(l)).sort();
    const before = sessionEnv();
    expect(before).toEqual(["DISPLAY=:0", "SSH_AUTH_SOCK=/run/user/1000/agent.sock"]);
    // A deck started by a login item: no agent socket, no display, both of
    // which are on tmux's default update-environment list.
    const deckEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" };
    const c = open({ target: paneOf("envs"), pane: paneOf("envs"), ignoreSize: true, env: deckEnv });
    await c.ready;
    await c.seed();
    expect(sessionEnv(), "attaching did not strip or replace them").toEqual(before);
    await c.close();
    expect(sessionEnv(), "nor did leaving").toEqual(before);
  }, 30_000);

  it("recovers from a %pause: tmux is told to continue, 'reseed' fires, and the new seed matches tmux's screen", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "slow", "-x", "100", "-y", "30", NODE, FIXTURE, "stress");
    await waitFor(() => onAlt("slow"), "the TUI");
    let child: ChildProcess | null = null;
    const c = open({ target: "slow", pauseAfter: 1,
      spawn: (file: string, args: string[], opts: SpawnOptions) => (child = spawn(file, args, opts)) });
    await c.ready;
    await c.resize(100, 30);
    const m = X ? mirror(c) : null;
    let bytes = 0;
    c.on("output", (d: Buffer) => { bytes += d.length; });
    const reseeds: Promise<unknown>[] = [];
    // What the panel does with the event: seed again.
    c.on("reseed", () => { reseeds.push(m ? m.seed() : c.seed()); });
    await (m ? m.seed() : c.seed());
    await c.input("r");
    await sleep(300);
    // A reader that has stopped reading — a stalled browser tab, in effect.
    child!.stdout!.pause();
    await sleep(2500);
    child!.stdout!.resume();
    await waitFor(() => reseeds.length > 0, "the reseed", 8000);
    await Promise.all(reseeds);
    const after = bytes;
    await waitFor(() => bytes > after + 5000, "output to flow again after the continue");
    m?.touch();
    await c.input("q");
    if (m) {
      await m.settle();
      expect(await differences(m.term, "slow"), "after the pause and the reseed").toEqual([]);
    }
  }, 40_000);

  it("is reaped with the deck's children while open, and close() detaches without ending the session", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "life", "-x", "80", "-y", "24", NODE, FIXTURE, "record", join(DIR, "life.bin"));
    const c = open({ target: "life" });
    const exits: unknown[] = [];
    c.on("exit", (e: unknown) => exits.push(e));
    await c.ready;
    const pid = c.pid;
    expect(liveChildPids(), "registered with watchChild, so shutdown reaps it").toContain(pid);
    expect(tm("list-clients", "-t", "life").trim(), "attached as a client of that session").not.toBe("");
    await c.close();
    expect(exits).toEqual([{ reason: "closed" }]);
    expect(liveChildPids(), "gone from the set once tmux has gone").not.toContain(pid);
    expect(() => tm("has-session", "-t", "=life"), "the session is still running").not.toThrow();
    expect(tm("list-clients", "-t", "life").trim(), "with nobody attached").toBe("");
  });

  it("reports a program that exits as 'ended', and can still seed its last frame", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "dies", "-x", "80", "-y", "24", NODE, FIXTURE, "stress");
    tm("set-option", "-p", "-t", "dies", "remain-on-exit", "on");
    await waitFor(() => onAlt("dies"), "the TUI");
    const c = open({ target: "dies" });
    const exits: unknown[] = [];
    c.on("exit", (e: unknown) => exits.push(e));
    await c.ready;
    await c.seed();
    await c.input("x");
    await waitFor(() => exits.length > 0, "the exit", 6000);
    expect(exits, "tmux reports the death within a second, through the subscription").toEqual([{ reason: "ended" }]);
    const last = await c.seed();
    expect([last.cols, last.rows], "remain-on-exit kept the pane, and its frame can be read").toEqual([80, 24]);
  });

  it("tells a detach, where the pane lives on, from a session that was killed", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "det", "-x", "80", "-y", "24", NODE, FIXTURE, "record", join(DIR, "det.bin"));
    tm("new-session", "-d", "-s", "kil", "-x", "80", "-y", "24", NODE, FIXTURE, "record", join(DIR, "kil.bin"));
    const d = open({ target: "det" });
    const k = open({ target: "kil" });
    const exits: Record<string, unknown> = {};
    d.on("exit", (e: unknown) => { exits.det = e; });
    k.on("exit", (e: unknown) => { exits.kil = e; });
    await Promise.all([d.ready, k.ready]);
    tm("detach-client", "-s", "det");
    tm("kill-session", "-t", "kil");
    await waitFor(() => Object.keys(exits).length === 2, "both exits");
    expect(exits, "someone else's detach is not the session ending, and vice versa")
      .toEqual({ det: { reason: "detached" }, kil: { reason: "ended" } });
  });

  it("attaches to a session whose name ends in a semicolon, which tmux's command line would split on", async () => {
    if (!TMUX) return;
    // Created with tmux's own escape, as the CLI needs it; opened by its real name.
    tm("new-session", "-d", "-s", "notes\\;", "-x", "80", "-y", "24", "sh");
    tm("new-session", "-d", "-s", "notes", "-x", "80", "-y", "24", "sh");
    const c = open({ target: "notes;" });
    const r = await c.ready;
    expect(tm("display-message", "-p", "-t", r.pane, "#{session_name}").trim(), "the session asked for, not its prefix")
      .toBe("notes;");
  });

  it("rejects ready and reports 'ended' for a session that is not there", async () => {
    if (!TMUX) return;
    tm("new-session", "-d", "-s", "here", "-x", "80", "-y", "24", "sh");
    const c = open({ target: "not-here" });
    const exits: unknown[] = [];
    c.on("exit", (e: unknown) => exits.push(e));
    await expect(c.ready).rejects.toThrow(/can't find session/);
    expect(exits).toEqual([{ reason: "ended", message: expect.stringMatching(/can't find session/) }]);
  });
});
