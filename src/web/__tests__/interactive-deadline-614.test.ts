// #614. `runInteractive`'s deadline set `timedOut = true`, killed the tree and
// then said nothing: the promise it had handed the caller was left to the
// child's `close` event. `close` waits for the process to exit AND for its
// stdio pipes to close, so one descendant that outlives the kill holding the
// inherited stdout keeps it from ever arriving — the child is dead, the promise
// stays pending, and it stays pending for the life of the process.
//
// That is not an exotic shape. On Windows a `claude`/`cswap` that resolves to a
// `.cmd` shim is launched through `cmd.exe /d /s /c`, so the real tool is a
// grandchild by construction and a `taskkill` that cannot run reaches only the
// wrapper; on macOS and Linux any cswap subprocess still alive when SIGTERM
// lands does the same thing. The cases below build it out of `node` alone, so
// they run on all three.
//
// What the stall cost is the reason this file exists rather than a single
// assertion about a promise. `removeAccount` and `importAccount` await that
// promise INSIDE `withStoreLock`, so a pending link freezes the accounts-store
// mutex: every later login, cancel, import, remove, alias and reorder queues
// behind it and never runs, the HTTP request is never answered, and
// `spawnLogin`'s process-exit handler leaks with the promise. The lock case is
// the one that pins the consequence.
//
// `run`, forty lines above in the same module, has stated the outcome before
// killing since #552 and its header names this exact failure. `runInteractive`
// now does the same, and its `kill()` carries a bounded grace of the same kind
// so a cancelled sign-in cannot wedge the mutex either.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// cswap-admin.mjs resolves the claude-swap store out of the home directory, and
// nothing in this file may touch the real one — so every home-shaped variable
// points into a temp directory BEFORE the modules load, and the resolution is
// checked rather than assumed.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-interactive-614-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");
process.env.CLAUDE_SWAP_BACKUP = join(SANDBOX, ".claude-swap-backup");
if (!homedir().startsWith(SANDBOX)) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${SANDBOX}`);
}

// @ts-expect-error — .mjs server module, no types
const { runInteractive } = await import("../../server/exec.mjs");
// @ts-expect-error — .mjs server module, no types
const { failureText, withStoreLock } = await import("../../server/cswap-admin.mjs");

/**
 * The stand-in for a hung `cswap`: it starts a grandchild on the stdout it was
 * handed and then hangs itself, which is the shape of every real occurrence —
 * the tool under a cmd.exe wrapper on Windows, a Python subprocess of cswap
 * everywhere else.
 *
 * A file rather than `node -e`, because the script has to carry a path this
 * test chose and Windows path separators inside a `-e` string are a quoting
 * problem that has nothing to teach anyone here. The pid file is argv[2], and
 * it is written BEFORE the line on stdout, so a reader that has seen the line
 * knows the file is there.
 */
const HOLDER = join(SANDBOX, "holder-614.cjs");
writeFileSync(HOLDER, [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  "// stdio inherit is the whole point: the grandchild holds the same stdout",
  "// pipe this process was given, so closing it is not ours to do any more.",
  'const kid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"],',
  '  { stdio: ["ignore", "inherit", "inherit"] });',
  "writeFileSync(process.argv[2], String(kid.pid));",
  'process.stdout.write("holding\\n");',
  "setTimeout(() => {}, 30000);",
].join("\n") + "\n");

// Every grandchild this file starts, so none is left behind on the way out.
const started: string[] = [];
const pidFile = (name: string) => {
  const path = join(SANDBOX, `${name}-614.pid`);
  started.push(path);
  return path;
};
const reap = (path: string) => {
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
};

afterAll(() => {
  for (const path of started) reap(path);
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

// The sentinels. Strings rather than symbols so a red case says what happened
// in the diff itself: "expected 'the deadline never settled' not to be …" is
// the whole bug report.
const NEVER_SETTLED = "the deadline never settled";
const NEVER_CANCELLED = "kill() never settled";
const LOCK_WEDGED = "the store lock never came back";

const after = <T>(ms: number, value: T) => new Promise<T>(res => {
  // Unref'd, so a sentinel that lost its race cannot hold the runner open.
  const timer: any = setTimeout(() => res(value), ms);
  timer.unref?.();
});

// The deadline under test, and the window a settled promise has to land in.
// Long enough that `node` reaching its first two statements inside it is not a
// claim about a busy machine; short enough that three cases on it cost seconds.
const DEADLINE_MS = 2_500;
const PATIENCE_MS = 8_000;
// How many times a runner is allowed to be too busy to start node before this
// is called a failure rather than a fact about the machine. A real regression
// never reaches the second attempt — it hangs, and the sentinel says so first.
const ATTEMPTS = 3;

/** The message for a machine that could not get the fixture off the ground. */
const tooSlow = (what: string) => new Error(
  `${what}: node did not reach its second statement inside ${DEADLINE_MS}ms, ${ATTEMPTS} times running, `
  + `so there was never a grandchild holding the stdout pipe and this case had nothing to prove. `
  + `Nothing about runInteractive is under test in that outcome — raise DEADLINE_MS or run the suite `
  + `on a quieter machine.`);

describe("runInteractive's deadline, when the child leaves something behind", () => {
  it("settles rather than waiting on a pipe a descendant still holds", async () => {
    const pids = pidFile("deadline");
    let settled: any = null;
    for (let attempt = 1; ; attempt++) {
      rmSync(pids, { force: true });
      const child = runInteractive(process.execPath, [HOLDER, pids], { timeout: DEADLINE_MS });
      settled = await Promise.race([child.done, after(PATIENCE_MS, NEVER_SETTLED)]);
      // Hanging is a failure whatever the machine managed, so it is reported
      // rather than retried.
      if (settled === NEVER_SETTLED) break;
      // The grandchild is the point of the fixture. Its pid file present means
      // there really was something holding the pipe open when the deadline
      // fired, so a settled promise means the deadline settled it.
      if (existsSync(pids)) break;
      if (attempt === ATTEMPTS) throw tooSlow("the deadline case");
    }

    expect(settled).not.toBe(NEVER_SETTLED);
    expect(settled.timedOut).toBe(true);
    expect(settled.ok).toBe(false);
    // The same code `run` reports for the same event; the callers key off both.
    expect(settled.code).toBe("ETIMEDOUT");
    expect(settled.code).not.toBe(0);
    expect(settled.killed).toBe(true);
    // And what removeAccount puts in front of the user for it. `!r.ok` is the
    // branch it takes, and failureText turns this shape into a sentence rather
    // than "cswap remove exited -1".
    expect(failureText(settled, "cswap remove")).toBe("cswap remove took too long and was stopped");
  }, 40_000);

  it("hands the accounts-store lock back, so the next mutation still runs", async () => {
    const pids = pidFile("lock");
    let stopped: any = null;
    for (let attempt = 1; ; attempt++) {
      rmSync(pids, { force: true });
      // removeAccount's shape exactly: the run is awaited from INSIDE the lock,
      // so a promise that never settles is a mutex that is never released.
      const mutation = withStoreLock(
        async () => runInteractive(process.execPath, [HOLDER, pids], { timeout: DEADLINE_MS }).done);
      stopped = await Promise.race([mutation, after(PATIENCE_MS, NEVER_SETTLED)]);
      if (stopped === NEVER_SETTLED) break;
      if (existsSync(pids)) break;
      if (attempt === ATTEMPTS) throw tooSlow("the store-lock case");
    }
    // The consequence, and the reason this is a mutex bug and not only an exec
    // bug: withStoreLock chains on the promise it was given, so a link that
    // never settles freezes the chain and startLogin, cancelLogin,
    // submitLoginCode, setAlias and moveAccount never run again.
    //
    // Asserted BEFORE the run's own result on purpose. Both go red together
    // when the deadline stops settling, and this is the sentence worth reading
    // first: the deck did not merely mishandle one timeout, it stopped
    // accepting account changes.
    const next = await Promise.race([
      withStoreLock(async () => "the next mutation ran"),
      after(PATIENCE_MS, LOCK_WEDGED),
    ]);
    expect(next).toBe("the next mutation ran");

    expect(stopped).not.toBe(NEVER_SETTLED);
    expect(stopped.timedOut).toBe(true);
  }, 40_000);

  it("settles after kill() even though killing cannot close the pipes", async () => {
    const pids = pidFile("cancel");
    // Far beyond the case's own budget: nothing here may be settled by the
    // deadline, or it would prove the deadline twice and kill() not at all.
    const child = runInteractive(process.execPath, [HOLDER, pids], { timeout: 10 * 60_000 });

    // The fixture's own announcement, written after the pid file, so waiting
    // for it is waiting for a grandchild that demonstrably exists. No clock to
    // guess at: this is what makes the case deterministic where the two above
    // need a retry.
    const holding = new Promise<void>(res => child.onLine((line: string) => {
      if (line.includes("holding")) res();
    }));
    const heard = await Promise.race([holding.then(() => true), after(PATIENCE_MS, false)]);
    if (!heard || !existsSync(pids)) throw tooSlow("the cancel case");

    child.kill();
    const settled = await Promise.race([child.done, after(PATIENCE_MS, NEVER_CANCELLED)]);

    // cancelLogin kills without awaiting, and spawnLogin unregisters its
    // process-exit handler off this promise — a kill that cannot settle leaks
    // that handler and, for anything that does await, wedges the same mutex.
    expect(settled).not.toBe(NEVER_CANCELLED);
    expect(settled.killed).toBe(true);
    expect(settled.ok).toBe(false);
    // A cancel is not a deadline, and the panel must not call it one.
    expect(settled.timedOut).toBe(false);
    expect(settled.code).not.toBe(0);
  }, 40_000);
});
