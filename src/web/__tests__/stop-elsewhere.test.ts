// Stop there and resume here, on the deck's side: which process may be
// signalled for a session that runs in a terminal outside the deck
// (src/server/stop-elsewhere.mjs), and the route that checks, then stops it
// (POST /api/terminal/stop-elsewhere, terminal-routes.mjs).
//
// Every refusal runs on fixtures: a session-record folder on disk, a fake
// /proc (or `ps` table) read through the same parsing the module uses on a
// machine, and a kill that only records what it was asked. Nothing in those
// blocks can reach a real process.
//
// The last block runs against this machine's real process table, with one
// stand-in Claude this file starts and writes the record for, the way Claude
// Code writes its own. The kill it hands the route passes a signal on only to
// that stand-in, and the case asserts it was asked for nothing else.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-stop-elsewhere-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const routes = await import("../../server/terminal-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const stopper = await import("../../server/stop-elsewhere.mjs");
const { STOP_SENT_FOR_MS, STOP_TOKEN, checkStop, findHolder, holderToken, stopHolder } = stopper;

const ID = "0b9c2f4e-6a1d-4c3b-9e8f-7a6b5c4d3e2f";
const OTHER = "11111111-2222-4333-8444-555555555555";
const CWD = "/home/u/proj";
const MACHINE = "a7fb2db1c70e41b3be7699d8af5757ce";
const NS = "pid:[4026531836]";
const DOMAIN = `linux:${MACHINE}:${NS}`;
const LSTART = "Thu Oct  8 09:12:33 2026";
const KEY = Buffer.alloc(32, 7);
const SESSION = { sessionId: ID, cwd: CWD };

afterAll(() => rmTempDir(DIR));

// ---------------------------------------------------------------------------
// Fixtures, in terminal-target.test.ts's shape.

type Proc = { pid: number; ppid: number; cmd: string[]; start?: string; lstart?: string; cwd?: string };

/** A /proc/<pid>/stat line with all 52 fields, starttime at field 22. */
function statLine(p: Proc): string {
  const f = new Array(50).fill("0");
  f[0] = "S";
  f[1] = String(p.ppid);
  f[19] = p.start ?? "1000";
  return `${p.pid} (${basename(p.cmd[0] ?? "x").slice(0, 15)}) ${f.join(" ")}\n`;
}

function enoent(p: string) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
}

/** A fake /proc and /etc/machine-id over the real filesystem for the record
 *  folder. `links` are the folders a realpath resolves (a symlinked project). */
function fakeMachine(procs: Proc[], links: Record<string, string> = {}) {
  const files = new Map<string, string>();
  const cwds = new Map<string, string>();
  for (const p of procs) {
    files.set(`/proc/${p.pid}/stat`, statLine(p));
    files.set(`/proc/${p.pid}/cmdline`, p.cmd.join("\0") + "\0");
    if (p.cwd) cwds.set(`/proc/${p.pid}/cwd`, p.cwd);
  }
  files.set("/etc/machine-id", `${MACHINE}\n`);
  const faked = (p: string) => p.startsWith("/proc/") || p === "/proc" || p === "/etc/machine-id";
  return {
    readFile(p: string) {
      if (!faked(p)) return readFileSync(p, "utf8");
      const v = files.get(p);
      if (v == null) throw enoent(p);
      return v;
    },
    readdir(p: string) {
      if (!faked(p)) return readdirSync(p);
      if (p === "/proc") return procs.map((x) => String(x.pid));
      throw enoent(p);
    },
    readlink(p: string) {
      if (p === "/proc/self/ns/pid") return NS;
      throw enoent(p);
    },
    realpath(p: string) {
      if (p.startsWith("/proc/")) {
        const v = cwds.get(p);
        if (v == null) throw enoent(p);
        return links[v] ?? v;
      }
      return links[p] ?? p;
    },
  };
}

let dirs = 0;
function claudeDirWith(records: Array<Record<string, unknown>>) {
  const dir = join(DIR, `claude-${++dirs}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  for (const r of records) writeFileSync(join(dir, "sessions", `${r.pid}.json`), JSON.stringify(r));
  return dir;
}

function record(pid: number, extra: Record<string, unknown> = {}) {
  return { pid, sessionId: ID, cwd: CWD, startedAt: 1_000, procStart: "1000", kind: "interactive", pidDomain: DOMAIN, ...extra };
}

// A Claude in a Ghostty tab, and the deck in another tab of the same terminal.
const INIT: Proc = { pid: 1, ppid: 0, cmd: ["/sbin/init"] };
const TERMINAL: Proc = { pid: 4000, ppid: 1, cmd: ["/usr/bin/ghostty"] };
const SHELL: Proc = { pid: 4001, ppid: 4000, cmd: ["-bash"] };
const CLAUDE: Proc = { pid: 5001, ppid: 4001, cmd: ["claude", "--resume", ID], start: "1000", cwd: CWD };
const DECK_SHELL: Proc = { pid: 880, ppid: 4000, cmd: ["-zsh"] };
const DECK: Proc = { pid: 900, ppid: 880, cmd: ["node", "/usr/lib/node_modules/ccdeck/bin/ccdeck.mjs"] };
const BASE = [INIT, TERMINAL, SHELL, DECK_SHELL, DECK];

/** The stop's deps over these processes and records: Linux, the deck at 900,
 *  a kill that records and signals nothing, and a fresh memory of stops sent. */
function machine(procs: Proc[], records: Array<Record<string, unknown>>, over: Record<string, unknown> = {}, links: Record<string, string> = {}) {
  const m = fakeMachine(procs, links);
  const kill = vi.fn((_pid: number, _signal: string) => {});
  return {
    platform: "linux", claudeDir: claudeDirWith(records), selfPid: DECK.pid, key: KEY, kill, sent: new Map(),
    readFile: m.readFile, readdir: m.readdir, readlink: m.readlink, realpath: m.realpath, ...over,
  };
}

// ---------------------------------------------------------------------------

describe("which process may be stopped", () => {
  it("finds the one Claude whose record names the session and whose start time matches", async () => {
    const BESIDE: Proc = { pid: 5002, ppid: 4001, cmd: ["claude"], start: "2000", cwd: CWD };
    const deps = machine([...BASE, CLAUDE, BESIDE], [record(5001), record(5002, { sessionId: OTHER, procStart: "2000" })]);
    expect(await findHolder({ sessionId: ID.toUpperCase(), cwd: CWD }, deps)).toEqual({ ok: true, pid: 5001, start: "1000" });
    expect(await findHolder({ sessionId: OTHER, cwd: CWD }, deps)).toEqual({ ok: true, pid: 5002, start: "2000" });
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("never counts a pid another process holds now, or a record left by a Claude that ended", async () => {
    // The kernel handed the pid out again: same pid, another start time.
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE], [record(5001, { procStart: "999" })]))).toEqual({ ok: false, reason: "not-found" });
    // Nothing holds the pid at all.
    expect(await findHolder(SESSION, machine(BASE, [record(5001)]))).toEqual({ ok: false, reason: "not-found" });
    // No record for the session.
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE], []))).toEqual({ ok: false, reason: "not-found" });
  });

  it("is never sure of a record without a start time, whatever runs under its pid", async () => {
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE], [record(5001, { procStart: undefined })])))
      .toEqual({ ok: false, reason: "unverifiable" });
    // Something that is not Claude under that pid is a recycled one: not the session.
    const python: Proc = { pid: 5001, ppid: 1, cmd: ["/usr/bin/python3", "server.py"], cwd: CWD };
    expect(await findHolder(SESSION, machine([...BASE, python], [record(5001, { procStart: undefined })])))
      .toEqual({ ok: false, reason: "not-found" });
  });

  it("says ambiguous for two live processes that both pass for the session", async () => {
    const TWIN: Proc = { ...CLAUDE, pid: 5003, start: "3000" };
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE, TWIN], [record(5001), record(5003, { procStart: "3000" })])))
      .toEqual({ ok: false, reason: "ambiguous" });
    // One that cannot be told apart counts as well: never a pick between them.
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE, TWIN], [record(5001), record(5003, { procStart: undefined })])))
      .toEqual({ ok: false, reason: "ambiguous" });
  });

  it("leaves a background session alone: its record's kind, or a pty host for a parent", async () => {
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE], [record(5001, { kind: "bg" })]))).toEqual({ ok: false, reason: "background" });
    const HOST: Proc = { pid: 4500, ppid: 1, cmd: ["claude", "bg-pty-host", "--bg-pty-host", "/tmp/s.sock", "120", "40", "--", "claude"] };
    const hosted: Proc = { ...CLAUDE, ppid: 4500 };
    expect(await findHolder(SESSION, machine([...BASE, HOST, hosted], [record(5001)]))).toEqual({ ok: false, reason: "background" });
  });

  it("skips a record from another machine or pid namespace", async () => {
    const otherMachine = record(5001, { pidDomain: `linux:${"f".repeat(32)}:${NS}` });
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE], [otherMachine]))).toEqual({ ok: false, reason: "not-found" });
    const otherNs = record(5001, { pidDomain: `linux:${MACHINE}:pid:[4026532999]` });
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE], [otherNs]))).toEqual({ ok: false, reason: "not-found" });
  });

  it("on Linux, asks for the process to work in the session's folder, both sides resolved", async () => {
    const elsewhere: Proc = { ...CLAUDE, cwd: "/home/u/other" };
    expect(await findHolder(SESSION, machine([...BASE, elsewhere], [record(5001)]))).toEqual({ ok: false, reason: "unverifiable" });
    const unreadable: Proc = { ...CLAUDE, cwd: undefined };
    expect(await findHolder(SESSION, machine([...BASE, unreadable], [record(5001)]))).toEqual({ ok: false, reason: "unverifiable" });
    // A link to the same folder is the same folder.
    expect(await findHolder({ sessionId: ID, cwd: "/home/u/link" }, machine([...BASE, CLAUDE], [record(5001)], {}, { "/home/u/link": CWD })))
      .toEqual({ ok: true, pid: 5001, start: "1000" });
  });

  it("refuses a command line that is no longer an interactive Claude", async () => {
    const print: Proc = { ...CLAUDE, cmd: ["claude", "-p", "summarise"] };
    expect(await findHolder(SESSION, machine([...BASE, print], [record(5001)]))).toEqual({ ok: false, reason: "unverifiable" });
    const python: Proc = { ...CLAUDE, cmd: ["/usr/bin/python3", "server.py"] };
    expect(await findHolder(SESSION, machine([...BASE, python], [record(5001)]))).toEqual({ ok: false, reason: "unverifiable" });
  });

  it("never stops the deck itself, nor a Claude the deck runs under", async () => {
    expect(await findHolder(SESSION, machine([...BASE, CLAUDE], [record(5001)], { selfPid: 5001 }))).toEqual({ ok: false, reason: "shared-parent" });
    // The deck was started from a shell inside that Claude session.
    const TOOL_SHELL: Proc = { pid: 6000, ppid: 5001, cmd: ["/bin/bash", "-c", "npx ccdeck"] };
    const inner: Proc = { ...DECK, ppid: 6000 };
    expect(await findHolder(SESSION, machine([INIT, TERMINAL, SHELL, CLAUDE, TOOL_SHELL, inner], [record(5001)])))
      .toEqual({ ok: false, reason: "shared-parent" });
  });

  it("reads the ps table where there is no /proc, and matches Claude's lstart spelling", async () => {
    const rows = [
      { pid: 4001, ppid: 4000, tty: "ttys001", start: LSTART.replace(/\s+/g, " "), cmd: "-zsh" },
      { pid: 5001, ppid: 4001, tty: "ttys001", start: LSTART.replace(/\s+/g, " "), cmd: `claude --resume ${ID}` },
    ];
    const deps = machine([], [record(5001, { procStart: LSTART, pidDomain: "" })], { platform: "darwin", processTable: async () => rows });
    expect(await findHolder(SESSION, deps)).toEqual({ ok: true, pid: 5001, start: LSTART.replace(/\s+/g, " ") });
  });
});

describe("the check and the stop", () => {
  it("checks with a token that names the holder and says nothing of it, and signals nothing", async () => {
    const deps = machine([...BASE, CLAUDE], [record(5001)]);
    const checked = await checkStop(SESSION, deps);
    expect(checked).toEqual({ ok: true, token: holderToken(ID, { pid: 5001, start: "1000" }, KEY) });
    expect(checked.token).toMatch(STOP_TOKEN);
    expect(checked.token).not.toContain("5001");
    // Another deck (another key) names the same holder differently.
    expect(holderToken(ID, { pid: 5001, start: "1000" }, Buffer.alloc(32, 8))).not.toBe(checked.token);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(await checkStop(SESSION, machine([...BASE, CLAUDE], [record(5001, { kind: "bg" })]))).toEqual({ ok: false, reason: "background" });
  });

  it("says changed, and signals nothing, for a token that does not name the holder there now", async () => {
    const deps = machine([...BASE, CLAUDE], [record(5001)]);
    const stale = holderToken(ID, { pid: 5001, start: "999" }, KEY);
    expect(await stopHolder(SESSION, stale, deps)).toEqual({ ok: false, reason: "changed" });
    expect(await stopHolder(SESSION, "not-a-token", deps)).toEqual({ ok: false, reason: "changed" });
    expect(await stopHolder(SESSION, undefined, deps)).toEqual({ ok: false, reason: "changed" });
    // The holder ended between the check and the stop: that is the stop done,
    // answered as gone so the pane's wait resumes it, and nothing is signalled.
    const { token } = await checkStop(SESSION, deps);
    const ended = machine(BASE, [record(5001)]);
    expect(await stopHolder(SESSION, token, ended)).toEqual({ ok: true, gone: true });
    expect(ended.kill).not.toHaveBeenCalled();
    // A different Claude holding it now (another start time) is a change.
    const other = machine([...BASE, { ...CLAUDE, start: "2000" }], [record(5001, { procStart: "2000" })]);
    expect(await stopHolder(SESSION, token, other)).toEqual({ ok: false, reason: "changed" });
    expect(other.kill).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("sends exactly one SIGTERM, to exactly that pid", async () => {
    const deps = machine([...BASE, CLAUDE], [record(5001)]);
    const { token } = await checkStop(SESSION, deps);
    expect(await stopHolder(SESSION, token, deps)).toEqual({ ok: true, stopping: true });
    expect(deps.kill.mock.calls).toEqual([[5001, "SIGTERM"]]);
    // Pressed again meanwhile (another tab, a Cancel then a press): under way,
    // and nothing more is sent.
    expect(await stopHolder(SESSION, token, deps)).toEqual({ ok: true, stopping: true });
    expect(deps.kill).toHaveBeenCalledTimes(1);
    // Long after, a Claude still there may be asked again: once.
    const later = { ...deps, now: () => Date.now() + STOP_SENT_FOR_MS };
    expect(await stopHolder(SESSION, token, later)).toEqual({ ok: true, stopping: true });
    expect(deps.kill.mock.calls).toEqual([[5001, "SIGTERM"], [5001, "SIGTERM"]]);
  });

  it("says gone for a process that ended before the signal, and signal-failed for a refused one", async () => {
    const esrch = machine([...BASE, CLAUDE], [record(5001)], {
      kill: vi.fn(() => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); }),
    });
    const { token } = await checkStop(SESSION, esrch);
    expect(await stopHolder(SESSION, token, esrch)).toEqual({ ok: true, gone: true });
    expect(esrch.sent.size, "nothing was sent").toBe(0);
    const eperm = machine([...BASE, CLAUDE], [record(5001)], {
      kill: vi.fn(() => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); }),
    });
    expect(await stopHolder(SESSION, token, eperm)).toEqual({ ok: false, reason: "signal-failed" });
    expect(eperm.sent.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The route.

let options: Record<string, unknown> = {};
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => { void routes.handleTerminalStopElsewhere(req, res, options); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise(r => server.close(r)); });

function post(body: unknown): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve_, reject) => {
    const payload = JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path: "/api/terminal/stop-elsewhere", method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, body: JSON.parse(raw), raw }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const engineSaying = (kind: string) => ({
  enabled: true,
  route: vi.fn(async () => ({ status: 200, body: { ok: true, target: { kind } } })),
});
const REF = { sessionId: ID, provider: "claude", cwd: CWD };

describe("POST /api/terminal/stop-elsewhere", () => {
  it("is not there with the panel off, and asks and signals nothing", async () => {
    const engine = engineSaying("C");
    const stop = machine([...BASE, CLAUDE], [record(5001)]);
    options = { enabled: () => false, engine, stopElsewhere: stop };
    expect(await post({ session: REF, check: true })).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(engine.route).not.toHaveBeenCalled();
    expect(stop.kill).not.toHaveBeenCalled();
  });

  it("answers this machine only: 403 to a viewer on the LAN", async () => {
    const engine = engineSaying("C");
    const stop = machine([...BASE, CLAUDE], [record(5001)]);
    for (const remoteAddress of ["192.168.1.20", "::ffff:192.168.1.20", "fe80::1"]) {
      let status = 0;
      const res = { headersSent: false, writeHead: (s: number) => { status = s; }, end: () => {} };
      await routes.handleTerminalStopElsewhere({ socket: { remoteAddress } }, res, { enabled: () => true, engine, stopElsewhere: stop });
      expect(status, remoteAddress).toBe(403);
    }
    expect(engine.route).not.toHaveBeenCalled();
    expect(stop.kill).not.toHaveBeenCalled();
  });

  it("says unsupported where it cannot read the process table, and without an engine", async () => {
    const engine = engineSaying("C");
    options = { enabled: () => true, engine, stopElsewhere: machine([...BASE, CLAUDE], [record(5001)], { platform: "win32" }) };
    expect(await post({ session: REF, check: true })).toMatchObject({ status: 200, body: { ok: false, reason: "unsupported" } });
    expect(engine.route).not.toHaveBeenCalled();
    options = { enabled: () => true, engine: null, stopElsewhere: machine([...BASE, CLAUDE], [record(5001)]) };
    expect(await post({ session: REF, check: true })).toMatchObject({ status: 200, body: { ok: false, reason: "unsupported" } });
  });

  it("stops only a session the engine says runs in a terminal of its own", async () => {
    for (const kind of ["A", "B", "D", "E", "unsupported"]) {
      const engine = engineSaying(kind);
      const stop = machine([...BASE, CLAUDE], [record(5001)]);
      options = { enabled: () => true, engine, stopElsewhere: stop };
      const token = holderToken(ID, { pid: 5001, start: "1000" }, KEY);
      expect(await post({ session: REF, token }), kind).toMatchObject({ status: 200, body: { ok: false, reason: "not-elsewhere" } });
      expect(engine.route).toHaveBeenCalledWith("target", { sessionId: ID, provider: "claude", cwd: CWD });
      expect(stop.kill).not.toHaveBeenCalled();
    }
  });

  it("calls a session that has ended already no error", async () => {
    const stop = machine([...BASE, CLAUDE], [record(5001)]);
    options = { enabled: () => true, engine: engineSaying("gone"), stopElsewhere: stop };
    expect(await post({ session: REF, check: true })).toMatchObject({ status: 200, body: { ok: true, gone: true } });
    expect(await post({ session: REF, token: "0".repeat(32) })).toMatchObject({ status: 200, body: { ok: true, gone: true } });
    expect(stop.kill).not.toHaveBeenCalled();
  });

  it("checks, then stops that one process, and never tells the page its pid", async () => {
    const stop = machine([...BASE, CLAUDE], [record(5001)]);
    options = { enabled: () => true, engine: engineSaying("C"), stopElsewhere: stop };
    const checked = await post({ session: REF, check: true });
    expect(checked.status).toBe(200);
    expect(checked.body).toEqual({ ok: true, token: expect.stringMatching(STOP_TOKEN) });
    expect(checked.raw).not.toContain("5001");
    expect(stop.kill, "the check signals nothing").not.toHaveBeenCalled();
    const stopped = await post({ session: REF, token: checked.body.token });
    expect(stopped).toMatchObject({ status: 200, body: { ok: true, stopping: true } });
    expect(stopped.raw).not.toContain("5001");
    expect(stop.kill.mock.calls).toEqual([[5001, "SIGTERM"]]);
  });

  it("says changed, and signals nothing, for a stale token", async () => {
    const stop = machine([...BASE, CLAUDE], [record(5001)]);
    options = { enabled: () => true, engine: engineSaying("C"), stopElsewhere: stop };
    const stale = holderToken(ID, { pid: 5001, start: "999" }, KEY);
    expect(await post({ session: REF, token: stale })).toMatchObject({ status: 200, body: { ok: false, reason: "changed" } });
    expect(stop.kill).not.toHaveBeenCalled();
  });

  it("says gone when the process ended before the signal reached it", async () => {
    const stop = machine([...BASE, CLAUDE], [record(5001)], {
      kill: vi.fn(() => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); }),
    });
    options = { enabled: () => true, engine: engineSaying("C"), stopElsewhere: stop };
    const { body } = await post({ session: REF, check: true });
    expect(await post({ session: REF, token: body.token })).toMatchObject({ status: 200, body: { ok: true, gone: true } });
  });

  it("refuses a stop without a token, and anything that is not a Claude session ref", async () => {
    const engine = engineSaying("C");
    const stop = machine([...BASE, CLAUDE], [record(5001)]);
    options = { enabled: () => true, engine, stopElsewhere: stop };
    for (const body of [
      { session: REF },
      { session: REF, token: "short" },
      { session: REF, token: 5001 },
      { session: { ...REF, provider: "codex" }, check: true },
      { session: { ...REF, cwd: "proj" }, check: true },
      { session: { ...REF, sessionId: "../../etc" }, check: true },
      { sessionId: ID, provider: "claude", cwd: CWD, check: true },
      {},
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(engine.route).not.toHaveBeenCalled();
    expect(stop.kill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The real machine: one stand-in Claude, started here, in a folder of its own.
// It is the npm package's script by its path (what looksLikeClaude knows), and
// it writes its own session record with the start time the kernel gives it,
// as Claude Code does: /proc's clock ticks on Linux, `ps`'s lstart in the C
// locale and UTC on macOS. Not on Windows, which is never offered a stop.

const REAL_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const STAND_IN = `
const { execFileSync } = require("node:child_process");
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [dir, sessionId] = process.argv.slice(2);
const procStart = process.platform === "linux"
  ? readFileSync("/proc/" + process.pid + "/stat", "utf8").split(") ").pop().split(" ")[19]
  : execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
const file = join(dir, "sessions", process.pid + ".json");
writeFileSync(file + ".part", JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd(), procStart, kind: "interactive", startedAt: Date.now() }));
renameSync(file + ".part", file);
setInterval(() => {}, 1000);
`;

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  return cond();
};

describe("on this machine's real process table, with a stand-in Claude", () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    // Only the stand-in, by its own handle, and only while it still runs.
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    child = null;
  });

  it.skipIf(process.platform === "win32")("checks, then ends the stand-in with SIGTERM, and signals nothing else", async () => {
    const dir = mkdtempSync(join(DIR, "real-"));
    const claudeDir = join(dir, "claude");
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    const work = join(dir, "work");
    mkdirSync(work);
    const script = join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.cjs");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, STAND_IN);

    const standIn = spawn(process.execPath, [script, claudeDir, REAL_ID], { cwd: work, stdio: "ignore" });
    child = standIn;
    const pid = standIn.pid!;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => standIn.once("exit", (code, signal) => r({ code, signal })));
    expect(await until(() => existsSync(join(claudeDir, "sessions", `${pid}.json`)), 5_000), "the stand-in wrote its record").toBe(true);

    const signalled: Array<[number, string]> = [];
    const kill = (target: number, signal: string) => {
      signalled.push([target, signal]);
      if (target !== pid) throw Object.assign(new Error("not the stand-in"), { code: "EPERM" });
      process.kill(target, signal);
    };
    options = { enabled: () => true, engine: engineSaying("C"), stopElsewhere: { claudeDir, kill, sent: new Map() } };
    const session = { sessionId: REAL_ID, provider: "claude", cwd: work };

    const checked = await post({ session, check: true });
    expect(checked.body, "the module found the stand-in by its record, start time, command line and (on Linux) folder").toEqual({ ok: true, token: expect.stringMatching(STOP_TOKEN) });
    expect(checked.raw).not.toContain(String(pid));
    expect(signalled, "the check signals nothing").toEqual([]);
    expect(standIn.exitCode).toBeNull();

    // A token for another start time of the same pid: nothing is signalled.
    const stale = holderToken(REAL_ID, { pid, start: "1" });
    expect((await post({ session, token: stale })).body).toEqual({ ok: false, reason: "changed" });
    expect(signalled).toEqual([]);

    expect((await post({ session, token: checked.body.token })).body).toEqual({ ok: true, stopping: true });
    const how = await Promise.race([exited, new Promise<null>(r => setTimeout(() => r(null), 5_000))]);
    expect(how, "the stand-in ended on the signal").toEqual({ code: null, signal: "SIGTERM" });
    expect(standIn.signalCode).toBe("SIGTERM");
    expect(signalled, "one signal, to the stand-in only").toEqual([[pid, "SIGTERM"]]);
  }, 15_000);
});
