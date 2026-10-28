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
// ITS OWN tmux SERVER. A socket named for this run (`-L ccdeck-test-u8-*`),
// no config file, in whatever TMUX_TMPDIR the run has; killed, and its socket
// file removed, in afterAll. Never the deck's `-L ccdeck` and never the
// user's. NO SKIP GATE: without tmux 3.2+ (CCDECK_TMUX, or tmux on PATH) the
// case returns; without @xterm/headless (CCDECK_TEST_XTERM, or this
// checkout) the screen comparison gives way to the byte checks, as in
// tmux-control-tmux.test.ts. To run all of it:
//
//   CCDECK_TMUX=/path/to/tmux CCDECK_TEST_XTERM=/dir/with/node_modules \
//     npx vitest run terminal-utf8-tmux
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
const SOCKET = `ccdeck-test-u8-${process.pid}-${randomBytes(3).toString("hex")}`;
const FIXTURE = fileURLToPath(new URL("./utf8-burst-tui.mjs", import.meta.url));
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

describe("whole characters from a real tmux pane to the panel", () => {
  it("a pane writing punctuation-heavy text: no frame ends inside a character, nothing is lost, and the panel's screen and history are tmux's", async () => {
    if (!TMUX) return;
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
      };

      // The panel: every binary frame is one write, in the order they came,
      // and a reset or a size lands after the writes before it, as the
      // panel's own do. Then the lines it shows, history included, against
      // tmux's own.
      let shown: string[] = [];
      let truth: string[] = [];
      const differ: string[] = [];
      if (X) {
        const term = kit.makeTerminal(X, { cols: 120, rows: 40, scrollback: HISTORY, graphemes: true });
        for (const s of conn.sent) {
          if (s.type === "binary") { term.write(Uint8Array.from(s.data)); continue; }
          if (s.msg.t !== "reset" && s.msg.t !== "size") continue;
          await kit.writeTo(term, "");
          if (s.msg.t === "reset") term.reset();
          term.resize(s.msg.cols, s.msg.rows);
        }
        await kit.writeTo(term, "");
        shown = lines(kit.screenText(term));
        term.dispose();
        truth = lines(tm("capture-pane", "-p", "-t", pane, "-S", "-", "-E", "-"));
        let differing = 0;
        for (let i = 0; i < Math.max(shown.length, truth.length); i++) {
          if (shown[i] === truth[i]) continue;
          differing++;
          if (differ.length < 8) differ.push(`line ${i}\n  panel: ${JSON.stringify(shown[i])}\n  tmux:  ${JSON.stringify(truth[i])}`);
        }
        Object.assign(measured, { panelLines: shown.length, tmuxLines: truth.length, differingLines: differing });
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
      if (resets === 1) expect(Buffer.concat(relayed).equals(Buffer.concat(raw)), "the bytes, in order, unchanged").toBe(true);
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
});
