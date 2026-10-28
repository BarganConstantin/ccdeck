// What the UTF-8 frame-edge suites share: the vectors, the punctuation-heavy
// text cut by a seeded generator, an emulator of the make the panel writes to,
// and a relay (terminal-bridge.mjs) driven by a stand-in tmux client.
//
// THE VECTORS ARE A BLACK-BOX CONTRACT. Each is a list of `%output` frames for
// one pane, bytes in hex, and whether the stream ends after them. They are
// judged only on what the panel receives: the frames, concatenated, are the
// input (less an unfinished character still held when the stream ends);
// every frame ends on a character boundary unless the bytes there can never
// finish one; and the frames written one by one to xterm.js draw what the
// whole input written at once draws.
//
// Plain .mjs, so a script outside the suite can play the same vectors through
// the same relay. No vitest in here.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** "41 E2 80" → its bytes. */
export const hex = (s) => Buffer.from(String(s).replace(/\s+/g, ""), "hex");
/** Bytes → "41 E2 80". */
export const toHex = (b) => [...b].map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");

/** The contract's vectors: [name, frames, { end }]. `heavy` is heavyFrames(). */
export const VECTORS = [
  ["ascii", ["41 42 43", "44"]],
  ["emdash-whole", ["41 E2 80 94 42"]],
  ["emdash-cut-1", ["41 E2", "80 94 42"]],
  ["emdash-cut-2", ["41 E2 80", "94 42"]],
  ["ellipsis-cut-2", ["41 E2 80", "A6 42"]],
  ["rsquo-cut-2", ["E2 80", "99"]],
  ["rdquo-cut-2", ["E2 80", "9D 20 41"]],
  ["emdash-bytewise", ["E2", "80", "94"]],
  ["combining-cut-in-mark", ["65 CC", "81 42"]],
  ["combining-cut-before-mark", ["65", "CC 81"]],
  ["rocket-bytewise", ["F0", "9F", "9A", "80"]],
  ["mahjong-cut-3", ["F0 9F 80", "80 41"]],
  ["mahjong-cut-2", ["F0 9F", "80 80 41"]],
  ["mixed-bytewise", "61 E2 80 94 62 E2 80 A6 63 E2 80 99 64 E2 80 9D 65".split(" ")],
  ["cjk-cut", ["E4 B8", "96"]],
  ["euro-cut", ["E2 82", "AC"]],
  ["sgr-around", ["1B 5B 33 31 6D E2 80", "94 1B 5B 30 6D"]],
  ["bad-lone-cont", ["41 80 42"]],
  ["bad-trunc-then-ascii", ["41 E2 80", "41"]],
  ["bad-overlong", ["C0 80 41"]],
  ["bad-f5", ["F5 80 80 80 41"]],
  ["bad-surrogate", ["ED A0", "80 41"]],
  ["bad-e0-low", ["E0 80", "80 41"]],
  ["end-incomplete", ["41 E2 80"], { end: true }],
];

/** The contract's heavy line, as the pane would write it. */
export const HEAVY_LINE = "agent output — with a dash … and an ellipsis — again, then words ’quoted’ ”done”\r\n";

/**
 * `text` repeated `repeat` times, cut into frames whose sizes come from
 * x = (1103515245 x + 12345) mod 2^31 starting at `seed`: x is updated, then
 * the frame is 1 + (x mod `max`) bytes, and the last frame takes what is left.
 */
export function heavyFrames({ seed = 42, repeat = 3000, text = HEAVY_LINE, max = 2048 } = {}) {
  const all = Buffer.from(text.repeat(repeat), "utf8");
  const frames = [];
  let x = BigInt(seed);
  for (let at = 0; at < all.length;) {
    x = (1103515245n * x + 12345n) % 2147483648n;
    const size = 1 + Number(x % BigInt(max));
    frames.push(all.subarray(at, Math.min(all.length, at + size)));
    at += size;
  }
  return frames;
}

/**
 * How many of `frames` end inside a character of the stream they make up
 * together. For valid UTF-8 a position is a boundary exactly when the byte
 * there is not a continuation byte (10xxxxxx), so this needs no decoder.
 */
export function framesNotOnBoundary(frames) {
  const all = Buffer.concat(frames);
  let at = 0;
  let cut = 0;
  for (const f of frames) {
    at += f.length;
    if (at < all.length && (all[at] & 0xc0) === 0x80) cut++;
  }
  return cut;
}

/**
 * @xterm/headless (the version the panel ships: 6.0.0) and the graphemes
 * addon the panel loads, from CCDECK_TEST_XTERM (a directory whose
 * node_modules holds them) or from this checkout; null when neither has them.
 * Headless is not a dependency of the deck.
 */
export function headlessXterm() {
  const roots = [process.env.CCDECK_TEST_XTERM, fileURLToPath(new URL("../../../", import.meta.url))];
  for (const root of roots) {
    if (!root) continue;
    try {
      const req = createRequire(join(root, "resolve-from-here.js"));
      const { Terminal } = req("@xterm/headless");
      let Graphemes = null;
      try { Graphemes = req("@xterm/addon-unicode-graphemes").UnicodeGraphemesAddon; } catch { /* plain widths only */ }
      return { Terminal, Graphemes, version: req("@xterm/headless/package.json").version };
    } catch { /* not here */ }
  }
  return null;
}

/** A fresh emulator: 120x40 by default, scrollback 0, the proposed API on. */
export function makeTerminal(X, { cols = 120, rows = 40, scrollback = 0, graphemes = false } = {}) {
  const t = new X.Terminal({ cols, rows, scrollback, allowProposedApi: true });
  if (graphemes && X.Graphemes) t.loadAddon(new X.Graphemes());
  return t;
}

export const writeTo = (t, data) => new Promise((resolve) => t.write(data, resolve));

/** The active buffer, scrollback included: rows joined by \n, trailing spaces trimmed. */
export function screenText(t) {
  const b = t.buffer.active;
  const rows = [];
  for (let i = 0; i < b.length; i++) rows.push(b.getLine(i)?.translateToString(true) ?? "");
  return rows.join("\n");
}

/**
 * What `frames`, written one write each to a fresh emulator, leave on it.
 * Each frame is its own write() call, as the panel makes them — without
 * waiting for the one before, as the panel does not — and xterm.js decodes
 * each write on its own, keeping what a write left unfinished for the next.
 */
export async function screenOf(X, frames, opts = {}) {
  const t = makeTerminal(X, opts);
  for (const f of frames) t.write(Uint8Array.from(f));
  await writeTo(t, "");
  const s = screenText(t);
  t.dispose();
  return s;
}

// ── the relay, driven by a stand-in tmux client ─────────────────────────────

/** The socket side of the relay: records every frame in order. */
export class RecordingConn {
  sent = [];
  closes = [];
  bufferedAmount = 0;
  open = true;
  sendText(text) { if (!this.open) return false; this.sent.push({ type: "text", msg: JSON.parse(text) }); return true; }
  sendBinary(data) { if (!this.open) return false; this.sent.push({ type: "binary", data: Buffer.from(data) }); return true; }
  close(code = 1000, reason = "") { this.closes.push([code, reason]); this.open = false; }
  /** The binary frames from index `from` of `sent` on. */
  binaries(from = 0) { return this.sent.slice(from).filter((s) => s.type === "binary").map((s) => s.data); }
}

/**
 * What tmux-control.mjs is to the relay, with the pane's output in the test's
 * hands: emit('output', bytes), emit('reseed'), emit('exit', { reason }).
 * Each seed is RIS (a reset terminal), unless `seedBytes(n)` says otherwise.
 */
export class StandInControl extends EventEmitter {
  seeds = 0;
  closes = 0;
  inputs = [];
  size = { cols: 120, rows: 40 };
  /** (n) => Buffer: the bytes of the n-th seed. */
  seedBytes = () => Buffer.from("\x1bc", "latin1");
  /** (n) => void: runs inside the n-th seed() before it resolves — where
   *  tmux-control emits a stale seed's 'reseed', or a %pause lands. */
  duringSeed = null;
  constructor(opts) { super(); this.opts = opts; }
  async seed() {
    const n = ++this.seeds;
    await Promise.resolve();
    this.duringSeed?.(n);
    return { bytes: this.seedBytes(n), cols: this.size.cols, rows: this.size.rows, cursor: [0, 0], alternate: false };
  }
  async resize(cols, rows) { this.size = { cols, rows }; return { ok: true, lines: [] }; }
  async input(bytes) { this.inputs.push(Buffer.from(bytes)); return { ok: true, lines: [] }; }
  async paste() { return { ok: true, lines: [] }; }
  serverVersion() { return Promise.resolve(null); }
  async colours() { return { ok: true, lines: [] }; }
  async close() { this.closes++; }
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Let the relay's promise chain run until `cond()` holds (or give up). */
export async function settleUntil(cond, turns = 200) {
  for (let i = 0; i < turns && !cond(); i++) await turn();
  return cond();
}

/**
 * A relay (terminalBridge from terminal-bridge.mjs) on a stand-in client,
 * brought up to its first seed at 120x40. `options` go to terminalBridge.
 * Answers { conn, socket, handle, control, text(msg), mark() } — mark() is the
 * index in conn.sent from which frames are new.
 */
export async function openRelay(terminalBridge, options = {}) {
  const conn = new RecordingConn();
  const socket = new EventEmitter();
  let control = null;
  const handle = terminalBridge({
    conn,
    socket,
    binding: { kind: "A", tmux: "/bin/tmux", socket: { name: "ccdeck-test-utf8" }, target: "ccdeck-claude-0a1b2c3d", pane: "%4", ignoreSize: false },
    open: (o) => (control = new StandInControl(o)),
    debounceMs: 5,
    ...options,
  });
  const text = (msg) => handle.message({ type: "text", data: Buffer.from(JSON.stringify(msg)) });
  text({ t: "size", cols: 120, rows: 40 });
  if (!(await settleUntil(() => conn.sent.some((s) => s.type === "binary")))) throw new Error("the relay never sent its first seed");
  return { conn, socket, handle, control: () => control, text, mark: () => conn.sent.length };
}

/**
 * One vector through the relay: its frames as the pane's output after the
 * first seed, then the end of the stream if `end`. Answers the binary frames
 * the panel got after the seed, how many input bytes did not reach it, and
 * every frame after the seed (text frames as their `t`).
 */
export async function playVector(terminalBridge, frames, { end = false } = {}) {
  const r = await openRelay(terminalBridge);
  const from = r.mark();
  for (const f of frames) r.control().emit("output", Buffer.from(f));
  const bytesIn = frames.reduce((n, f) => n + f.length, 0);
  const sentBefore = r.conn.binaries(from).reduce((n, f) => n + f.length, 0);
  if (end) {
    r.control().emit("exit", { reason: "ended" });
    await settleUntil(() => r.conn.closes.length > 0);
  }
  const framesOut = r.conn.binaries(from);
  const bytesOut = framesOut.reduce((n, f) => n + f.length, 0);
  return {
    framesOut,
    // Held when the input ran out: what the relay had not sent by then.
    held: bytesIn - sentBefore,
    // And what never reached the panel at all, once the stream had ended.
    lost: bytesIn - bytesOut,
    after: r.conn.sent.slice(from).map((s) => (s.type === "text" ? s.msg.t : "binary")),
  };
}
