// #2185 with the auto-switch rules released since (#2200 to #2208): the early
// tick a stopped session asks for is the interval's own tick, so it runs the
// home and "soonest weekly reset" rules first, keeps their cooldown, and still
// lets claude-swap's engine leave an exhausted or failed account inside it.
//
// stop-failure-early-tick-2185.test.ts pins when the early tick runs. This file
// pins what it does once it runs, with a rule set: the store as files, the
// engine's dry run and real run told apart, and the one notification.
//
// Nothing spawns: exec.mjs is replaced, and `cswap switch` and the engine's
// real run write the store the way the real ones do. HOME, the deck's data and
// the store all point inside one temp directory checked before anything is
// imported. The store holds fake @example.test accounts and no credential.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-early-tick-rules-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME", "AGENTS_DECK_NO_LAN"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME"] as const) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const ROOT = join(DIR, "cswap");
const H = 3600_000;

const { proc } = vi.hoisted(() => ({
  proc: { calls: [] as string[][], engineTarget: null as number | null, engineTrigger: "proactive" },
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    const { readFileSync: read, writeFileSync: write } = await import("node:fs");
    const { join: j } = await import("node:path");
    const moveTo = (num: number) => {
      const path = j(process.env.CLAUDE_SWAP_BACKUP!, "sequence.json");
      const seq = JSON.parse(read(path, "utf8"));
      seq.activeAccountNumber = num;
      write(path, JSON.stringify(seq));
    };
    if (args[0] === "config") {
      return { ...okay, stdout: [
        "autoswitch.threshold          90      (default)",
        "autoswitch.intervalSeconds    60      (default)",
        "autoswitch.cooldownSeconds    300     (default)",
        "autoswitch.strategy           best    (default)",
        "autoswitch.model              (none)  (default)",
      ].join("\n") };
    }
    if (args[0] === "switch") { moveTo(Number(args[1])); return okay; }
    if (args[0] === "auto") {
      if (proc.engineTarget == null) {
        return { ...okay, code: 2, ok: false, stdout: JSON.stringify({ event: "no-switch", reason: "below-threshold" }) };
      }
      const dryRun = args.includes("--dry-run");
      if (!dryRun) moveTo(proc.engineTarget);
      return { ...okay, stdout: JSON.stringify({ event: "switch", trigger: proc.engineTrigger, dryRun, to: { number: proc.engineTarget } }) };
    }
    return okay;
  },
  runDetached: () => {},
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

vi.mock("../../server/lan-deck.mjs", () => ({
  lanEngine: { status: () => ({ peers: [] }) },
}));

const account = (num: number) => ({ email: `account-${num}@example.test`, organizationUuid: `org-${num}` });

/** A store with `activeNum` live: per account its 5-hour percentage and the
 *  hours to its weekly reset, every row read a minute ago. */
function writeStore(activeNum: number, rows: Record<number, { five: number; weekIn: number }>) {
  const at = Date.now();
  mkdirSync(join(ROOT, "cache"), { recursive: true });
  const nums = Object.keys(rows).map(Number);
  writeFileSync(join(ROOT, "sequence.json"), JSON.stringify({
    activeAccountNumber: activeNum,
    sequence: nums.map(String),
    accounts: Object.fromEntries(nums.map(n => [String(n), account(n)])),
  }));
  writeFileSync(join(ROOT, "cache", "usage.json"), JSON.stringify({
    schemaVersion: 2,
    accounts: Object.fromEntries(nums.map(n => [String(n), {
      ...account(n),
      fetchedAt: (at - 60_000) / 1000,
      lastGood: {
        five_hour: { pct: rows[n].five, resets_at: new Date(at + 3 * H).toISOString() },
        seven_day: { pct: 10, resets_at: new Date(at + rows[n].weekIn * H).toISOString() },
      },
    }])),
  }));
}

const activeInStore = () => JSON.parse(readFileSync(join(ROOT, "sequence.json"), "utf8")).activeAccountNumber;
const realRuns = () => proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run")).length;
const autoRuns = () => proc.calls.filter(c => c[1] === "auto").length;
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: () => boolean, ms = 5_000) {
  for (const end = Date.now() + ms; Date.now() < end && !what();) await rest(10);
  return what();
}

type Tick = { at: number; event: string; switched?: boolean; trigger?: string | null; reason?: string | null } | null;
type Auto = {
  setAutoEnabled: (on: boolean) => Promise<unknown>;
  autoStatus: () => Promise<{ lastTick: Tick }>;
  setNextChoice: (v: unknown) => Promise<{ ok: boolean }>;
  invalidateCswapAutoCache: () => void;
};
type Watch = typeof import("../../server/account-watch.mjs");
type Choice = typeof import("../../server/cswap-auto-choice.mjs");
type Accounts = { invalidateClaudeAccountsCache: () => void };

let auto: Auto;
let watch: Watch;
let choice: Choice;
let accounts: Accounts;
let said: { title: string; body: string }[] = [];

/** A StopFailure as hook.js posts it. */
const stopFailure = (sessionId: string, error: string) => ({
  hook_event_name: "StopFailure", provider: "claude", session_id: sessionId, cwd: "/work/vcrm-core",
  transcript_path: `${DIR}/claude/projects/x/${sessionId}.jsonl`, error,
});

/** The loop on, and the tick an enable runs at once over, having moved nothing. */
async function loopOnQuiet() {
  accounts.invalidateClaudeAccountsCache();
  await auto.setAutoEnabled(true);
  let first: Tick = null;
  for (let i = 0; i < 500 && !(first = (await auto.autoStatus()).lastTick); i++) await rest(10);
  expect(first, "the enable's own tick did not finish").not.toBeNull();
  expect(autoRuns() + proc.calls.filter(c => c[1] === "switch").length).toBeGreaterThan(0);
  await rest(100);
  return first;
}
/** The early tick's own answer: the first lastTick after `before`. */
async function nextTick(before: Tick) {
  for (let i = 0; i < 500; i++) {
    const t = (await auto.autoStatus()).lastTick;
    if (t && t !== before && t.at !== before?.at) return t;
    await rest(10);
  }
  return null;
}

beforeEach(async () => {
  Object.assign(proc, { calls: [], engineTarget: null, engineTrigger: "proactive" });
  const box: typeof said = [];
  said = box;
  rmTempDir(ROOT);
  rmTempDir(join(DIR, "deck"));
  vi.resetModules();
  watch = await import("../../server/account-watch.mjs");
  watch.connectAccountNotify({
    notify: (title: string, body: string) => { box.push({ title, body }); },
    settings: () => ({ swap: true, quota: false, reset: false, stopped: true }), product: "ccdeck", onError: () => {},
  });
  auto = await import("../../server/cswap-auto.mjs") as unknown as Auto;
  choice = await import("../../server/cswap-auto-choice.mjs");
  accounts = await import("../../server/claude-accounts.mjs") as unknown as Accounts;
  auto.invalidateCswapAutoCache();
});

afterEach(async () => {
  await auto.setAutoEnabled(false);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

/** "Soonest weekly reset" on, and a move the deck made a moment ago, so its
 *  cooldown runs; then the person switched back by hand to account 1, which
 *  is under the threshold, so no rule moves it again. */
async function insideTheDeckCooldown() {
  const rows = { 1: { five: 95, weekIn: 16 }, 14: { five: 0, weekIn: 100 }, 15: { five: 40, weekIn: 82 } };
  writeStore(1, rows);
  await auto.setNextChoice("weekly");
  expect((await choice.chooseBeforeEngine()).result?.to?.number).toBe(15);
  writeStore(1, { ...rows, 1: { five: 20, weekIn: 16 } });
  proc.calls.length = 0;
}

describe("an early tick inside the deck's cooldown", () => {
  it.each(["at-limit", "failover"])("still lets the engine leave the account on %s", async trigger => {
    await insideTheDeckCooldown();
    const before = await loopOnQuiet();
    expect(before).toMatchObject({ switched: false, reason: "cooldown" });
    expect(realRuns()).toBe(0);
    // The login died, or the limit was reached: the engine now says leave.
    proc.engineTarget = 14;
    proc.engineTrigger = trigger;
    watch.noteHookStop(stopFailure("s-1", trigger === "at-limit" ? "rate_limit" : "authentication_failed"));
    const early = await nextTick(before);
    expect(early).toMatchObject({ switched: true, trigger });
    expect(activeInStore()).toBe(14);
    expect(realRuns()).toBe(1);
    expect(await until(() => said.length > 0)).toBe(true);
    await rest(100);
    expect(said).toEqual([{
      title: "Claude auto-switch — ccdeck",
      body: expect.stringMatching(/ · 1 session stopped, type “continue” in it$/),
    }]);
  });

  it("keeps the cooldown for a move the engine would only make by choice", async () => {
    await insideTheDeckCooldown();
    const before = await loopOnQuiet();
    proc.engineTarget = 14;
    proc.engineTrigger = "proactive";
    watch.noteHookStop(stopFailure("s-1", "authentication_failed"));
    const early = await nextTick(before);
    expect(early).toMatchObject({ switched: false, reason: "cooldown" });
    expect(activeInStore()).toBe(1);
    expect(realRuns()).toBe(0);
    // No switch is coming, so the stopped sessions are said on their own.
    expect(await until(() => said.length > 0)).toBe(true);
    await rest(100);
    expect(said).toEqual([{
      title: "1 Claude session stopped — ccdeck",
      body: "Login expired · vcrm-core. Type “continue” in it once a working login is active.",
    }]);
  });
});

describe("an early tick with a rule set", () => {
  it("moves by the rule before the engine is asked, as the interval's tick does", async () => {
    writeStore(1, { 1: { five: 20, weekIn: 16 }, 14: { five: 0, weekIn: 100 }, 15: { five: 40, weekIn: 82 } });
    await auto.setNextChoice("weekly");
    const before = await loopOnQuiet();
    expect(before).toMatchObject({ switched: false });
    expect(activeInStore()).toBe(1);
    // The account in use reached its limit: the weekly rule takes the
    // soonest reset with room, and the engine would have taken most room.
    writeStore(1, { 1: { five: 100, weekIn: 16 }, 14: { five: 0, weekIn: 100 }, 15: { five: 40, weekIn: 82 } });
    accounts.invalidateClaudeAccountsCache();
    proc.engineTarget = 14;
    proc.engineTrigger = "at-limit";
    proc.calls.length = 0;
    watch.noteHookStop(stopFailure("s-1", "rate_limit"));
    const early = await nextTick(before);
    expect(early).toMatchObject({ switched: true, trigger: "weekly-reset" });
    expect(activeInStore()).toBe(15);
    expect(proc.calls.filter(c => c[1] === "switch").map(c => c[2])).toEqual(["15"]);
    expect(realRuns()).toBe(0);
  });
});
