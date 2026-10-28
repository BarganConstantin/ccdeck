// The relay's whole characters on a real tmux: a pane writes punctuation-
// heavy text, tmux-control.mjs reads it as tmux sends it, terminal-bridge.mjs
// relays it, and a panel stand-in writes every frame to xterm.js on its own,
// as the panel does. What it draws must be what tmux has — every line of the
// history, not only the screen — and no frame may end inside a character.
//
// tmux ends a %output line where its read of the pane ended, so a line can
// stop inside a character, and xterm.js loses a character cut right after a
// 0x80 byte ("—" cut as E2 80 | 94). The pane program (utf8-burst-tui.mjs)
// makes that certain with characters written in two halves 30 ms apart, and
// likely as well with a burst tmux cuts on its own. The case checks that tmux
// really did cut a line inside a character, so it cannot pass by not
// meeting the problem. terminal-bridge-utf8.test.ts has the rule byte by
// byte, with a stand-in for tmux.
//
// The seed is one frame and one write, and with a long history it is longer
// than xterm.js decodes in one piece (131072 bytes), which can cut a
// character as two writes do. The second case writes 300 KB of history and
// checks the seed's every line — first open, live output after it, a reopen —
// at the alignments where a piece edge cuts a character after a 0x80. A
// %output line is no such frame: tmux 3.4 and 3.8 put at most 8192 / 3 bytes
// of output on one (control.c, CONTROL_BUFFER_HIGH), and the first case
// records the longest it saw.
//
// ITS OWN tmux SERVER. A socket named for this run (`-L ccdeck-test-u8-*`),
// no config file, in whatever TMUX_TMPDIR the run has; killed, and its socket
// file removed, in afterAll. Never the deck's `-L ccdeck` and never the
// user's. SKIPPED ON WINDOWS, which has no tmux (skip-gates.mjs). Elsewhere
// it needs tmux 3.2+ (CCDECK_TMUX, or tmux on PATH) and @xterm/headless (a
// devDependency; CCDECK_TEST_XTERM points elsewhere): without tmux the case
// returns, without the emulator the screen comparison gives way to the byte
// checks, and the run says NOT TESTED — except in CI, which installs both
// and fails a case that finds one missing (kit.needed). To run all of it:
//
//   CCDECK_TMUX=/path/to/tmux npx vitest run terminal-utf8-tmux
//
// With CCDECK_TEST_UTF8_REPORT=<file> each run appends one JSON line of what
// it measured (how many lines tmux cut inside a character, and so on).
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs server module, no types
import { terminalBridge } from "../../server/terminal-bridge.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { openControl } from "../../server/tmux-control.mjs";
// @ts-expect-error — plain .mjs test kit, no types
import * as kit from "./utf8-frames-kit.mjs";

/** A tmux this file may use, or null: CCDECK_TMUX, else `tmux` on PATH, 3.2+. */
function realTmux(): { bin: string; version: string } | null {
  if (process.platform === "win32") return null;
  for (const bin of [process.env.CCDECK_TMUX, "tmux"]) {
    if (!bin) continue;
    const r = spawnSync(bin, ["-V"], { encoding: "utf8", timeout: 5000 });
    const m = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(r.stdout ?? "");
    if (r.status === 0 && m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2))) return { bin, version: r.stdout.trim() };
  }
  return null;
}

const TMUX = realTmux();
const X = kit.headlessXterm();
const NEEDS_TMUX = "tmux 3.2 or later (CCDECK_TMUX, or tmux on PATH)";
const SOCKET = `ccdeck-test-u8-${process.pid}-${randomBytes(3).toString("hex")}`;
const FIXTURE = fileURLToPath(new URL("./utf8-burst-tui.mjs", import.meta.url));
const SEED_FIXTURE = fileURLToPath(new URL("./utf8-seed-tui.mjs", import.meta.url));
const NODE = process.execPath;
/** Lines in the burst, and the history both sides keep: all of it. */
const LINES = 8000;
const HISTORY = 50_000;
const ENV: NodeJS.ProcessEnv = { ...process.env };
delete ENV.TMUX;
delete ENV.TMUX_PANE;

/** tmux on this file's own server: `-u` so a capture is UTF-8, `-f /dev/null` so no config. */
function tm(...args: string[]): string {
  return execFileSync(TMUX!.bin, ["-u", "-L", SOCKET, "-f", "/dev/null", ...args], { env: ENV, encoding: "utf8", timeout: 10_000, maxBuffer: 64 << 20 });
}

// tmux leaves its socket file behind when the server goes, and a server with
// no sessions left has gone already, so where it is is asked while it runs.
let socketPath = "";
afterAll(() => {
  if (!TMUX) return;
  try { tm("kill-server"); } catch { /* already gone */ }
  if (basename(socketPath) === SOCKET) rmSync(socketPath, { force: true });
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Lines with their trailing spaces gone, and no empty lines at the end. */
const lines = (text: string) => {
  const out = text.split("\n").map(l => l.replace(/\s+$/, ""));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
};

/** Raw frames that end inside a character and whose last byte is 0x80: the cut xterm.js cannot join. */
function cutAfter80(frames: Buffer[]): number {
  const all = Buffer.concat(frames);
  let at = 0;
  let n = 0;
  for (const f of frames) {
    at += f.length;
    if (at < all.length && (all[at] & 0xc0) === 0x80 && all[at - 1] === 0x80) n++;
  }
  return n;
}

/** What a panel shows after `sent`: every binary frame one write, in the
 *  order they came, and a reset or a size landing after the writes before
 *  it, as the panel's own do. Every line, history included. */
async function panelLines(sent: any[]): Promise<string[]> {
  const term = kit.makeTerminal(X, { cols: 120, rows: 40, scrollback: HISTORY, graphemes: true });
  for (const s of sent) {
    if (s.type === "binary") { term.write(Uint8Array.from(s.data)); continue; }
    if (s.msg.t !== "reset" && s.msg.t !== "size") continue;
    await kit.writeTo(term, "");
    if (s.msg.t === "reset") term.reset();
    term.resize(s.msg.cols, s.msg.rows);
  }
  await kit.writeTo(term, "");
  const shown = lines(kit.screenText(term));
  term.dispose();
  return shown;
}

/** The lines on which `shown` and `truth` differ, the first eight spelt out. */
function differing(shown: string[], truth: string[]) {
  const spelt: string[] = [];
  let n = 0;
  for (let i = 0; i < Math.max(shown.length, truth.length); i++) {
    if (shown[i] === truth[i]) continue;
    n++;
    if (spelt.length < 8) spelt.push(`line ${i}\n  panel: ${JSON.stringify(shown[i])}\n  tmux:  ${JSON.stringify(truth[i])}`);
  }
  return { n, spelt };
}

describe("whole characters from a real tmux pane to the panel", () => {
  it.skipIf(process.platform === "win32")("a pane writing punctuation-heavy text: no frame ends inside a character, nothing is lost, and the panel's screen and history are tmux's", async () => {
    if (!kit.needed(NEEDS_TMUX, TMUX)) return;
    const started = Date.now();
    const token = `utf8-done-${randomBytes(4).toString("hex")}`;
    tm("start-server", ";", "set-option", "-g", "history-limit", String(HISTORY), ";",
      "new-session", "-d", "-s", "u8", "-x", "120", "-y", "40", NODE, FIXTURE, token, String(LINES));
    const pane = tm("display-message", "-p", "-t", "u8", "#{pane_id}").trim();
    socketPath = tm("display-message", "-p", "-t", "u8", "#{socket_path}").replace(/\n$/, "");

    // The relay on a real control client. `raw` is what tmux-control emitted,
    // line by line as tmux sent it; `conn` is what the relay put on the wire.
    const raw: Buffer[] = [];
    const conn = new kit.RecordingConn();
    const handle = terminalBridge({
      conn,
      socket: new EventEmitter(),
      binding: { kind: "A", tmux: TMUX.bin, socket: { name: SOCKET }, target: pane, pane, ignoreSize: false },
      open: (o: any) => {
        const c = openControl({ ...o, env: ENV });
        c.on("output", (d: Buffer) => raw.push(Buffer.from(d)));
        return c;
      },
      history: HISTORY,
    });
    try {
      handle.message({ type: "text", data: Buffer.from(JSON.stringify({ t: "size", cols: 120, rows: 40 })) });
      await waitFor(() => conn.sent.some(s => s.type === "binary"), "the first seed", 10_000);
      const firstSeed = conn.sent.findIndex(s => s.type === "binary");
      // The key the program waits for, typed through the relay.
      handle.message({ type: "binary", data: Buffer.from("g") });
      await waitFor(() => Buffer.concat(conn.binaries().slice(-4)).includes(token), "the program's last line", 30_000);

      const relayed: Buffer[] = conn.binaries(firstSeed + 1);
      const resets = conn.sent.filter(s => s.type === "text" && s.msg.t === "reset").length;
      const measured: Record<string, unknown> = {
        tmux: TMUX.version,
        rawFrames: raw.length,
        rawCut: kit.framesNotOnBoundary(raw),
        rawCutAfter80: cutAfter80(raw),
        relayFrames: relayed.length,
        relayCut: kit.framesNotOnBoundary(relayed),
        resets,
        bytes: raw.reduce((n, f) => n + f.length, 0),
        // The longest %output line: a frame longer than a piece would be padded.
        maxRawFrame: raw.reduce((n, f) => Math.max(n, f.length), 0),
      };

      // The panel (panelLines), against tmux's own lines, history included.
      let shown: string[] = [];
      let truth: string[] = [];
      let differ: string[] = [];
      if (kit.needed("@xterm/headless", X)) {
        shown = await panelLines(conn.sent);
        truth = lines(tm("capture-pane", "-p", "-t", pane, "-S", "-", "-E", "-"));
        const d = differing(shown, truth);
        differ = d.spelt;
        Object.assign(measured, { panelLines: shown.length, tmuxLines: truth.length, differingLines: d.n });
      } else {
        measured.screen = "not compared (no @xterm/headless)";
      }
      if (process.env.CCDECK_TEST_UTF8_REPORT) {
        appendFileSync(process.env.CCDECK_TEST_UTF8_REPORT, `${JSON.stringify({ ...measured, ms: Date.now() - started })}\n`);
      }

      // The case under test happened: tmux ended lines inside characters.
      expect(measured.rawCut, JSON.stringify(measured)).toBeGreaterThan(0);
      expect(measured.relayCut, `frames the relay sent that end inside a character: ${JSON.stringify(measured)}`).toBe(0);
      expect(relayed.filter(f => f.length === 0), "empty frames").toEqual([]);
      // A %pause (tmux let output go and the panel was reseeded) would make the
      // relayed stream another, shorter one; the screen check holds either way.
      // Byte for byte while no frame can have been padded: none, carried bytes
      // and all, longer than a piece. Past that, byte for byte but the filler.
      if (resets === 1) {
        const same = (measured.maxRawFrame as number) + 3 <= kit.PIECE ? Buffer.concat(relayed) : kit.unpad(Buffer.concat(relayed));
        expect(same.equals(Buffer.concat(raw)), "the bytes, in order, unchanged").toBe(true);
      }
      if (X) {
        expect(truth.some(l => l === token), "tmux has the program's last line").toBe(true);
        expect(truth.length, "tmux kept the whole history").toBeGreaterThan(LINES);
        expect(differ, `the panel against tmux (${shown.length} and ${truth.length} lines)`).toEqual([]);
      }
    } finally {
      handle.closed(1000, "");
      try { tm("kill-session", "-t", "u8"); } catch { /* already gone */ }
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("a seed longer than xterm.js decodes in one piece: 300 KB of history, live output after it, and a reopen draw every line tmux has", async () => {
    if (!kit.needed(NEEDS_TMUX, TMUX)) return;
    const started = Date.now();
    const SEED_LINES = 1800;
    // Where the seed's piece edges fall in the text moves a byte with each
    // shift (utf8-seed-tui.mjs). Three shifts in a row put an edge at each of
    // the three bytes of a "—" it falls in; further ones only if no edge fell
    // in one.
    const SHIFTS = [0, 1, 2, 17, 18, 19, 41, 42, 43];
    const attempts: Record<string, unknown>[] = [];
    let lossy = 0;

    /** A relay on a real control client for `pane`: what it sent, and what tmux-control emitted. */
    const relayTo = (pane: string) => {
      const raw: Buffer[] = [];
      const conn = new kit.RecordingConn();
      const handle = terminalBridge({
        conn,
        socket: new EventEmitter(),
        binding: { kind: "A", tmux: TMUX!.bin, socket: { name: SOCKET }, target: pane, pane, ignoreSize: false },
        open: (o: any) => {
          const c = openControl({ ...o, env: ENV });
          c.on("output", (d: Buffer) => raw.push(Buffer.from(d)));
          return c;
        },
      });
      handle.message({ type: "text", data: Buffer.from(JSON.stringify({ t: "size", cols: 120, rows: 40 })) });
      return { raw, conn, handle };
    };

    for (const shift of SHIFTS) {
      if (shift > 2 && lossy > 0) break;
      const name = `seed${shift}`;
      const token = `utf8-seed-${randomBytes(4).toString("hex")}`;
      tm("start-server", ";", "set-option", "-g", "history-limit", String(HISTORY), ";",
        "new-session", "-d", "-s", name, "-x", "120", "-y", "40", NODE, SEED_FIXTURE, token, String(shift), String(SEED_LINES));
      const pane = tm("display-message", "-p", "-t", name, "#{pane_id}").trim();
      socketPath = tm("display-message", "-p", "-t", name, "#{socket_path}").replace(/\n$/, "");
      const relays: ReturnType<typeof relayTo>[] = [];
      try {
        await waitFor(() => tm("capture-pane", "-p", "-t", pane).includes(`${token}-ready`), "the history", 20_000);

        // First open: the seed is ONE frame, and the panel writes it in one write.
        const first = relayTo(pane);
        relays.push(first);
        await waitFor(() => first.conn.sent.some(s => s.type === "binary"), "the first seed", 10_000);
        const seedFrame: Buffer = first.conn.binaries()[0];
        const seed = kit.unpad(seedFrame);
        const before = kit.piecesCut(seed);
        lossy += before.lossy.length;
        const measured: Record<string, unknown> = {
          tmux: TMUX!.version, kind: "seed", shift, seedBytes: seed.length, filler: seedFrame.length - seed.length,
          edgesCut: before.cuts.map((c: any) => `${c.edge}:${c.kept}`), edgesCutAfter80: before.lossy.length,
        };
        attempts.push(measured);
        expect(seed.length, "the seed crosses 131072 and 262144").toBeGreaterThan(2 * kit.PIECE);
        expect(seed.length, "and is no longer than a seed of two thousand lines is").toBeLessThan(400 * 1024);
        expect(kit.piecesCut(seedFrame).cuts, `piece edges that cut a character in the frame sent: ${JSON.stringify(measured)}`).toEqual([]);

        // Live output after it, with frames that end inside a character. The
        // last line is the token and a "\r" (the pane's tty may make the "\n"
        // after it "\r\n"), which `<token>-ready` in the seed is not.
        first.handle.message({ type: "binary", data: Buffer.from("g") });
        await waitFor(() => Buffer.concat(first.conn.binaries().slice(-4)).includes(token + "\r"), "the program's last line", 20_000);
        measured.liveCut = kit.framesNotOnBoundary(first.raw);
        measured.maxRawFrame = first.raw.reduce((n, f) => Math.max(n, f.length), 0);
        expect(measured.liveCut, `live frames tmux cut inside a character: ${JSON.stringify(measured)}`).toBeGreaterThan(0);
        expect(kit.framesNotOnBoundary(first.conn.binaries().slice(1)), "live frames the relay sent that end inside a character").toBe(0);

        // A reopen: a new socket, a new seed of everything so far.
        first.handle.closed(1000, "");
        const again = relayTo(pane);
        relays.push(again);
        await waitFor(() => again.conn.sent.some(s => s.type === "binary"), "the reopen's seed", 10_000);
        const reseed: Buffer = again.conn.binaries()[0];
        expect(kit.piecesCut(reseed).cuts, "piece edges that cut a character in the reopen's seed").toEqual([]);

        if (kit.needed("@xterm/headless", X)) {
          const truth = lines(tm("capture-pane", "-p", "-t", pane, "-S", "-", "-E", "-"));
          expect(truth.length, "tmux kept every line").toBeGreaterThan(SEED_LINES);
          expect(truth.some(l => l === token), "tmux has the program's last line").toBe(true);
          const opened = differing(await panelLines(first.conn.sent), truth);
          const reopened = differing(await panelLines(again.conn.sent), truth);
          Object.assign(measured, { tmuxLines: truth.length, openedDiffer: opened.n, reopenedDiffer: reopened.n });
          expect(opened.spelt, `the panel against tmux, first open: ${JSON.stringify(measured)}`).toEqual([]);
          expect(reopened.spelt, `the panel against tmux, reopened: ${JSON.stringify(measured)}`).toEqual([]);
          // The problem is met: where an edge cut a character after a 0x80,
          // the seed tmux gave, unpadded in one write, does not draw tmux's lines.
          if (before.lossy.length) {
            const unpadded = first.conn.sent.map((s: any) => (s.type === "binary" && s.data === seedFrame ? { ...s, data: seed } : s));
            measured.unpaddedDiffer = differing(await panelLines(unpadded), truth).n;
            expect(measured.unpaddedDiffer, "lines the unpadded seed draws otherwise").toBeGreaterThan(0);
          }
        }
      } finally {
        for (const r of relays) r.handle.closed(1000, "");
        try { tm("kill-session", "-t", name); } catch { /* already gone */ }
      }
    }
    if (process.env.CCDECK_TEST_UTF8_REPORT) {
      appendFileSync(process.env.CCDECK_TEST_UTF8_REPORT, `${JSON.stringify({ kind: "seed", attempts, ms: Date.now() - started })}\n`);
    }
    // The case under test happened: a piece edge of a seed fell after a 0x80.
    expect(lossy, `edges that cut a character after a 0x80, over ${JSON.stringify(attempts)}`).toBeGreaterThan(0);
  }, 60_000);
});
