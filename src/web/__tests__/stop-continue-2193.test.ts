// #2193: continuing a background session whose turn stopped on an expired
// login or a usage limit — by a press of Continue, or by itself once a working
// login is active again, when the user has turned that on.
//
// What the deck runs is Claude Code's own background commands, in a fixed
// order (src/server/stop-continue.mjs's header): `claude agents --json --all`
// to learn what the session is doing, `claude stop <id>` only when its process
// is alive and idle, `claude agents --json --all` again until Claude Code lists
// no live process for it, and `claude --resume <session> --bg "Continue from
// where you left off."` in its own directory. These cases drive the continuer
// with a scripted `run` and read back exactly what it ran — never a real
// Claude Code, and nothing reaches a disk outside a temp directory.
//
// The automatic half has its own rules and they are held here: off by
// default, once per stop, only after a reading of a working login newer than
// the stop, only for a session Claude Code lists as background and held up,
// and never again for a session that stops again right after being continued
// until somebody acts on it — with a cap across sessions and a pause after
// failures in a row.
//
// The deck's own continuer, the one the routes and the hook door use, is in
// here too, so nothing it could run may be real: exec.mjs is replaced by one
// that records and runs nothing, and HOME, the deck's data and the Claude
// config all point inside one temp directory, checked before anything that
// reads them is imported.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-continue-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.CCDECK_HOME = join(DIR, "deck");
const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);
afterAll(() => {
  for (const k of ENV_KEYS) { if (PREV[k] === undefined) delete process.env[k]; else process.env[k] = PREV[k]; }
  rmTempDir(DIR);
});

/** What the deck's own continuer asked exec.mjs to run: nothing, below. */
const { spawned } = vi.hoisted(() => ({ spawned: [] as string[][] }));
vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    spawned.push([cmd, ...args]);
    return { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "not in this suite" };
  },
  runDetached: () => {},
  pathLookup: () => null,
}));

const {
  AUTO_CAP, AUTO_WINDOW_MS, FAIL_PAUSE_MS, FAIL_STREAK, NOT_NOW_LOOKS, STOP_KEEP_MS,
  agentEntryOf, agentsArgv, continueEnv, continuePlan, copyNote, createStopContinuer, resumeArgv, stopArgv,
  handleStopContinue, handleStopContinueRead, noteStopContinue,
} = await import("../../server/stop-continue.mjs");
const { CONTINUE_PROMPT, REPEAT_HOLD_MS, continueGate, loginEvidence } = await import("../../server/stop-continue-gate.mjs");
const { DEFAULTS, normalise } = await import("../../server/deck-prefs.mjs");

/** A session's own folder, which the resume runs in. */
const CWD = join(DIR, "repo");
mkdirSync(CWD, { recursive: true });

const SID = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
const SID2 = "2a1f3d0b-7e1c-4d22-8a40-3b88d2e9f9c6";
const JOB = "7c5dcf5d";
const T0 = 1_800_000_000_000;

type Call = { args: string[]; cwd?: string };
type Entry = Record<string, unknown>;

/**
 * A scripted Claude Code. `entries` is what `claude agents --json --all`
 * lists, and `claude stop` takes the process off it (after `stopLag` more
 * listings, or never when `stopSticks`). The resume prints `resumeOut` and
 * exits `resumeCode`.
 */
function fakeClaude(entries: Entry[], opts: { stopLag?: number; stopSticks?: boolean; stopCode?: number; resumeOut?: string; resumeCode?: number; agentsCode?: number } = {}) {
  const calls: Call[] = [];
  const envs: Record<string, string>[] = [];
  let lag = -1;
  const ok = (stdout = "") => ({ ok: true, code: 0, killed: false, timedOut: false, stdout, stderr: "" });
  const bad = (code: number, stderr: string) => ({ ok: false, code, killed: false, timedOut: false, stdout: "", stderr });
  const run = async (_bin: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}) => {
    calls.push({ args, ...(o.cwd ? { cwd: o.cwd } : {}) });
    envs.push(o.env ?? {});
    if (args[0] === "agents") {
      if (opts.agentsCode) return bad(opts.agentsCode, "agents: boom");
      if (lag === 0) for (const e of entries) if (e.id === stopped) { delete e.pid; delete e.status; e.state = "stopped"; }
      if (lag > 0) lag--;
      return ok(`Starting background service…\n${JSON.stringify(entries)}`);
    }
    if (args[0] === "stop") {
      if (opts.stopCode) return bad(opts.stopCode, "stop: no such session");
      stopped = args[1];
      lag = opts.stopSticks ? Infinity : (opts.stopLag ?? 0);
      return ok();
    }
    if (args[0] === "--resume") {
      return opts.resumeCode ? bad(opts.resumeCode, "Workspace not trusted") : ok(opts.resumeOut ?? `backgrounded · ${JOB}\n`);
    }
    return bad(1, "unexpected");
  };
  let stopped: unknown = null;
  return { run, calls, envs, argvs: () => calls.map(c => c.args) };
}

/** A background session blocked on its expired login, its process idle. */
const blocked = (over: Entry = {}): Entry => ({
  kind: "background", id: JOB, sessionId: SID, cwd: CWD, startedAt: T0 - 60_000,
  state: "blocked", pid: 4242, status: "idle", ...over,
});

const stopEvent = (sid = SID, error = "authentication_failed") => ({
  hook_event_name: "StopFailure", session_id: sid, cwd: CWD, error, last_assistant_message: "Login expired · Please run /login",
});

/** A reading of the active account taken `ms` after the stop, with room. */
const after = (ms: number, pct = 40) => ({ ok: true, at: T0 + ms, room: pct < 100 });

/** The deck's environment when a Claude Code session's Bash tool started it. */
const DECK_ENV = {
  PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/u/.claude-work", ANTHROPIC_BASE_URL: "https://gateway.example.test",
  CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "9b9b9b9b-0000-4000-8000-000000000000",
  CLAUDE_JOB_DIR: "/home/u/.claude/jobs/9b9b9b9b", CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/1.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_PID: "1", claude_job_dir: "/lower/case/too",
};

function continuer({ claude, evidence = null as unknown, auto = false, clock = { t: T0 } }: {
  claude: ReturnType<typeof fakeClaude>; evidence?: unknown; auto?: boolean; clock?: { t: number };
}) {
  const asked: { force: boolean }[] = [];
  const state = { evidence, auto };
  const c = createStopContinuer({
    run: claude.run,
    bin: () => "claude",
    login: async ({ force = false } = {}) => { asked.push({ force }); return state.evidence; },
    autoOn: () => state.auto,
    environ: () => DECK_ENV,
    now: () => clock.t,
    sleep: async () => {},
    every: () => ({}),
    cancel: () => {},
  });
  return { c, asked, state, clock };
}

describe("the gate: a working login, read after the stop, with room", () => {
  it("reads the quota reading as evidence, by the reading's own clock", () => {
    expect(loginEvidence(null)).toBeNull();
    expect(loginEvidence({ ok: false, reason: "cli_failed", fetchedAt: T0 })).toEqual({ ok: false, at: T0, room: null });
    expect(loginEvidence({ ok: true, fetchedAt: T0, session5hPct: 40, week7dPct: 10 })).toEqual({ ok: true, at: T0, room: true });
    // A reading the deck is only holding over is still as old as it says.
    expect(loginEvidence({ ok: true, stale: true, fetchedAt: T0 - 5, session5hPct: 100, week7dPct: 10 })).toEqual({ ok: true, at: T0 - 5, room: false });
    expect(loginEvidence({ ok: true, fetchedAt: T0, session5hPct: 20, week7dPct: null })).toEqual({ ok: true, at: T0, room: true });
    expect(loginEvidence({ ok: true, fetchedAt: "soon" })).toEqual({ ok: false, at: 0, room: null });
  });

  it("holds a login or limit stop back until a working reading newer than the stop has room", () => {
    for (const kind of ["login", "usage-limit"] as const) {
      const stop = { kind, at: T0 };
      expect(continueGate(stop, null)).toEqual({ ready: false, reason: "no-login" });
      expect(continueGate(stop, { ok: false, at: T0 + 9, room: null })).toEqual({ ready: false, reason: "no-login" });
      expect(continueGate(stop, { ok: true, at: T0, room: true })).toEqual({ ready: false, reason: "before-stop" });
      expect(continueGate(stop, { ok: true, at: T0 - 1, room: true })).toEqual({ ready: false, reason: "before-stop" });
      expect(continueGate(stop, { ok: true, at: T0 + 1, room: false })).toEqual({ ready: false, reason: "no-room" });
      expect(continueGate(stop, { ok: true, at: T0 + 1, room: true })).toEqual({ ready: true, reason: null });
      expect(continueGate(stop, { ok: true, at: T0 + 1, room: null })).toEqual({ ready: true, reason: null });
    }
    // Not about the login at all.
    expect(continueGate({ kind: "api-error", at: T0 }, null)).toEqual({ ready: true, reason: null });
  });
});

describe("the commands, as literal argument vectors", () => {
  it("are Claude Code's documented background commands, word for word", () => {
    expect(agentsArgv()).toEqual(["agents", "--json", "--all"]);
    expect(stopArgv(JOB)).toEqual(["stop", JOB]);
    expect(resumeArgv(SID)).toEqual(["--resume", SID, "--bg", "Continue from where you left off."]);
    expect(CONTINUE_PROMPT).toBe("Continue from where you left off.");
  });

  it("refuse an id that a parser could read as a flag, or that is not one", () => {
    for (const bad of ["-h", "--all", "", " 7c5d", "7c5d dcf", "a".repeat(65), 42, null]) {
      expect(stopArgv(bad as never), String(bad)).toBeNull();
    }
    for (const bad of ["--resume", "-p", "not-a-uuid", `${SID}\n--bg`, "", null]) {
      expect(resumeArgv(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("what Claude Code lists, and what that makes the plan", () => {
  it("reads the list out of anything printed around it, and checks every field", () => {
    const out = `Starting background service…\n${JSON.stringify([
      { kind: "interactive", sessionId: SID2, cwd: "/x", startedAt: 1, pid: 9, status: "busy" },
      blocked({ id: "-rf", pid: "4242", status: "asleep" }),
    ])}\n`;
    expect(agentEntryOf(out, SID).entry).toEqual({ kind: "background", id: null, state: "blocked", alive: false, status: null, cwd: CWD });
    expect(agentEntryOf(out, "nobody").entry).toBeNull();
    expect(agentEntryOf("not json", SID).entry).toBeUndefined();
  });

  it("stops first only a live, idle process, and leaves alone one that is busy, waiting or working", () => {
    const e = (over: Entry) => agentEntryOf(JSON.stringify([blocked(over)]), SID).entry;
    expect(continuePlan(e({}))).toEqual({ id: JOB, stopFirst: true });
    expect(continuePlan(e({ pid: undefined, status: undefined, state: "failed" }))).toEqual({ id: JOB, stopFirst: false });
    expect(continuePlan(e({ status: "busy" }))).toEqual({ refuse: "working" });
    expect(continuePlan(e({ state: "working" }))).toEqual({ refuse: "working" });
    expect(continuePlan(e({ status: "waiting", waitingFor: "permission prompt" }))).toEqual({ refuse: "waiting" });
    expect(continuePlan(e({ status: undefined }))).toEqual({ refuse: "waiting" });
    expect(continuePlan(e({ kind: "interactive" }))).toEqual({ refuse: "interactive" });
    expect(continuePlan(null)).toEqual({ refuse: "not_listed" });
    expect(continuePlan(undefined)).toEqual({ refuse: "unreadable" });
    // The automatic continue asks more: Claude Code must call it held up.
    expect(continuePlan(e({ state: "done" }), { auto: true })).toEqual({ refuse: "not_held" });
    expect(continuePlan(e({ state: "done" }))).toEqual({ id: JOB, stopFirst: true });
    expect(continuePlan(e({ state: "failed" }), { auto: true })).toEqual({ id: JOB, stopFirst: true });
  });

  it("finds Claude Code's note: line when it started a copy instead", () => {
    expect(copyNote(`backgrounded · 9a8b7c6d\n\u001b[2mnote: the session is open in another terminal, so this is a copy\u001b[0m`))
      .toBe("the session is open in another terminal, so this is a copy");
    expect(copyNote(`backgrounded · ${JOB}`)).toBeNull();
  });
});

describe("a press of Continue on a background session", () => {
  it("stops the idle process, waits until Claude Code lists none, then resumes it in its own folder", async () => {
    const claude = fakeClaude([blocked()], { stopLag: 2 });
    const { c } = continuer({ claude, evidence: after(5_000) });
    c.noteEvent(stopEvent(), T0);
    const out = await c.press(SID, { kind: "login", at: T0 });
    expect(out).toEqual({ ok: true, outcome: "continued" });
    expect(claude.argvs()).toEqual([
      ["agents", "--json", "--all"],
      ["stop", JOB],
      ["agents", "--json", "--all"],
      ["agents", "--json", "--all"],
      ["agents", "--json", "--all"],
      ["--resume", SID, "--bg", CONTINUE_PROMPT],
    ]);
    expect(claude.calls.at(-1)!.cwd).toBe(CWD);
    expect(c.records().get(SID)!.last).toMatchObject({ auto: false, ok: true, outcome: "continued" });
  });

  it("runs every command as a session of its own, never as a child of the one that started the deck", async () => {
    const claude = fakeClaude([blocked()]);
    await continuer({ claude, evidence: after(5_000) }).c.press(SID, { kind: "login", at: T0 });
    expect(claude.envs).toHaveLength(4);
    for (const env of claude.envs) {
      expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/u/.claude-work", ANTHROPIC_BASE_URL: "https://gateway.example.test" });
    }
    expect(continueEnv({ HOME: "/h", CLAUDE_JOB_DIR: "/j", Path: "C:\\bin" })).toEqual({ HOME: "/h", Path: "C:\\bin" });
  });

  it("resumes a session whose process has already exited without stopping anything", async () => {
    const claude = fakeClaude([blocked({ pid: undefined, status: undefined, state: "failed" })]);
    const { c } = continuer({ claude, evidence: after(5_000) });
    expect(await c.press(SID, { kind: "usage-limit", at: T0 })).toEqual({ ok: true, outcome: "continued" });
    expect(claude.argvs()).toEqual([["agents", "--json", "--all"], ["--resume", SID, "--bg", CONTINUE_PROMPT]]);
  });

  it("sends nothing while Claude Code still lists the process after the stop", async () => {
    const claude = fakeClaude([blocked()], { stopSticks: true });
    const { c } = continuer({ claude, evidence: after(5_000) });
    expect(await c.press(SID, { kind: "login", at: T0 })).toEqual({ ok: false, reason: "still_running" });
    expect(claude.argvs().some(a => a[0] === "--resume")).toBe(false);
  });

  it("says when Claude Code started a copy rather than continuing in place", async () => {
    const claude = fakeClaude([blocked({ pid: undefined, status: undefined })], { resumeOut: "backgrounded · 9a8b7c6d\nnote: started a copy because the session is open in another terminal\n" });
    const { c } = continuer({ claude, evidence: after(5_000) });
    expect(await c.press(SID, { kind: "login", at: T0 })).toEqual({ ok: true, outcome: "copied", detail: "started a copy because the session is open in another terminal" });
  });

  it("captures what failed, and says the deck stopped the session before a resume that failed", async () => {
    const stopFails = fakeClaude([blocked()], { stopCode: 1 });
    expect(await continuer({ claude: stopFails, evidence: after(5_000) }).c.press(SID, { kind: "login", at: T0 }))
      .toEqual({ ok: false, reason: "stop_failed", detail: "stop: no such session" });
    expect(stopFails.argvs().some(a => a[0] === "--resume")).toBe(false);

    const resumeFails = fakeClaude([blocked()], { resumeCode: 1 });
    expect(await continuer({ claude: resumeFails, evidence: after(5_000) }).c.press(SID, { kind: "login", at: T0 }))
      .toEqual({ ok: false, reason: "resume_failed", detail: "Workspace not trusted", stopped: true });

    const agentsFails = fakeClaude([blocked()], { agentsCode: 2 });
    expect(await continuer({ claude: agentsFails, evidence: after(5_000) }).c.press(SID, { kind: "login", at: T0 }))
      .toEqual({ ok: false, reason: "cli_failed", detail: "agents: boom" });
    expect(agentsFails.argvs()).toEqual([["agents", "--json", "--all"]]);
  });

  it("never touches an interactive session, a busy one or one whose folder is gone", async () => {
    for (const [entry, reason] of [
      [{ kind: "interactive", sessionId: SID, cwd: CWD, startedAt: 1, pid: 1, status: "idle" }, "interactive"],
      [blocked({ status: "busy" }), "working"],
      [blocked({ cwd: join(DIR, "gone") }), "no_dir"],
    ] as const) {
      const claude = fakeClaude([entry as Entry]);
      const { c } = continuer({ claude, evidence: after(5_000) });
      expect(await c.press(SID, { kind: "login", at: T0 })).toEqual({ ok: false, reason });
      expect(claude.argvs(), reason).toEqual([["agents", "--json", "--all"]]);
    }
  });

  it("runs nothing at all before a working login is read after the stop", async () => {
    const claude = fakeClaude([blocked()]);
    const { c, state } = continuer({ claude, evidence: { ok: true, at: T0 - 1, room: true } });
    c.noteEvent(stopEvent(), T0);
    expect(await c.press(SID, { kind: "login", at: T0 })).toEqual({ ok: false, reason: "not_ready", gate: "before-stop" });
    state.evidence = { ok: true, at: T0 + 1, room: false };
    expect(await c.press(SID, { kind: "usage-limit", at: T0 })).toEqual({ ok: false, reason: "not_ready", gate: "no-room" });
    expect(claude.calls).toEqual([]);
  });

  it("refuses a body that does not name a session and a stop", async () => {
    const claude = fakeClaude([blocked()]);
    const { c } = continuer({ claude, evidence: after(5_000) });
    expect(await c.press("--all", { kind: "login", at: T0 })).toEqual({ ok: false, reason: "bad_request" });
    expect(await c.press(SID, null)).toEqual({ ok: false, reason: "bad_request" });
    expect(await c.press(SID, { kind: "constructor", at: T0 })).toEqual({ ok: false, reason: "bad_request" });
    expect(claude.calls).toEqual([]);
  });

  it("runs one continue at a time for a session", async () => {
    const claude = fakeClaude([blocked({ pid: undefined, status: undefined })]);
    const { c } = continuer({ claude, evidence: after(5_000) });
    const [a, b] = await Promise.all([c.press(SID, { kind: "login", at: T0 }), c.press(SID, { kind: "login", at: T0 })]);
    expect([a.reason ?? a.outcome, b.reason ?? b.outcome].sort()).toEqual(["busy", "continued"]);
    expect(claude.argvs().filter(x => x[0] === "--resume")).toHaveLength(1);
  });
});

describe("the stop the server keeps, and what takes it down", () => {
  it("is taken down by the session working again, and not by a subagent's call", () => {
    const { c } = continuer({ claude: fakeClaude([]) });
    c.noteEvent(stopEvent(), T0);
    c.noteEvent({ hook_event_name: "PreToolUse", session_id: SID, agent_id: "a1", tool_name: "Bash" }, T0 + 1);
    expect(c.records().get(SID)!.stop).toMatchObject({ kind: "login", at: T0 });
    for (const name of ["PreToolUse", "UserPromptSubmit", "Stop", "SessionStart"]) {
      c.noteEvent(stopEvent(), T0);
      c.noteEvent({ hook_event_name: name, session_id: SID, prompt: "go on" }, T0 + 1);
      expect(c.records().get(SID)!.stop, name).toBeNull();
    }
    // An event older than the stop is not the session moving on.
    c.noteEvent(stopEvent(), T0);
    c.noteEvent({ hook_event_name: "UserPromptSubmit", session_id: SID, prompt: "x" }, T0 - 1);
    expect(c.records().get(SID)!.stop).not.toBeNull();
  });

  it("keeps nothing for a post that is not a Claude Code session", () => {
    const { c } = continuer({ claude: fakeClaude([]) });
    c.noteEvent({ ...stopEvent(), session_id: "../../etc" }, T0);
    c.noteEvent({ ...stopEvent(), session_id: 7 }, T0);
    expect(c.records().size).toBe(0);
  });
});

describe("continuing automatically", () => {
  it("is off by default, and does nothing at all while it is", async () => {
    expect(DEFAULTS.continueStopped).toBe(false);
    expect(normalise({}).continueStopped).toBe(false);
    expect(normalise({ continueStopped: true }).continueStopped).toBe(true);
    expect(normalise({ continueStopped: "yes" }).continueStopped).toBe(false);
    const claude = fakeClaude([blocked()]);
    const { c, asked } = continuer({ claude, evidence: after(5_000), auto: false });
    c.noteEvent(stopEvent(), T0);
    await c.consider();
    expect(claude.calls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("waits for a working login newer than the stop, then continues each stop once", async () => {
    const claude = fakeClaude([blocked()]);
    const clock = { t: T0 };
    const { c, state } = continuer({ claude, evidence: { ok: true, at: T0 - 1, room: true }, auto: true, clock });
    c.noteEvent(stopEvent(), T0);
    await c.consider();
    expect(claude.calls).toEqual([]);
    state.evidence = after(30_000);
    clock.t = T0 + 31_000;
    await c.consider();
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toEqual([["--resume", SID, "--bg", CONTINUE_PROMPT]]);
    expect(c.records().get(SID)!.last).toMatchObject({ auto: true, ok: true, outcome: "continued", at: T0 + 31_000 });
  });

  it("never acts on an API error that is not about the login", async () => {
    const claude = fakeClaude([blocked()]);
    const { c } = continuer({ claude, evidence: after(5_000), auto: true });
    c.noteEvent(stopEvent(SID, "overloaded"), T0);
    await c.consider();
    expect(claude.calls).toEqual([]);
  });

  it("holds a session that stops again right after an automatic continue, until somebody acts on it", async () => {
    const entries = [blocked({ pid: undefined, status: undefined })];
    const claude = fakeClaude(entries);
    const clock = { t: T0 };
    const { c, state } = continuer({ claude, evidence: after(10_000), auto: true, clock });
    const resumes = () => claude.argvs().filter(a => a[0] === "--resume").length;

    c.noteEvent(stopEvent(), T0);
    clock.t = T0 + 20_000;
    await c.consider();
    expect(resumes()).toBe(1);

    // The deck's own continue arrives as the session's prompt: not somebody
    // acting on it. Then it stops again on the same dead login.
    c.noteEvent({ hook_event_name: "UserPromptSubmit", session_id: SID, prompt: CONTINUE_PROMPT }, T0 + 25_000);
    c.noteEvent(stopEvent(), T0 + 40_000);
    state.evidence = after(60_000);
    clock.t = T0 + 70_000;
    await c.consider();
    expect(resumes()).toBe(1);
    expect(c.records().get(SID)!.held).toBe(true);

    // Somebody typed into it: the next stop is the deck's to continue again.
    c.noteEvent({ hook_event_name: "UserPromptSubmit", session_id: SID, prompt: "try the other approach" }, T0 + 80_000);
    c.noteEvent(stopEvent(), T0 + 90_000);
    state.evidence = after(100_000);
    clock.t = T0 + 110_000;
    await c.consider();
    expect(resumes()).toBe(2);

    // And a stop long after the last automatic continue is a new incident.
    c.noteEvent({ hook_event_name: "UserPromptSubmit", session_id: SID, prompt: CONTINUE_PROMPT }, T0 + 120_000);
    const later = T0 + 110_000 + REPEAT_HOLD_MS + 1;
    c.noteEvent(stopEvent(), later);
    state.evidence = { ok: true, at: later + 1, room: true };
    clock.t = later + 2;
    await c.consider();
    expect(resumes()).toBe(3);
  });

  it("lifts the hold on a press of Continue", async () => {
    const claude = fakeClaude([blocked({ pid: undefined, status: undefined })]);
    const clock = { t: T0 + 20_000 };
    const { c, state } = continuer({ claude, evidence: after(10_000), auto: true, clock });
    c.noteEvent(stopEvent(), T0);
    await c.consider();
    c.noteEvent(stopEvent(), T0 + 40_000);
    expect(c.records().get(SID)!.held).toBe(true);
    state.evidence = after(50_000);
    clock.t = T0 + 60_000;
    expect(await c.press(SID, { kind: "login", at: T0 + 40_000 })).toEqual({ ok: true, outcome: "continued" });
    expect(c.records().get(SID)!.held).toBe(false);
  });

  it("leaves a stop somebody pressed Continue on to them, even when that press failed", async () => {
    const claude = fakeClaude([blocked({ pid: undefined, status: undefined })], { resumeCode: 1 });
    const { c } = continuer({ claude, evidence: after(10_000), auto: true, clock: { t: T0 + 20_000 } });
    c.noteEvent(stopEvent(), T0);
    expect(await c.press(SID, { kind: "login", at: T0 })).toMatchObject({ ok: false, reason: "resume_failed" });
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(1);
  });

  it("caps how many it continues in a window, and carries on with the rest after it", async () => {
    const ids = Array.from({ length: AUTO_CAP + 2 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const claude = fakeClaude(ids.map(sessionId => blocked({ sessionId, pid: undefined, status: undefined })));
    const clock = { t: T0 + 20_000 };
    const { c } = continuer({ claude, evidence: after(10_000), auto: true, clock });
    for (const sid of ids) c.noteEvent(stopEvent(sid), T0);
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(AUTO_CAP);
    clock.t += AUTO_WINDOW_MS;
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(AUTO_CAP + 2);
  });

  it("pauses after failures in a row, and tries none of them twice", async () => {
    const ids = Array.from({ length: FAIL_STREAK + 1 }, (_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`);
    const claude = fakeClaude(ids.map(sessionId => blocked({ sessionId, pid: undefined, status: undefined })), { resumeCode: 1 });
    const clock = { t: T0 + 20_000 };
    const { c } = continuer({ claude, evidence: after(10_000), auto: true, clock });
    for (const sid of ids) c.noteEvent(stopEvent(sid), T0);
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(FAIL_STREAK);
    expect(c.pausedUntil()).toBe(clock.t + FAIL_PAUSE_MS);
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(FAIL_STREAK);
    clock.t += FAIL_PAUSE_MS;
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(FAIL_STREAK + 1);
    await c.consider();
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(FAIL_STREAK + 1);
  });

  it("skips an interactive session, and looks a few times at one Claude Code does not call held up", async () => {
    const claude = fakeClaude([
      { kind: "interactive", sessionId: SID, cwd: CWD, startedAt: 1, pid: 1, status: "idle" },
      blocked({ sessionId: SID2, state: "done" }),
    ]);
    const { c } = continuer({ claude, evidence: after(10_000), auto: true, clock: { t: T0 + 20_000 } });
    c.noteEvent(stopEvent(SID), T0);
    c.noteEvent(stopEvent(SID2), T0);
    for (let i = 0; i < NOT_NOW_LOOKS + 3; i++) await c.consider();
    expect(claude.argvs().some(a => a[0] === "stop" || a[0] === "--resume")).toBe(false);
    expect(claude.argvs().filter(a => a[0] === "agents")).toHaveLength(1 + NOT_NOW_LOOKS);
    expect(c.records().get(SID)!.last).toBeNull();
  });

  it("leaves a stop older than Claude Code's own six hours", async () => {
    const claude = fakeClaude([blocked()]);
    const late = T0 + STOP_KEEP_MS + 1;
    const { c } = continuer({ claude, evidence: { ok: true, at: late, room: true }, auto: true, clock: { t: late + 1 } });
    c.noteEvent(stopEvent(), T0);
    await c.consider();
    expect(claude.calls).toEqual([]);
  });

  it("asks for a fresh reading after a tick that switched the account", async () => {
    const claude = fakeClaude([blocked({ pid: undefined, status: undefined })]);
    const { c, asked } = continuer({ claude, evidence: after(10_000), auto: true, clock: { t: T0 + 20_000 } });
    c.noteEvent(stopEvent(), T0);
    c.noteTick({ switched: true });
    await new Promise(r => setTimeout(r, 0));
    expect(asked[0]).toEqual({ force: true });
    expect(claude.argvs().filter(a => a[0] === "--resume")).toHaveLength(1);
  });
});

describe("GET and POST /api/stop-continue", () => {
  /** A response the handlers can write to. */
  function response() {
    const r = { status: 0, body: null as unknown, headersSent: false,
      writeHead(s: number) { r.status = s; r.headersSent = true; return r; },
      end(b: string) { r.body = JSON.parse(b); } };
    return r;
  }
  const request = (url: string, body = "") => Object.assign(Readable.from([body]), { url, headers: {} });

  it("says what the server keeps for a stop a hook posted, without the evidence unless asked", async () => {
    noteStopContinue(stopEvent("3b2e4f1c-8f2d-4e33-9b51-4c99e3fa0ad7"), T0);
    const res = response();
    await handleStopContinueRead(request("/api/stop-continue") as never, res as never);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, auto: false, login: null,
      sessions: { "3b2e4f1c-8f2d-4e33-9b51-4c99e3fa0ad7": { stop: { kind: "login", at: T0 }, held: false, tried: false, last: null } },
    });
  });

  it("answers a body it cannot use with 400 and runs nothing", async () => {
    for (const body of ["", "nope", JSON.stringify({ sessionId: "-h", stop: { kind: "login", at: T0 } }), JSON.stringify({ sessionId: SID })]) {
      const res = response();
      await handleStopContinue(request("/api/stop-continue", body) as never, res as never);
      expect(res.status, body).toBe(400);
      expect(res.body).toEqual({ ok: false, reason: "bad_request" });
    }
    expect(spawned).toEqual([]);
  });
});

describe("the wiring", () => {
  const src = (p: string) => readFileSync(new URL(`../../server/${p}`, import.meta.url), "utf8");

  it("hears only a hook's own live post, the way the early tick does", () => {
    expect(src("event-pipeline.mjs")).toMatch(/if \(source === "hook" && !opts\.replay\) \{\n\s*noteHookStop\(raw, evt\.receivedAt\);\n\s*noteStopContinue\(raw, evt\.receivedAt\);/);
  });

  it("is told about every auto-switch tick", () => {
    expect(src("cswap-auto-loop.mjs")).toMatch(/noteAutoTick\(_lastTick, \{ startedAt \}\); noteContinueTick\(_lastTick\);/);
  });

  it("guards the read like the quota it carries", () => {
    expect(src("request-gates.mjs")).toMatch(/"\/api\/stop-continue",/);
  });
});
