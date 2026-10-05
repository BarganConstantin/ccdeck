// #1779: `ccdeck --stop` inside a crash-restart wait said no deck was running,
// and then the deck came back by itself.
//
// When the background deck crashes, the supervisor waits 1s, 2s, 4s… before
// starting it again. The crashed worker's record is left in the registry —
// shutdown() is what unlinks it, and a crash never runs it — with `parent`
// naming that supervisor. `--stop` and `--status` listed decks only through
// liveDecks/registeredDecks, which drop every record whose worker pid is dead,
// so the one process that was about to bring the deck back was never
// signalled. Reproduced before the fix:
//
//     registeredDecks({ fs: <{ pid: 222 (dead), parent: 111 (alive), … }>, … })  -> []
//     $ ccdeck --stop      (inside the wait)  -> "no deck is running", exit 0
//
// and the supervisor's timer then started the deck again.
//
// Now restartingDecks finds such a record while it is fresh — the deck stamps
// its record every five seconds, so the mtime is when its worker was last
// alive — `--stop` ends the supervisor, and `--status` lists it as restarting.
// A record older than the crash window is left alone: its parent pid is far
// likelier to be somebody else's by then.
//
// THE SUPERVISOR IS FAKE. The CLI is spawned for real with every path in a
// temp directory, and the "supervisor" is a child process of this test, named
// by a record in that directory's registry. No real deck, registry or service
// manager is touched, and the record's port is one nothing listens on.
import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const running = await import("../../server/running-deck.mjs");
// @ts-expect-error — plain .mjs module, no types
const { stopDeck } = await import("../../server/stop-deck.mjs");
// @ts-expect-error — plain .mjs module, no types
const { CRASH_WINDOW_MS } = await import("../../server/supervisor.mjs");

type Rec = { pid: number; parent?: number | null; port: number; token: string; startedAt?: string; restarting?: boolean };
const { registeredDecks, liveDecks, restartingDecks } = running as {
  registeredDecks: (o: Record<string, unknown>) => Promise<Rec[]>;
  liveDecks: (o: Record<string, unknown>) => Promise<Rec[]>;
  restartingDecks: (o: Record<string, unknown>) => Promise<Rec[]>;
};

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const NOW = 1_800_000_000_000;

/** A registry of one or more records, each with the mtime it was last stamped. */
function registry(files: Record<string, { rec: Rec; mtimeMs: number }>) {
  return {
    readdir: async () => Object.keys(files),
    readFile: async (p: string) => JSON.stringify(files[p.split(/[\\/]/).pop()!].rec),
    stat: async (p: string) => ({ mtimeMs: files[p.split(/[\\/]/).pop()!].mtimeMs }),
  };
}

const CRASHED: Rec = { pid: 222, parent: 111, port: 4497, token: "t", startedAt: new Date(NOW - 3_600_000).toISOString() };

describe("a record whose worker crashed and whose supervisor is still there", () => {
  const fresh = registry({ "222.json": { rec: CRASHED, mtimeMs: NOW - 4_000 } });
  const alive = (p: number) => p === 111;
  // The supervisor started before its worker, and the machine has not rebooted
  // since: stop-deck-identity.test.ts is where either one failing is pinned.
  const proven = { bootedAt: NOW - 86_400_000, startedAt: async () => NOW - 3_700_000 };

  it("is dropped by the lists a live deck is found on, which is why --stop missed it", async () => {
    expect(await registeredDecks({ dir: "/x", fs: fresh, self: 1, alive })).toEqual([]);
    expect(await liveDecks({ dir: "/x", fs: fresh, self: 1, alive, prove: async () => true })).toEqual([]);
  });

  it("is found by restartingDecks, and marked so", async () => {
    const got = await restartingDecks({ dir: "/x", fs: fresh, self: 1, selfParent: 2, alive, now: NOW, ...proven });
    expect(got).toEqual([{ ...CRASHED, restarting: true }]);
  });

  it("is not found once it is older than the crash window", async () => {
    const stale = registry({ "222.json": { rec: CRASHED, mtimeMs: NOW - CRASH_WINDOW_MS - 1 } });
    expect(await restartingDecks({ dir: "/x", fs: stale, self: 1, selfParent: 2, alive, now: NOW, ...proven })).toEqual([]);
  });

  it("is not found when the supervisor is gone too, or was never named", async () => {
    expect(await restartingDecks({ dir: "/x", fs: fresh, self: 1, selfParent: 2, alive: () => false, now: NOW, ...proven })).toEqual([]);
    const orphan = registry({ "222.json": { rec: { ...CRASHED, parent: null }, mtimeMs: NOW - 4_000 } });
    expect(await restartingDecks({ dir: "/x", fs: orphan, self: 1, selfParent: 2, alive: () => true, now: NOW, ...proven })).toEqual([]);
  });

  it("is not found when the supervisor already has a live worker registered", async () => {
    // That deck is on the ordinary list, and stopping it ends the supervisor.
    const both = registry({
      "222.json": { rec: CRASHED, mtimeMs: NOW - 4_000 },
      "333.json": { rec: { pid: 333, parent: 111, port: 4497, token: "t" }, mtimeMs: NOW },
    });
    expect(await restartingDecks({ dir: "/x", fs: both, self: 1, selfParent: 2, alive: (p: number) => p === 111 || p === 333, now: NOW, ...proven }))
      .toEqual([]);
  });

  it("never names this process or the supervisor it runs under", async () => {
    expect(await restartingDecks({ dir: "/x", fs: fresh, self: 111, selfParent: 2, alive, now: NOW, ...proven })).toEqual([]);
    expect(await restartingDecks({ dir: "/x", fs: fresh, self: 1, selfParent: 111, alive, now: NOW, ...proven })).toEqual([]);
  });
});

describe("stopping a deck between workers", () => {
  const rec = { ...CRASHED, restarting: true };

  for (const [platform, signal] of [["linux", "SIGTERM"], ["darwin", "SIGTERM"], ["win32", "SIGKILL"]] as const) {
    it(`ends the supervisor and only the supervisor, on ${platform}`, async () => {
      let asked = 0;
      const kills: [number, string][] = [];
      const out = await stopDeck(rec, {
        ask: async () => { asked++; return { ok: false, status: 0, old: false, reason: "ECONNREFUSED" }; },
        alive: () => false,
        kill: (p: number, s: string) => { kills.push([p, s]); },
        now: () => 0, sleep: async () => {}, goneMs: 0, platform,
      });
      expect(out.ok).toBe(true);
      expect(kills).toEqual([[111, signal]]);
      // Nothing on that port has proved it is ours, so the token is not sent.
      expect(asked).toBe(0);
    });
  }

  it("waits for the supervisor to go, not for a worker that is already gone", async () => {
    const kills: [number, string][] = [];
    const out = await stopDeck(rec, {
      ask: async () => ({ ok: false, status: 0, old: false }),
      alive: (p: number) => p === 111,
      kill: (p: number, s: string) => { kills.push([p, s]); },
      now: () => 0, sleep: async () => {}, goneMs: 0, platform: "linux",
    });
    expect(out).toMatchObject({ ok: false, how: "stuck" });
    expect(kills).toEqual([[111, "SIGTERM"], [111, "SIGKILL"]]);
  });
});

// ── the CLI, spawned ────────────────────────────────────────────────────────

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-stop-restarting-"));
const CFG = join(SANDBOX, ".claude");
const REGISTRY = join(CFG, "agent-dag");

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: CFG,
  CODEX_HOME: join(SANDBOX, ".codex"),
  CCDECK_HOME: join(SANDBOX, "deck-data"),
  XDG_CONFIG_HOME: join(SANDBOX, "xdg-config"),
  XDG_DATA_HOME: join(SANDBOX, "xdg-data"),
  XDG_STATE_HOME: join(SANDBOX, "xdg-state"),
  XDG_CACHE_HOME: join(SANDBOX, "xdg-cache"),
  AGENTS_DECK_NO_INSTALL: "1",
  AGENTS_DECK_NO_LAN: "1",
  AGENTS_DECK_NO_NOTIFY: "1",
  AGENTS_DECK_NO_MUSIC: "1",
  AGENTS_DECK_NO_UPDATE_CHECK: "1",
  AGENTS_DECK_NO_DOWNLOAD: "1",
  AGENT_DAG_PORT: "",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
};

// A `--stop` outside the sandbox would end the developer's own deck.
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

afterAll(() => rmTempDir(SANDBOX));

let supervisor: ChildProcess | null = null;
let supervisorGone: Promise<void> = Promise.resolve();
let file = "";

/** A pid that was a process a moment ago and is not one now. */
function deadPid(): Promise<number> {
  return new Promise((done, fail) => {
    const c = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    c.on("error", fail);
    c.on("exit", () => done(c.pid!));
  });
}

beforeEach(async () => {
  rmSync(CFG, { recursive: true, force: true });
  mkdirSync(REGISTRY, { recursive: true });
  supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  const sup = supervisor;
  supervisorGone = new Promise(done => sup.on("exit", () => done()));
  const worker = await deadPid();
  file = join(REGISTRY, `${worker}.json`);
  // Started after its supervisor, as every worker is: restartingDecks reads the
  // supervisor's start time and refuses a parent that came later.
  writeFileSync(file, JSON.stringify({
    pid: worker, parent: supervisor.pid, port: 4497, token: "t",
    workspace: "", persist: null, codex: false, claude: false, version: "3.32.0",
    startedAt: new Date().toISOString(),
  }));
});

afterEach(() => {
  supervisor?.kill("SIGKILL");
  supervisor = null;
});

function runCli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, fail) => {
    let out = "";
    let err = "";
    const c = spawn(process.execPath, [DECK, ...args], { stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, cwd: SANDBOX });
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { err += String(d); });
    const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error(`${args.join(" ")} did not exit:\n${out}${err}`)); }, 30_000);
    c.on("error", e => { clearTimeout(timer); fail(e); });
    c.on("exit", code => { clearTimeout(timer); done({ code, out, err }); });
  });
}

describe("`--stop` and `--status` inside a crash-restart wait", () => {
  it("`--status` lists the deck as restarting, named by its supervisor", async () => {
    const { code, out, err } = await runCli(["--status"]);
    expect(code, `${out}${err}`).toBe(0);
    expect(out).not.toContain("no deck is running");
    expect(out).toContain("restarting after a crash");
    expect(out).toContain(`pid ${supervisor!.pid}`);
    expect(out).toContain("http://127.0.0.1:4497");
  }, 45_000);

  it("`--stop` ends the supervisor, so the deck stays stopped", async () => {
    const { code, out, err } = await runCli(["--stop"]);
    expect(code, `${out}${err}`).toBe(0);
    expect(out).not.toContain("no deck is running");
    expect(out).toContain("stopped");
    expect(out).toContain("restarting after a crash");
    await supervisorGone;
    expect(supervisor!.exitCode !== null || supervisor!.signalCode !== null).toBe(true);
  }, 45_000);

  it("leaves a record older than the crash window alone", async () => {
    // Its parent pid answering is no evidence of a supervisor by then.
    const old = new Date(Date.now() - CRASH_WINDOW_MS - 60_000);
    utimesSync(file, old, old);
    const { code, out, err } = await runCli(["--stop"]);
    expect(code, `${out}${err}`).toBe(0);
    expect(out).toContain("no deck is running");
    expect(supervisor!.exitCode).toBeNull();
    expect(supervisor!.signalCode).toBeNull();
  }, 45_000);
});
