// #2193 through a real process: the continue's three commands reach a `claude`
// executable as an argument vector, through exec.mjs's own `run` — no shell,
// in the session's folder, without another session's markers.
//
// stop-continue-2193.test.ts holds the plan with a scripted `run`; this file
// holds what that plan becomes once it is a process. THE `claude` HERE IS A
// FAKE: a script in a temp directory that writes down the argv, the working
// directory and which session markers it was handed, and answers `agents`,
// `stop` and `--resume` the way Claude Code's background commands do. Nothing
// real is run, and nothing outside the temp directory is touched.
//
// The continuer asks for `claude`; the `run` it is handed is exec.mjs's own,
// pointed at this Node with the fake script as its first argument. No
// launcher script stands in between, so the same process path (execFile, no
// shell, the cwd and env the continuer chose) runs on every platform.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// The deck's own modules come in below, and some of them read the deck's data
// and Claude Code's config when they load: all of it points inside DIR first.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-continue-exec-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
for (const k of ENV_KEYS) process.env[k] = join(DIR, k.toLowerCase());
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
for (const k of ENV_KEYS) if (!resolve(process.env[k]!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${k}`);
afterAll(() => {
  for (const k of ENV_KEYS) { if (PREV[k] === undefined) delete process.env[k]; else process.env[k] = PREV[k]; }
  rmTempDir(DIR);
});

// @ts-expect-error — plain .mjs module, no types
const { run } = await import("../../server/exec.mjs");
const { createStopContinuer, SESSION_MARKERS } = await import("../../server/stop-continue.mjs");
const { CONTINUE_PROMPT } = await import("../../server/stop-continue-gate.mjs");

const SID = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
const JOB = "7c5dcf5d";
const LOG = join(DIR, "argv.jsonl");
const STOPPED = join(DIR, "stopped");
const PWNED = join(DIR, "PWNED");
/** The session's folder, named with what a shell would act on. */
const CWD = join(DIR, "repo $(touch PWNED) ; `id` 'q'");
mkdirSync(CWD, { recursive: true });

/** The fake Claude Code: records, then answers like the background commands. */
const FAKE_JS = join(DIR, "fake-claude.mjs");
writeFileSync(FAKE_JS, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const markers = ${JSON.stringify(SESSION_MARKERS)}.filter(k => Object.keys(process.env).some(e => e.toUpperCase() === k));
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv, cwd: process.cwd(), markers }) + "\\n");
const entry = { kind: "background", id: ${JSON.stringify(JOB)}, sessionId: ${JSON.stringify(SID)}, cwd: ${JSON.stringify(CWD)}, state: "blocked" };
if (argv[0] === "agents") {
  const alive = !existsSync(${JSON.stringify(STOPPED)});
  process.stdout.write("Starting background service…\\n" + JSON.stringify([alive ? { ...entry, pid: 4242, status: "idle" } : { ...entry, state: "stopped" }]) + "\\n");
} else if (argv[0] === "stop") {
  writeFileSync(${JSON.stringify(STOPPED)}, "");
} else if (argv[0] === "--resume") {
  process.stdout.write("backgrounded · ${JOB}\\n");
} else {
  process.stderr.write("unexpected\\n");
  process.exitCode = 1;
}
`);
/** Every program the continuer asked to run. */
const asked: string[] = [];

const calls = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

function continuer() {
  return createStopContinuer({
    run: (cmd: string, args: string[], opts: object) => {
      asked.push(cmd);
      return run(process.execPath, [FAKE_JS, ...args], opts);
    },
    bin: () => "claude",
    // A working login read after the stop, with room: the gate opens.
    login: async () => ({ ok: true, at: Date.now(), room: true }),
    // The deck's environment as a Claude Code session's Bash tool leaves it.
    environ: () => ({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "9b9b9b9b-0000-4000-8000-000000000000",
      CLAUDE_JOB_DIR: join(DIR, "job"), claude_pid: "1",
    }),
    sleep: async () => {},
    every: () => ({}),
    cancel: () => {},
  });
}

describe("Continue through a real process (#2193)", () => {
  it("runs Claude Code's three commands as argument vectors, the resume in the session's own folder, with no shell between", async () => {
    const c = continuer();
    const out = await c.press(SID, { kind: "login", at: Date.now() - 60_000 });
    expect(out).toEqual({ ok: true, outcome: "continued" });
    const seen = calls();
    expect(seen.map(x => x.argv)).toEqual([
      ["agents", "--json", "--all"],
      ["stop", JOB],
      ["agents", "--json", "--all"],
      ["--resume", SID, "--bg", CONTINUE_PROMPT],
    ]);
    expect(CONTINUE_PROMPT).toBe("Continue from where you left off.");
    // Each of them asked for Claude Code itself.
    expect(asked).toEqual(["claude", "claude", "claude", "claude"]);
    // The folder's name reached the process as a path, not as shell text.
    expect(realpathSync(seen.at(-1).cwd)).toBe(realpathSync(CWD));
    expect(existsSync(PWNED)).toBe(false);
    // Never as a child of the session that started the deck.
    for (const x of seen) expect(x.markers).toEqual([]);
  }, 30_000);

  it("runs nothing for a session id a parser could read as a flag", async () => {
    const before = calls().length;
    const askedBefore = asked.length;
    const c = continuer();
    for (const sid of ["--help", "-p", "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5; id", ""]) {
      expect(await c.press(sid, { kind: "login", at: Date.now() - 60_000 }), sid).toEqual({ ok: false, reason: "bad_request" });
    }
    expect(calls().length).toBe(before);
    expect(asked.length).toBe(askedBefore);
  }, 30_000);
});
