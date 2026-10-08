// The whole terminal path on real tmux: a deck session started through
// terminal-sessions, a ticket from POST /api/terminal/open, the upgrade, and
// the protocol — hello, the panel's size, reset and seed, keys typed in and
// their echo coming back — and then the panel closing while the session it
// showed goes on running.
//
// Every other suite for the panel stands something in for tmux. This one is
// what says the stand-ins describe tmux: the pane really is resized before the
// first frame is captured, the seed really is what a reset xterm needs (it
// opens with RIS), and the bytes typed into the socket really reach the pane.
//
// ITS OWN tmux, AND NEVER THE PRODUCT'S. The deck's sessions live on `-L
// ccdeck`; this runs on a socket named for this run, inside a TMUX_TMPDIR in
// this run's temp folder, handed to the routes through startServer's
// `terminal` option — so the user's own tmux and the deck's are never asked
// anything — and the server is killed in afterAll. The panel itself is
// switched on the way a person would, with CCDECK_TERMINAL=1.
//
// NO tmux, NO SKIP. Without one (CCDECK_TMUX unset and nothing on PATH) the
// case asserts what the panel would be told instead — the house pattern of
// branching inside the case, so skip-gate-inventory has nothing to register.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { json, openWs, OPS, type Frame } from "./ws-test-client";

// Short, because the tmux socket path lives under it and a Unix socket path
// has about a hundred bytes to fit in.
const DIR = mkdtempSync(join(tmpdir(), "cct-ts-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "claude-swap");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
// Every tmux this file starts or asks — the session, the listing, the control
// client — finds its sockets here, and only here.
process.env.TMUX_TMPDIR = join(DIR, "t");
mkdirSync(process.env.TMUX_TMPDIR, { mode: 0o700 });
// The panel, on, the way its owner switches it on.
process.env.CCDECK_TERMINAL = "1";
const PROJECT = join(DIR, "project");
mkdirSync(PROJECT);

const SOCKET = Object.freeze({ name: `ccdeck-test-ts-${process.pid}-${randomBytes(3).toString("hex")}` });

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { findTmux, runTmux } = await import("../../server/tmux.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { launchSession, listDeckSessions } = await import("../../server/terminal-sessions.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { liveChildPids } = await import("../../server/exec-children.mjs");

let server: Server;
let port = 0;
let tmux: any = null;
beforeAll(async () => {
  expect(SOCKET.name, "never the product's own server").not.toBe("ccdeck");
  tmux = await findTmux();
  server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal: { deckSocket: SOCKET } });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  if (tmux?.ok) await runTmux(tmux, SOCKET, ["kill-server"]);
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
}, 30_000);

const page = () => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });

function ask(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { ...page(), ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error(`${method} ${path} timed out`)); });
    req.end(payload);
  });
}

/** The tmux control clients this process has running, by their argv. Linux
 *  only: elsewhere there is no /proc to read it from, and the answer is []. */
function controlClients(): number[] {
  if (process.platform !== "linux") return [];
  return liveChildPids().filter((pid: number) => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("attach-session"); } catch { return false; }
  });
}

describe("the terminal socket on real tmux", () => {
  it("attaches to a deck session, streams it, types into it, and leaves it running when the panel closes", async () => {
    if (!tmux.ok) {
      // No tmux 3.2+ on this machine: what the panel is told instead.
      expect(["missing", "too-old"]).toContain(tmux.reason);
      const status = await ask("GET", "/api/terminal/status");
      expect(status.body).toMatchObject({ ok: true, tmux: { ok: false, reason: tmux.reason } });
      return;
    }

    // A deck session whose program is `cat`: it echoes what it is sent, and
    // never asks a real agent anything.
    const sessionId = randomUUID();
    const launched = await launchSession({ tmux, agent: "claude", cwd: PROJECT, argv: ["cat"], sessionId, socket: SOCKET, cols: 80, rows: 24 });
    expect(launched.name).toMatch(/^ccdeck-claude-[0-9a-f]{8}$/);

    // The page asks for it by session, and is told it is the deck's own.
    const opened = await ask("POST", "/api/terminal/open", { sessionId, provider: "claude", cwd: PROJECT });
    expect(opened.status).toBe(200);
    expect(opened.body.ok, JSON.stringify(opened.body)).toBe(true);
    expect(opened.body.target.kind).toBe("A");

    const c = await openWs({
      port,
      path: `/api/terminal/attach?ticket=${encodeURIComponent(opened.body.ticket)}`,
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" },
    });
    expect(c.status, c.head).toBe(101);
    expect(json(await c.next())).toEqual({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });

    // The panel's size: the pane is resized to it BEFORE the first frame is
    // captured, so the reset names the panel's size and so does tmux.
    c.sendText(JSON.stringify({ t: "size", cols: 100, rows: 30 }));
    expect(json(await c.next(10_000))).toEqual({ t: "reset", cols: 100, rows: 30 });
    const seed = await c.next(10_000);
    expect(seed.op, "the seed is one binary frame").toBe(OPS.binary);
    expect(seed.data.subarray(0, 2).toString("latin1"), "a seed opens with RIS, for a reset xterm").toBe("\x1bc");
    const sized = (await listDeckSessions({ tmux, socket: SOCKET })).find((s: any) => s.name === launched.name);
    expect([sized?.cols, sized?.rows]).toEqual([100, 30]);
    expect(controlClients().length, "one tmux control client while the panel is open").toBe(1);

    // Typed into the socket, echoed by the pane: once by the terminal's echo
    // and once by cat.
    const marker = `ccdeck-${randomBytes(4).toString("hex")}`;
    c.sendBinary(`${marker}\r`);
    let out = "";
    await c.until((f: Frame) => {
      if (f.op === OPS.binary) out += f.data.toString("latin1");
      return out.split(marker).length - 1 >= 2;
    }, 10_000);

    // The panel closes. The deck answers the close and lets its tmux client go.
    c.sendClose(1000);
    const close = await c.until((f: Frame) => f.op === OPS.close, 5_000);
    expect(close.data.readUInt16BE(0)).toBe(1000);
    await c.closed;
    await vi.waitFor(() => expect(controlClients(), "the control client detached").toEqual([]), { timeout: 5_000 });

    // And the session is still there, alive: closing a panel never stops an agent.
    const after = (await listDeckSessions({ tmux, socket: SOCKET })).find((s: any) => s.name === launched.name);
    expect(after, "the session outlived the panel").toBeTruthy();
    expect(after.dead).toBe(false);
    expect(existsSync(join(process.env.TMUX_TMPDIR!, `tmux-${process.getuid?.() ?? 0}`, SOCKET.name)), "on this run's own socket").toBe(true);
  }, 30_000);
});
