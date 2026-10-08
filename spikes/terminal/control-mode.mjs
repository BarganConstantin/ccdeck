#!/usr/bin/env node
// SPIKE — ccdeck-internal#11. Throwaway: nothing here ships.
//
// The question: can `tmux -C` carry Claude Code's full-screen TUI, or is the
// zero-dependency property going to be spent on a pty after all?
//
// The control is tmux itself, not a pair of eyes. tmux keeps its own emulator's
// idea of every pane, and `capture-pane` reads it back. So the test is: feed the
// raw `%output` stream into an xterm, drive the TUI through the repaints it
// actually does, and after each one ask whether xterm's screen and tmux's screen
// are the same screen — text row by row, attributes cell by cell, and the
// cursor. Any difference is something the dock would draw wrong.
//
//   node spikes/terminal/control-mode.mjs --tmux <bin> -L <socket> -t <session> \
//        --xterm <dir holding node_modules/@xterm> [--record <file>] [--no-unicode11]
//
// No pty and no native module anywhere in this file: tmux is a child with three
// pipes. That is the property under test as much as the fidelity is.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TMUX = opt("--tmux", "tmux"), SOCKET = opt("-L", "ccdeck-spike"), SESSION = opt("-t", "ccdeck-a");
const require = createRequire(path.join(path.resolve(opt("--xterm", ".")), "x.js"));
const { Terminal } = require("@xterm/headless");
const { Unicode11Addon } = require("@xterm/addon-unicode11");
const UNICODE11 = !argv.includes("--no-unicode11");
const RECORD = opt("--record");
const DUMP = opt("--dump");     // every %output byte for the pane, decoded, in order

// `%output` escapes every byte below 0x20 and the backslash as \ooo; every other
// byte, UTF-8 included, arrives as itself. So the line is split on 0x0a, which
// can never be data, and decoded as bytes, never as a string.
function unescapeOutput(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x5c && i + 3 < buf.length + 0 && isOct(buf[i + 1]) && isOct(buf[i + 2]) && isOct(buf[i + 3])) {
      out[n++] = ((buf[i + 1] - 48) << 6) | ((buf[i + 2] - 48) << 3) | (buf[i + 3] - 48);
      i += 3;
    } else out[n++] = b;
  }
  return out.subarray(0, n);
}
const isOct = (c) => c >= 48 && c <= 55;

class Control {
  constructor() {
    this.p = spawn(TMUX, ["-L", SOCKET, "-C", "attach", "-t", SESSION], { stdio: ["pipe", "pipe", "pipe"] });
    this.buf = Buffer.alloc(0);
    this.block = null;
    // attach-session's own reply is the first block; it is the "ready" signal.
    this.waiters = [];
    this.ready = new Promise(r => this.waiters.push(r));
    this.onOutput = () => {};
    this.notes = {};
    this.p.stdout.on("data", d => this.feed(d));
    this.p.stderr.on("data", d => process.stderr.write(`[tmux] ${d}`));
  }
  feed(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let i;
    while ((i = this.buf.indexOf(10)) >= 0) {
      const line = this.buf.subarray(0, i);
      this.buf = this.buf.subarray(i + 1);
      this.line(line);
    }
  }
  line(raw) {
    const head = raw.subarray(0, 16).toString("latin1");
    if (this.block) {
      if (head.startsWith("%end ") || head.startsWith("%error ")) {
        const b = this.block; this.block = null;
        this.waiters.shift()?.({ ok: head.startsWith("%end "), lines: b });
      } else this.block.push(raw.toString("utf8"));
      return;
    }
    if (head.startsWith("%begin ")) { this.block = []; return; }
    if (head.startsWith("%output ")) {
      const sp = raw.indexOf(32, 8);
      this.onOutput(raw.subarray(8, sp).toString("latin1"), unescapeOutput(raw.subarray(sp + 1)));
      return;
    }
    const kind = head.split(" ")[0];
    this.notes[kind] = (this.notes[kind] ?? 0) + 1;
  }
  cmd(c) {
    return new Promise(r => { this.waiters.push(r); this.p.stdin.write(c + "\n"); });
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const write = (t, data) => new Promise(r => t.write(data, r));

function makeTerm(cols, rows) {
  const t = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  if (UNICODE11) { t.loadAddon(new Unicode11Addon()); t.unicode.activeVersion = "11"; }
  return t;
}

// What tmux says is on the pane. -e for attributes, -N so trailing cells keep
// their background, no -J so one captured line is one screen row.
async function tmuxScreen(c, pane) {
  const fmt = "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{alternate_on} #{cursor_flag}";
  const [plain, sgr, info] = [
    await c.cmd(`capture-pane -p -t ${pane}`),
    await c.cmd(`capture-pane -p -e -N -t ${pane}`),
    await c.cmd(`display-message -p -t ${pane} '${fmt}'`),
  ];
  const [cx, cy, w, h, alt, cur] = info.lines[0].split(" ").map(Number);
  return { plain: plain.lines, sgr: sgr.lines, cx, cy, w, h, alt, cursorVisible: cur };
}

// The same rows written into an xterm, so attributes can be compared cell for
// cell in one emulator's terms. Positioned per row, with no reset between rows:
// capture-pane carries a run of attributes across a line end.
async function seed(t, screen) {
  let s = "\x1b[0m\x1b[H\x1b[2J";
  screen.sgr.forEach((row, y) => { s += `\x1b[${y + 1};1H${row}`; });
  s += `\x1b[0m\x1b[${screen.cy + 1};${screen.cx + 1}H`;
  await write(t, s);
}

function cellKey(cell) {
  if (!cell) return "∅";
  return [cell.getChars() || " ", cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(),
    cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isDim(), cell.isUnderline(), cell.isInverse(),
    cell.isStrikethrough()].join("|");
}

function compare(live, truth, screen) {
  const lb = live.buffer.active, tb = truth.buffer.active;
  const textRows = [], attrCells = [];
  for (let y = 0; y < screen.h; y++) {
    const ll = lb.getLine(lb.baseY + y), tl = tb.getLine(tb.baseY + y);
    const liveText = ll ? ll.translateToString(true) : "";
    const tmuxText = (screen.plain[y] ?? "").replace(/\s+$/, "");
    if (liveText.replace(/\s+$/, "") !== tmuxText) textRows.push({ y, live: liveText, tmux: tmuxText });
    for (let x = 0; x < screen.w; x++) {
      const a = cellKey(ll?.getCell(x)), b = cellKey(tl?.getCell(x));
      if (a !== b) attrCells.push({ x, y, live: a, tmux: b });
    }
  }
  const cursor = lb.cursorX === screen.cx && lb.cursorY === screen.cy;
  return { textRows, attrCells, cursor, liveCursor: [lb.cursorX, lb.cursorY], tmuxCursor: [screen.cx, screen.cy] };
}

// ── the run ──────────────────────────────────────────────────────────────────
const c = new Control();
await c.ready;
const pane = (await c.cmd(`display-message -p -t ${SESSION} '#{pane_id}'`)).lines[0];
let cols = 120, rows = 40;
await c.cmd(`refresh-client -C ${cols}x${rows}`);
await sleep(400);

const live = makeTerm(cols, rows);
const modes = new Map();      // DEC private modes and other things the TUI asked of its terminal
const record = [];
let bytes = 0, chunks = 0, lastOut = Date.now(), seeded = false, dropped = 0;
let chain = Promise.resolve();
c.onOutput = (id, data) => {
  if (id !== pane) return;
  if (!seeded) { dropped += data.length; return; }
  bytes += data.length; chunks++; lastOut = Date.now();
  if (RECORD) record.push({ t: Date.now(), b: data.toString("base64") });
  if (DUMP) appendFileSync(DUMP, data);
  const s = data.toString("latin1");
  for (const m of s.matchAll(/\x1b\[(\?[\d;]+[hl]|[>=<]\d*u|\?u)/g)) modes.set(m[1], (modes.get(m[1]) ?? 0) + 1);
  const copy = Buffer.from(data);
  chain = chain.then(() => write(live, copy));
};

const first = await tmuxScreen(c, pane);
await seed(live, first);
seeded = true;

async function settle(quietMs = 350, maxMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(50);
    if (Date.now() - lastOut >= quietMs) break;
  }
  await chain;
}

async function check(name, act, maxMs) {
  const b0 = bytes, n0 = chunks, t0 = Date.now();
  // Quiet is measured from the action, not from the last output before it —
  // otherwise a TUI that takes 100 ms to answer is compared before it answers.
  lastOut = Date.now();
  await act();
  lastOut = Math.max(lastOut, Date.now());
  await settle(350, maxMs);
  const screen = await tmuxScreen(c, pane);
  if (screen.w !== live.cols || screen.h !== live.rows) live.resize(screen.w, screen.h);
  const truth = makeTerm(screen.w, screen.h);
  await seed(truth, screen);
  const r = compare(live, truth, screen);
  const verdict = !r.textRows.length && !r.attrCells.length && r.cursor ? "SAME" : "DIFF";
  console.log(`${verdict}  ${name.padEnd(34)} ${String(bytes - b0).padStart(7)} B in ${String(chunks - n0).padStart(4)} %output, ` +
    `settled ${Date.now() - t0} ms · text rows off ${r.textRows.length} · cells off ${r.attrCells.length} · cursor ${r.cursor ? "ok" : `live ${r.liveCursor} tmux ${r.tmuxCursor}`}`);
  for (const d of r.textRows.slice(0, 4)) console.log(`      row ${d.y}\n        live: ${JSON.stringify(d.live.slice(0, 110))}\n        tmux: ${JSON.stringify(d.tmux.slice(0, 110))}`);
  for (const d of r.attrCells.slice(0, 3)) console.log(`      cell ${d.x},${d.y} live ${d.live}  tmux ${d.tmux}`);
  truth.dispose();
  return verdict;
}

// The emulator resizes at the point in the stream where tmux answered: output
// queued before the reply was drawn at the old size, output after it at the new.
const resize = async (w, h) => { await c.cmd(`refresh-client -C ${w}x${h}`); chain = chain.then(() => live.resize(w, h)); };
const keys = (k) => c.cmd(`send-keys -t ${pane} ${k}`);
const literal = (s) => c.cmd(`send-keys -t ${pane} -l ${JSON.stringify(s)}`);
// The dock will forward xterm's onData bytes as they are; -H is that path.
const hex = (s) => c.cmd(`send-keys -t ${pane} -H ${[...Buffer.from(s, "utf8")].map(b => b.toString(16).padStart(2, "0")).join(" ")}`);

console.log(`pane ${pane} · ${cols}x${rows} · unicode ${UNICODE11 ? "11" : "6 (xterm default)"} · seeded from capture-pane, ${dropped} B before the seed dropped by design\n`);
// The modes a TUI set before the dock attached never pass through %output, so
// the emulator cannot learn them from the stream. What tmux will say about them:
const FLAGS = ["alternate_on", "cursor_flag", "insert_flag", "keypad_cursor_flag", "keypad_flag", "mouse_any_flag",
  "mouse_button_flag", "mouse_standard_flag", "mouse_sgr_flag", "mouse_utf8_flag", "origin_flag", "wrap_flag",
  "scroll_region_upper", "scroll_region_lower", "bracket_paste_flag", "focus_flag", "extended_keys_flag", "synchronized_output_flag"];
const probe = (await c.cmd(`display-message -p -t ${pane} '${FLAGS.map(f => `${f}=#{${f}}`).join(" ")}'`)).lines[0];
console.log(`mode flags tmux exposes for ${pane}: ${probe}\n`);
const SCENARIO = opt("--scenario", "claude");
const results = [];
results.push(await check("idle, as seeded", async () => {}));
if (SCENARIO === "stress") {
  results.push(await check("stress: 3 s burst, alt screen", () => hex("s"), 10000));
  results.push(await check("stress: burst while resizing", async () => { await hex("s"); await sleep(700); await resize(100, 30); await sleep(700); await resize(120, 40); }, 10000));
} else if (SCENARIO === "race") {
  // Seeded above while the burst was already running: the boundary rule under load.
  results.push(await check("race: seeded mid-burst, then settled", async () => { await sleep(1500); await hex("q"); }, 10000));
} else {
results.push(await check("type '/' (command menu)", () => literal("/")));
results.push(await check("down ×3, up ×1 in the menu", async () => { for (const k of ["Down", "Down", "Down", "Up"]) { await keys(k); await sleep(80); } }));
results.push(await check("type 'mod' (menu filters)", () => literal("mod")));
results.push(await check("ctrl-u clears the line", () => keys("C-u")));
results.push(await check("unicode via -H: é 世界 ✻ 🚀 —", () => hex("héllo 世界 ✻ 🚀 — ok")));
results.push(await check("fast typing, 60 chars one by one", async () => { for (const ch of "the quick brown fox jumps over the lazy dog 0123456789 abcdef") await hex(ch); }));
results.push(await check("resize to 100x30", () => resize(100, 30)));
results.push(await check("resize to 80x24", () => resize(80, 24)));
results.push(await check("resize back to 120x40", () => resize(120, 40)));
results.push(await check("ctrl-u clears again", () => keys("C-u")));
}

console.log(`\nmodes the TUI set on its terminal (seen raw in %output): ${[...modes].map(([k, v]) => `ESC[${k}×${v}`).join("  ") || "none"}`);
console.log(`other notifications: ${JSON.stringify(c.notes)}`);
console.log(`${results.filter(r => r === "SAME").length}/${results.length} scenarios identical to tmux's own screen`);
if (RECORD) writeFileSync(RECORD, JSON.stringify({ cols: 120, rows: 40, seed: first.sgr, cursor: [first.cx, first.cy], chunks: record }));
c.p.stdin.end();
c.p.kill();
process.exit(0);
