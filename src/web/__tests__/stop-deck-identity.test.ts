// `ccdeck --stop` ending a process that is not a deck's supervisor.
//
// A deck between workers is named by its supervisor's pid, read out of the
// crashed worker's record (#1779). The record was taken as proof when it was
// fresh and the pid answered signal 0 — but a deck that dies without running
// shutdown (a power cut, a hard reset, a console closed on Windows) leaves the
// same record with the same fresh mtime, and once the machine has rebooted, or
// simply handed that pid to something else, the pid answers for a stranger.
// `--stop` then signalled it: SIGTERM and SIGKILL on POSIX, `taskkill /T /F`
// with its whole tree on Windows. Reproduced before the fix:
//
//     record { pid: <dead>, parent: <a process started a minute AFTER it> }
//     $ ccdeck --stop   -> "stopped … (killed — it was restarting after a crash)"
//
// and the process was gone.
//
// Now the parent has to have been there before the worker it supervises: its
// start time is read and compared with the record's `startedAt`, and a record
// stamped before this boot is never a deck between workers at all.
//
// EVERYTHING HERE IS FAKE OR OURS. The unit cases inject the registry and the
// probes. The CLI is spawned for real with every path in a temp directory, and
// the "supervisor" is a child process of this test, named by a record in that
// directory's registry. No real deck or registry is touched.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const running = await import("../../server/running-deck.mjs");

type Rec = { pid: number; parent?: number | null; port: number; token: string; startedAt?: string; restarting?: boolean };
const { restartingDecks, processStartedAt } = running as {
  restartingDecks: (o: Record<string, unknown>) => Promise<Rec[]>;
  processStartedAt: (pid: number) => Promise<number | null>;
};

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const NOW = 1_800_000_000_000;
const STARTED = NOW - 3_600_000;
const CRASHED: Rec = { pid: 222, parent: 111, port: 4497, token: "t", startedAt: new Date(STARTED).toISOString() };

function registry(rec: Rec, mtimeMs: number) {
  return {
    readdir: async () => ["222.json"],
    readFile: async () => JSON.stringify(rec),
    stat: async () => ({ mtimeMs }),
  };
}

describe("which supervisor a crashed worker's record may name", () => {
  const fresh = registry(CRASHED, NOW - 4_000);
  const base = { dir: "/x", self: 1, selfParent: 2, alive: (p: number) => p === 111, now: NOW, bootedAt: NOW - 86_400_000 };

  it("is the process that was running before the worker started", async () => {
    const got = await restartingDecks({ ...base, fs: fresh, startedAt: async () => STARTED - 1_000 });
    expect(got).toEqual([{ ...CRASHED, restarting: true }]);
  });

  it("is never a process that started after the worker did, whatever its pid", async () => {
    // The pid was handed to something else once the deck was gone.
    const got = await restartingDecks({ ...base, fs: fresh, startedAt: async () => NOW - 60_000 });
    expect(got).toEqual([]);
  });

  it("is never a process whose start cannot be read", async () => {
    expect(await restartingDecks({ ...base, fs: fresh, startedAt: async () => null })).toEqual([]);
  });

  it("is never named by a record that has no start of its own", async () => {
    const bare = registry({ ...CRASHED, startedAt: undefined }, NOW - 4_000);
    expect(await restartingDecks({ ...base, fs: bare, startedAt: async () => STARTED - 1_000 })).toEqual([]);
  });

  it("is never named by a record stamped before this boot", async () => {
    // Every pid on the machine started over at the reboot.
    const got = await restartingDecks({ ...base, fs: fresh, bootedAt: NOW - 1_000, startedAt: async () => STARTED - 1_000 });
    expect(got).toEqual([]);
  });
});

describe("when a process started", () => {
  const spawned: ChildProcess[] = [];
  afterEach(() => { for (const c of spawned.splice(0)) c.kill("SIGKILL"); });

  it("is read for a process that is running", async () => {
    const before = Date.now();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    spawned.push(child);
    await new Promise(done => setTimeout(done, 300));
    const at = await processStartedAt(child.pid!);
    expect(at).not.toBeNull();
    // `ps` reads elapsed time in whole seconds.
    expect(at!).toBeGreaterThan(before - 2_500);
    expect(at!).toBeLessThan(Date.now() + 1_000);
  }, 30_000);

  it("is null for one that is not", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise(done => child.on("exit", done));
    expect(await processStartedAt(child.pid!)).toBeNull();
    expect(await processStartedAt(0)).toBeNull();
    expect(await processStartedAt(-1)).toBeNull();
  }, 30_000);
});

// ── the CLI, spawned ────────────────────────────────────────────────────────

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-stop-identity-"));
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

/** A pid that was a process a moment ago and is not one now. */
function deadPid(): Promise<number> {
  return new Promise((done, fail) => {
    const c = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    c.on("error", fail);
    c.on("exit", () => done(c.pid!));
  });
}

describe("`--stop` beside a fresh record whose supervisor pid is somebody else's", () => {
  let stranger: ChildProcess | null = null;
  afterEach(() => { stranger?.kill("SIGKILL"); stranger = null; });

  it("leaves that process alone and says no deck is running", async () => {
    rmSync(CFG, { recursive: true, force: true });
    mkdirSync(REGISTRY, { recursive: true });
    const worker = await deadPid();
    stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    // The worker's record says it started a minute ago and was stamped just
    // now, and the process its `parent` names started after it.
    writeFileSync(join(REGISTRY, `${worker}.json`), JSON.stringify({
      pid: worker, parent: stranger.pid, port: 4497, token: "t",
      workspace: "", persist: null, codex: false, claude: false, version: "3.32.0",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    await new Promise(done => setTimeout(done, 300));

    const { code, out, err } = await runCli(["--stop"]);
    expect(code, `${out}${err}`).toBe(0);
    expect(out).toContain("no deck is running");
    expect(stranger.exitCode).toBeNull();
    expect(stranger.signalCode).toBeNull();
  }, 45_000);
});
