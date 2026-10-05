// deck.log was opened without O_APPEND, so its writers overwrote each other.
//
// The first start opened the log with "w" — truncate, no O_APPEND — and its
// supervisor and worker share that descriptor and its offset. A later `ccdeck`
// beside the running deck attaches and appends its own lines at the end; the
// running deck's next write then landed at its own, older offset, over them.
// Two starts in one boot window both found nothing registered and both
// truncated, and the first deck's next write landed past the new end of the
// file, after a run of NULs. Reproduced before the fix, with real processes
// holding the descriptors:
//
//     A: server ready / B: deck already running / A: claude-swap installed
//       -> "A: server ready\nA: claude-swap installed\n"            (B's line gone)
//     A: booting / B (also fresh): deck already running / A: server ready
//       -> "B: deck already running\n\0\0\0…A: server ready\n"
//
// Now every writer appends, and a fresh start moves the old log aside instead
// of truncating it.
//
// THE DECKS ARE STAND-INS: the launcher is run for real with a spawn that hands
// the log's descriptor to a small child of this test, which writes what it is
// told through it, and a child the launcher speaks to that the test speaks for.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { DECK_LOG, detachAndWatch } = await import("../../server/detach.mjs");

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const dirs: string[] = [];
const writers: ChildProcess[] = [];
const before = new Map<string, Function[]>();

afterEach(() => {
  // The launcher installs its Ctrl+C handlers on the real `process`; take back
  // whatever each case added.
  for (const sig of SIGNALS) {
    const had = before.get(sig) ?? [];
    for (const fn of process.listeners(sig)) {
      if (!had.includes(fn)) process.removeListener(sig, fn as (...a: unknown[]) => void);
    }
  }
  before.clear();
  for (const w of writers.splice(0)) { try { w.disconnect(); } catch { /* gone */ } w.kill("SIGKILL"); }
  for (const d of dirs.splice(0)) rmTempDir(d);
});

/** A process holding the deck's descriptor, writing each line it is sent. */
type Writer = { say: (line: string) => Promise<void> };

/** One start, with `liveCount` decks registered. Resolves to the writer that
 *  stands for the deck it started, once the launcher has handed over. */
function start(logDir: string, liveCount: number, booting = false): Writer {
  if (!before.size) for (const sig of SIGNALS) before.set(sig, process.listeners(sig).slice());
  let writer: ChildProcess | null = null;
  const child = Object.assign(new EventEmitter(), { kill() {}, disconnect() {}, unref() {} });
  detachAndWatch({
    file: "/pkg/bin/agent-dag.js",
    argv: [],
    logDir,
    liveCount,
    booting,
    env: { PATH: "/usr/bin" },
    out: { write: () => true },
    execPath: "/usr/bin/node",
    spawnFn: (_f: string, _a: string[], o: { stdio: unknown[] }) => {
      writer = spawn(process.execPath, ["-e",
        "process.on('message', m => { require('fs').writeSync(1, m); process.send('ok'); })"],
      { stdio: ["ignore", o.stdio[1] as number, o.stdio[2] as number, "ipc"] });
      writers.push(writer);
      return child;
    },
    exit: () => {},
  });
  // Up: the launcher stops tailing and lets go.
  child.emit("message", { type: "booted" });
  return {
    say: (line: string) => new Promise<void>(done => {
      writer!.once("message", () => done());
      writer!.send(line);
    }),
  };
}

function logDir() {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-deck-log-"));
  dirs.push(dir);
  return dir;
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

describe("deck.log, written by more than one process", () => {
  it("keeps an attach's lines when the running deck writes after them", async () => {
    const dir = logDir();
    const a = start(dir, 0);
    await a.say("A: server ready\n");
    const b = start(dir, 1);
    await b.say("B: deck already running\n");
    await a.say("A: claude-swap installed\n");
    expect(read(join(dir, DECK_LOG))).toBe("A: server ready\nB: deck already running\nA: claude-swap installed\n");
  }, 30_000);

  it("leaves no hole when two starts in one boot window both start it afresh", async () => {
    const dir = logDir();
    const a = start(dir, 0);
    await a.say("A: booting\n");
    const b = start(dir, 0);
    await b.say("B: deck already running\n");
    await a.say("A: server ready\n");
    const log = read(join(dir, DECK_LOG));
    const all = read(join(dir, `${DECK_LOG}.1`)) + log;
    expect(all).not.toContain("\u0000");
    expect(log).toContain("B: deck already running\n");
    for (const line of ["A: booting\n", "A: server ready\n"]) expect(all).toContain(line);
  }, 30_000);

  it("is not started afresh while a deck is in its boot window", async () => {
    const dir = logDir();
    const a = start(dir, 0);
    await a.say("A: booting\n");
    const b = start(dir, 0, true);
    await b.say("B: deck already running\n");
    await a.say("A: server ready\n");
    expect(read(join(dir, DECK_LOG))).toBe("A: booting\nB: deck already running\nA: server ready\n");
  }, 30_000);
});
