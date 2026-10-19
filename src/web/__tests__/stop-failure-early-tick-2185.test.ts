// #2185: a session that stopped on a dead login asks auto-switch for a tick now.
//
// A tick is `cswap auto --once`, which moves the user's live Claude account, so
// the early one has rules of its own and this file holds them: ten sessions
// stopping in one second are one tick, never one beside a tick already
// running, none at all with the loop off, and none again within SOON_GAP_MS —
// the stops arrive on `POST /api/event`, which takes a post without the deck's
// token. Then the whole way through: StopFailure in, one tick, and one
// notification that says the switch and the stopped sessions together.
//
// Nothing spawns and nothing reaches the network: exec.mjs is replaced, and
// HOME, the deck's data, the Claude config and claude-swap's store all point
// inside one temp directory, checked before anything is imported. The store
// holds two fake @example.test accounts and no credential.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-early-tick-"));
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

const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    engine: "",
    held: false,
    release: [] as (() => void)[],
    running: 0,
    most: 0,
  },
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    if (args[0] === "auto") {
      proc.running++;
      proc.most = Math.max(proc.most, proc.running);
      try {
        if (proc.held) await new Promise<void>(r => { proc.release.push(r); });
        return { ...okay, stdout: proc.engine };
      } finally {
        proc.running--;
      }
    }
    return okay;
  },
  runDetached: () => {},
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

const ROOT = join(DIR, "cswap");
const account = (num: number) => ({ email: `account-${num}@example.test`, organizationUuid: `org-${num}` });

/** claude-swap's roster: two fake accounts, `activeNum` live. */
function writeStore(activeNum: number) {
  mkdirSync(join(ROOT, "cache"), { recursive: true });
  writeFileSync(join(ROOT, "sequence.json"), JSON.stringify({
    activeAccountNumber: activeNum,
    sequence: ["2", "3"],
    accounts: { "2": account(2), "3": { ...account(3), alias: "work" } },
  }));
}

const POLL = JSON.stringify({ event: "poll", active: { number: 2, email: "account-2@example.test" }, threshold: 90, headroomPct: { "2": 60, "3": 80 }, windowsPct: { "2": { "5h": 40, "7d": 10 } } });
const NO_SWITCH = [POLL, JSON.stringify({ event: "no-switch", reason: "below-threshold" })].join("\n");
/** The engine moving off account 2, whose login died, onto account 3. */
const SWITCHED = [
  POLL,
  JSON.stringify({ event: "switch", trigger: "proactive", from: { number: 2, email: "account-2@example.test" }, to: { number: 3, email: "account-3@example.test" }, warnings: [], dryRun: false }),
].join("\n");

type Watch = typeof import("../../server/account-watch.mjs");
type Loop = { tickSoon: () => boolean; SOON_MS: number; SOON_GAP_MS: number };
type Auto = { setAutoEnabled: (on: boolean) => Promise<unknown>; invalidateCswapAutoCache: () => void };

let watch: Watch;
let loop: Loop;
let auto: Auto;
/** What was said in this case. Each case gets its own: an incident a case left
 *  gathering says itself seconds later, into the case that armed it. */
let said: { title: string; body: string }[] = [];
const settings = { swap: true, quota: false, reset: false, stopped: true };

const rest = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Every `cswap auto --once` this file has provoked. */
const ticks = () => proc.calls.filter(c => c[1] === "auto" && c[2] === "--once").length;
async function until(what: () => boolean, ms = 4_000) {
  for (const end = Date.now() + ms; Date.now() < end && !what();) await rest(10);
  return what();
}
/** The loop on, and its first tick (the one an enable runs at once) over. */
async function loopOn() {
  await auto.setAutoEnabled(true);
  expect(await until(() => ticks() === 1 && proc.running === 0), "the enable's own tick did not run").toBe(true);
  await rest(50);
}
/** A StopFailure as hook.js posts it, from a session in `cwd`. */
const stopFailure = (sessionId: string, cwd: string, error = "authentication_failed") => ({
  hook_event_name: "StopFailure", provider: "claude", session_id: sessionId, cwd,
  transcript_path: `${DIR}/claude/projects/x/${sessionId}.jsonl`,
  error, last_assistant_message: "Login expired · Please run /login",
});

beforeEach(async () => {
  Object.assign(proc, { calls: [], engine: NO_SWITCH, held: false, release: [], running: 0, most: 0 });
  const box: typeof said = [];
  said = box;
  Object.assign(settings, { swap: true, quota: false, reset: false, stopped: true });
  rmTempDir(ROOT);
  rmTempDir(join(DIR, "deck"));
  writeStore(2);
  // Fresh modules for each case: the early tick's gap is module state.
  vi.resetModules();
  watch = await import("../../server/account-watch.mjs");
  watch.connectAccountNotify({ notify: (title: string, body: string) => { box.push({ title, body }); }, settings: () => settings, product: "ccdeck", onError: () => {} });
  auto = await import("../../server/cswap-auto.mjs") as unknown as Auto;
  loop = await import("../../server/cswap-auto-loop.mjs") as unknown as Loop;
  auto.invalidateCswapAutoCache();
});

afterEach(async () => {
  for (const r of proc.release.splice(0)) r();
  proc.held = false;
  await auto.setAutoEnabled(false);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

describe("the early tick", () => {
  it("is one tick for a burst of stops", async () => {
    await loopOn();
    const armed = Array.from({ length: 10 }, () => loop.tickSoon());
    expect(armed).toEqual([true, ...Array(9).fill(false)]);
    await rest(200);
    expect(ticks(), "ran before the burst was over").toBe(1);
    expect(await until(() => ticks() === 2)).toBe(true);
    await rest(300);
    expect(ticks()).toBe(2);
  });

  it("is not asked for again inside the gap after one", async () => {
    await loopOn();
    expect(loop.tickSoon()).toBe(true);
    expect(await until(() => ticks() === 2)).toBe(true);
    expect(loop.tickSoon(), "a second early tick inside SOON_GAP_MS").toBe(false);
    // Past the gap it is: the clock moved on, nothing else did.
    const realNow = Date.now;
    const later = realNow() + loop.SOON_GAP_MS + 1;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    try {
      expect(loop.tickSoon()).toBe(true);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("never runs beside a tick that is already running, and runs after it", async () => {
    await loopOn();
    proc.held = true;
    // The interval's tick is what is in flight; restartLoop runs one at once.
    const { restartLoop } = await import("../../server/cswap-auto-loop.mjs") as unknown as { restartLoop: () => Promise<void> };
    await restartLoop();
    expect(await until(() => proc.running === 1)).toBe(true);
    expect(loop.tickSoon()).toBe(true);
    await rest(loop.SOON_MS + 300);
    expect(proc.running, "an early tick ran beside the one in flight").toBe(1);
    expect(ticks()).toBe(2);
    proc.held = false;
    for (const r of proc.release.splice(0)) r();
    // The tick in flight began before the stop, so it cannot answer for it:
    // the early one follows it.
    expect(await until(() => ticks() === 3)).toBe(true);
    expect(proc.most).toBe(1);
  });

  it("is nothing with the loop off", async () => {
    expect(loop.tickSoon()).toBe(false);
    watch.noteHookStop(stopFailure("s-1", "/work/vcrm-core"));
    await rest(loop.SOON_MS + 300);
    expect(ticks()).toBe(0);
  });
});

describe("a login that dies under three sessions", () => {
  it("is one tick, and one notification that says the switch and the stops", async () => {
    await loopOn();
    proc.engine = SWITCHED;
    // The engine switched: the store says so by the time the roster is read.
    watch.noteHookStop(stopFailure("s-1", "/work/vcrm-core"));
    watch.noteHookStop(stopFailure("s-2", "/work/api"));
    watch.noteHookStop(stopFailure("s-3", "/work/web"));
    writeStore(3);
    expect(await until(() => ticks() === 2)).toBe(true);
    expect(await until(() => said.length > 0)).toBe(true);
    await rest(200);
    expect(said).toEqual([{
      title: "Claude auto-switch — ccdeck",
      body: expect.stringMatching(/^Switched to work .* · 3 sessions stopped, type “continue” in each$/),
    }]);
    expect(ticks()).toBe(2);
  });

  it("is one notification on its own when the tick finds nothing to switch to", async () => {
    await loopOn();
    watch.noteHookStop(stopFailure("s-1", "/work/vcrm-core"));
    watch.noteHookStop(stopFailure("s-2", "/work/api", "rate_limit"));
    expect(await until(() => said.length > 0)).toBe(true);
    await rest(200);
    expect(said).toEqual([{
      title: "2 Claude sessions stopped — ccdeck",
      body: "Login expired or usage limit reached · vcrm-core and api. Type “continue” in each once a working account is active.",
    }]);
  });

  it("asks for nothing on an API error the account is not the cause of", async () => {
    await loopOn();
    watch.noteHookStop(stopFailure("s-1", "/work/vcrm-core", "server_error"));
    watch.noteHookStop({ hook_event_name: "Stop", session_id: "s-2", cwd: "/work/api" });
    await rest(loop.SOON_MS + 300);
    expect(ticks()).toBe(1);
    expect(said).toEqual([]);
  });
});
