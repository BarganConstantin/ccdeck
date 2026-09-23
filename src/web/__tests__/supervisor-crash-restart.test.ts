// A crashed deck, put back by the supervisor that actually ships.
//
// crash-restart.test.ts proves the two decisions — isCrash and crashPolicy — as
// pure functions, and pins the wiring between them and bin/agent-dag.js as
// source text. The wiring is where this can break without either decision
// changing: `served` read off the wrong variable, `boundPort` reset before the
// check, the relaunch sent through `launch(false)` so it drops `--port`, or the
// forwarded `booted` ending the supervisor once the launcher has gone. Every
// one of those passes every string pin, and every one leaves a crashed
// background deck down for good — no hook events, no LAN beacon, no quota
// watch — with no terminal left to show it.
//
// So this runs it. The SHIPPED bin/agent-dag.js is copied into a sandbox beside
// `export *` shims onto the real server modules, and bin/deck.js is replaced by
// a few lines that follow STUB_PLAN: report a port, maybe say it booted, then
// end one way or another. A relaunched worker says what it was started with and
// leaves cleanly, so every run ends on its own. The technique is
// upgrade-no-outage.test.ts's, and nothing here binds a port or touches a deck.
//
// Each crash case costs the first backoff, one second, because that is the
// supervisor's own timer and shortening it would be testing something else.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-crash-restart-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(SANDBOX);
});

const ROOT = join(SANDBOX, "app");
const SUPERVISOR = join(ROOT, "bin", "agent-dag.js");
const WORKER = join(ROOT, "bin", "deck.js");
const SERVER = join(ROOT, "src", "server");

// Belt and braces: every path here is derived, and a single wrong join would
// have this file spawning the developer's own deck.
for (const p of [ROOT, SUPERVISOR, WORKER, SERVER]) {
  if (!p.startsWith(SANDBOX)) throw new Error(`refusing to run: ${p} is outside ${SANDBOX}`);
}

mkdirSync(join(ROOT, "bin"), { recursive: true });
mkdirSync(SERVER, { recursive: true });
writeFileSync(join(ROOT, "package.json"), JSON.stringify({ name: "ccdeck", version: "9.0.0", type: "module" }));

copyFileSync(fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url)), SUPERVISOR);

// Every module the supervisor imports, re-exported from the repo rather than
// copied, so what runs here is what ships. Nothing is shadowed: the only thing
// this file replaces is the worker.
for (const mod of [
  "args.mjs", "brand.mjs", "detach.mjs", "exec.mjs", "invoked-as.mjs", "npx.mjs",
  "self-update.mjs", "supervisor.mjs", "term.mjs",
]) {
  const real = new URL(`../../server/${mod}`, import.meta.url).href;
  writeFileSync(join(SERVER, mod), `export * from ${JSON.stringify(real)};\n`);
}

const PORT = 47714;

// Stands in for bin/deck.js. `listening` is what tells the supervisor the deck
// was UP, which is the line between a crash and a boot failure; `booted` is
// what it forwards to whoever detached it. Each message is sent and its
// delivery waited for before the next step, because a worker that exits in the
// same tick as a send can take the message with it — and a lost `listening`
// would turn a crash case into a boot-failure case for a reason that is this
// file's, not the supervisor's.
writeFileSync(WORKER, [
  `const say = (s) => process.stdout.write(s + "\\n");`,
  `const send = (m) => new Promise((r) => process.send(m, () => r()));`,
  `const later = (ms) => new Promise((r) => setTimeout(r, ms));`,
  `if (process.env.AGENTS_DECK_RESPAWN === "1") {`,
  `  say("RESPAWNED " + process.argv.slice(2).join(" ") + " restarts=" + process.env.AGENTS_DECK_RESTARTS);`,
  `  await send({ type: "listening", port: ${PORT} });`,
  `  await send({ type: "booted" });`,
  `  await later(100);`,
  `  process.exit(0);`,
  `}`,
  `const plan = process.env.STUB_PLAN;`,
  `say("WORKER " + process.pid);`,
  `if (plan !== "boot-failure") await send({ type: "listening", port: ${PORT} });`,
  `if (plan === "crash-after-launcher-left") { await send({ type: "booted" }); await later(400); }`,
  `await later(100);`,
  `if (plan === "clean") process.exit(0);`,
  `if (plan === "kill") process.kill(process.pid, "SIGKILL");`,
  `process.exit(1);`,
].join("\n"));

type Run = { code: number | null; signal: string | null; out: string; booted: number };

/** One whole supervisor lifetime, from launch to exit. `ipc` hands it the
 *  channel detachAndWatch would, and hangs up on the first `booted`, the way
 *  the launcher does once the terminal has been given back. */
const runSupervisor = (plan: string, { ipc = false } = {}) =>
  new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [SUPERVISOR, "--no-persist"], {
      stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      // AGENTS_DECK_DETACHED, because the supervisor is what is under test and
      // this is how it runs once a start has gone to the background. Without it
      // bin/agent-dag.js would detach a copy of itself and leave.
      env: { ...process.env, AGENTS_DECK_DETACHED: "1", STUB_PLAN: plan, NO_COLOR: "1" },
    });
    let out = "";
    let booted = 0;
    child.stdout!.on("data", d => { out += String(d); });
    child.stderr!.on("data", d => { out += String(d); });
    child.on("message", (m: { type?: string }) => {
      if (m?.type !== "booted") return;
      booted++;
      if (child.connected) child.disconnect();
    });
    // A floor under a run that has already gone wrong: every case here ends in
    // under two seconds, and a supervisor that never exits must not hang the
    // suite.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the supervisor did not exit; it said:\n${out}`));
    }, 15_000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, booted }); });
  });

describe("a deck that falls over after it was up", () => {
  it("is started again, on the port it had, with the restart counted", async () => {
    const run = await runSupervisor("crash");
    expect(run.out).toContain("the deck stopped on its own (exit 1)");
    expect(run.out).toContain("(1/5)");
    // The port the worker REPORTED, appended after the user's own argv so the
    // worker's parser keeps it: a relaunch without it falls back to a random
    // port and moves the deck out from under every open tab.
    expect(run.out).toContain(`RESPAWNED --no-persist --port ${PORT} restarts=1`);
    // The notice first, then the worker — the order a reader of deck.log needs.
    expect(run.out.indexOf("stopped on its own")).toBeLessThan(run.out.indexOf("RESPAWNED"));
    // And the relaunched worker's clean exit is the supervisor's own.
    expect(run.code).toBe(0);
  }, 20_000);

  it("is started again when it was killed rather than exiting", async () => {
    // An OOM killer or a stray `kill -9`. POSIX reports the signal. Windows
    // has none to report: a process ending itself with SIGKILL there is a
    // TerminateProcess with status 1, so the same crash reads as `exit 1` —
    // and is put back all the same, which is the half that matters.
    const run = await runSupervisor("kill");
    expect(run.out).toContain(process.platform === "win32"
      ? "the deck stopped on its own ("
      : "the deck stopped on its own (killed by SIGKILL)");
    expect(run.out).toContain(`RESPAWNED --no-persist --port ${PORT} restarts=1`);
    expect(run.code).toBe(0);
  }, 20_000);
});

describe("a deck that never came up, or left on its own", () => {
  it("is not retried when it failed before binding a port", async () => {
    // No `listening`, so nothing was ever served. That is a start that failed
    // — a port the OS will not give, a dist/ that was never built — and five
    // retries would print the same refusal six times and fix nothing. The
    // worker's own code is the supervisor's, so a script sees the failure.
    const run = await runSupervisor("boot-failure");
    expect(run.out).toContain("WORKER ");
    expect(run.out).not.toContain("stopped on its own");
    expect(run.out).not.toContain("RESPAWNED");
    expect(run.code).toBe(1);
  }, 20_000);

  it("is not put back after a clean exit, which is the deck ending itself", async () => {
    // Exit 0 is /api/shutdown's — what `ccdeck --stop` asks for. A restart
    // here would make the off switch a no-op.
    const run = await runSupervisor("clean");
    expect(run.out).not.toContain("stopped on its own");
    expect(run.out).not.toContain("RESPAWNED");
    expect(run.code).toBe(0);
  }, 20_000);
});

describe("a crash after the launcher has gone", () => {
  it("does not take the supervisor down when the new worker says it booted", async () => {
    // The launcher disconnects the moment the FIRST boot finishes. Every later
    // boot therefore forwards `booted` down a closed channel, and a
    // `process.send` there does not throw where it is called — it emits
    // ERR_IPC_CHANNEL_CLOSED on `process` a tick later, which nothing handles.
    // The deck came back and the process supervising it died of saying so.
    const run = await runSupervisor("crash-after-launcher-left", { ipc: true });
    // The first boot reached the "launcher", which is what made it hang up.
    expect(run.booted).toBe(1);
    expect(run.out).toContain(`RESPAWNED --no-persist --port ${PORT} restarts=1`);
    expect(run.out).not.toContain("ERR_IPC_CHANNEL_CLOSED");
    expect(run.code).toBe(0);
  }, 20_000);
});
