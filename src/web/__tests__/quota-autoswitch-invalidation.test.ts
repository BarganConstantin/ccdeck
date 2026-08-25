// The auto-switch tick moves the user's live Claude account, and for a long
// time it told nobody.
//
// `cswap auto --once` is the real engine, not a rehearsal: claude-accounts.mjs
// passes `--dry-run` on the path that must only look, and the deck-managed tick
// deliberately does not, because its whole job is to move the account when it
// crosses the threshold — 90% by default. What it did afterwards was write the
// outcome into `_lastTick` and return. Two module-level caches were left holding
// numbers that belonged to the account the deck had just left, and they decay at
// very different rates, which is what made the result look like a bug in the
// switch rather than in the caching:
//
//   - claude-accounts.mjs caches its roster for CACHE_MS = 5s, so the accounts
//     panel flipped to the new account almost immediately;
//   - quota.mjs caches its result for a CACHE_MS of its own = 60s, so the big
//     usage bars went on showing the abandoned account's percentages for up to a
//     minute — pinned at the 90%+ that caused the switch in the first place;
//   - and `_lastGood` outlives even that. Both of _doFetch's fallbacks hand it
//     straight back, re-cached for five seconds at a time, so once the result
//     cache expires with nothing collected for the NEW account yet, the panel
//     prints the previous account's numbers under a `stale` label — which is
//     worse than an empty panel, because the label vouches for them as this
//     account's, merely old.
//
// So two panels on one screen described two different accounts at the exact
// moment the user was most likely to be looking, and the one that was wrong was
// the one with the big bars. It reads as "the auto-switch did not work".
//
// The second half is subtler and is not specific to the auto path: invalidating
// could be undone by a fetch that was already running. `_doFetch` writes `_cache`
// and `_lastGood` AFTER its awaits — a store read, a 15s HTTPS call, up to three
// `claude --print /usage` spawns — and clearing three variables does nothing to a
// function that is mid-flight and still holds the previous account's answer in a
// local. A switch landing inside that window was followed by the pre-switch
// reading being written back over the cleared cache, so the invalidation worked
// and was undone before anything could observe it. The window is not theoretical:
// the usage panel forces a fetch on mount, and a forced fetch goes through
// nudgeAndReread, which sleeps REREAD_TRIES * REREAD_GAP_MS = 2.4 seconds by
// construction — comfortably longer than a `cswap switch`.
//
// This file drives the real functions rather than reading anyone's source. The
// tick is provoked through setAutoEnabled(), the caches are the real ones in
// quota.mjs and claude-accounts.mjs, and the store they read is a real
// claude-swap store written into a temp directory. The two "nothing was
// invalidated" assertions are stated as `toBe(previous)` — object identity —
// because returning the very same object is what serving from a cache means
// here, and it says so without depending on how long the assertions took.
//
// Nothing here runs a subprocess, touches the network, or goes anywhere near the
// user's real credentials: exec.mjs is replaced wholesale, so no `cswap`, no
// `claude`, no `ps` and no PowerShell can be reached by any route, and HOME,
// USERPROFILE, CLAUDE_CONFIG_DIR and CLAUDE_SWAP_BACKUP all point inside a temp
// directory that is checked before the modules are imported and removed after.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-autoswitch-cache-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
// cswap-auto.mjs keeps its enabled flag under the home directory, and homedir()
// reads HOME on POSIX and USERPROFILE on Windows — both are set above, so this
// holds on all three platforms. Stop before the import if it does not.
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

// Every child process this file could otherwise start, refused and answered by
// hand: `cswap --version` (binary discovery), `cswap config` (the tick
// interval), `cswap auto --once --json` (the engine itself), `ps` /
// Get-CimInstance (the external-loop probe) and `claude --print /usage` (the
// quota module's last-resort source, held open on demand so a switch can be made
// to land in the middle of one).
const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    engine: "",                                    // what `cswap auto --once` prints
    usage: "",                                     // what `claude --print /usage` prints
    holdUsage: false,
    releaseUsage: null as null | (() => void),
    usageStarted: null as null | (() => void),
  },
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    if (args[0] === "auto")   return { ...okay, stdout: proc.engine };
    if (args[0] === "config") return okay;                 // no settings; the interval defaults
    if (args[0] === "--print") {
      proc.usageStarted?.();
      if (proc.holdUsage) await new Promise<void>(r => { proc.releaseUsage = r; });
      return { ...okay, stdout: proc.usage };
    }
    return okay;   // --version, ps, powershell: present, and saying nothing
  },
  runDetached: () => {},
  // quotaClaudeBin asks PATH whether a bare `claude` is really there before it
  // falls back to the install directories it knows, and the answer must not
  // depend on what the machine running the suite happens to have installed.
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

type Quota = {
  ok: boolean;
  fetchedAt: number;
  reason?: string;
  source?: string;
  stale?: boolean;
  session5hPct?: number;
};
type Roster = { ok: boolean; activeNum?: number | null };

const ROOT = join(DIR, "cswap");
const MIN = 60_000;

/** One account, as claude-swap's sequence.json and usage.json describe it. */
const account = (num: number) => ({ email: `account-${num}@b.c`, organizationUuid: `org-${num}` });

/**
 * Write a real claude-swap store: two accounts, one of them active, each with a
 * row collected a minute ago — inside STORE_TRUSTED_MS, so quota.mjs serves it
 * and remembers it as the last known good reading.
 */
function writeStore(activeNum: number, pct: Record<number, number>) {
  mkdirSync(join(ROOT, "cache"), { recursive: true });
  const nums = Object.keys(pct).map(Number);
  writeFileSync(join(ROOT, "sequence.json"), JSON.stringify({
    activeAccountNumber: activeNum,
    sequence: nums.map(String),
    accounts: Object.fromEntries(nums.map(n => [String(n), account(n)])),
  }));
  writeFileSync(join(ROOT, "cache", "usage.json"), JSON.stringify({
    schemaVersion: 2,
    accounts: Object.fromEntries(nums.map(n => [String(n), {
      ...account(n),
      fetchedAt: (Date.now() - MIN) / 1000,          // claude-swap stores seconds
      lastGood: {
        five_hour: { pct: pct[n], resets_at: "2026-08-25T18:00:00Z" },
        seven_day: { pct: Math.round(pct[n] / 3), resets_at: "2026-08-30T04:00:00Z" },
      },
    }])),
  }));
}

/** No store at all, so quota.mjs has to fall through to the CLI. */
function clearStore() {
  rmSync(ROOT, { recursive: true, force: true });
}

/** What `claude --print /usage` prints when it can answer. */
const usageText = (pct: number) => [
  "Claude Code usage",
  "Current subscription: Max",
  `Current session: ${pct}% used · resets Aug 25, 6:00pm`,
  `Current week (all models): ${Math.round(pct / 3)}% used · resets Aug 30, 4:00am`,
].join("\n");

type QuotaModule = {
  fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota>;
  invalidateQuotaCache: () => void;
};
type AccountsModule = { fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<Roster> };
type AutoModule = {
  setAutoEnabled: (on: boolean) => Promise<unknown>;
  autoStatus: () => Promise<{ lastTick: { event: string; switched?: boolean } | null }>;
};

let quota: QuotaModule;
let accounts: AccountsModule;
let auto: AutoModule;

const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Run exactly one deck-managed tick and wait for it to be over.
 *
 * setAutoEnabled(true) installs the interval and fires the first tick without
 * awaiting it, so the finish line has to be observed rather than awaited. It is
 * `_lastTick` being replaced — a fresh object per tick, which is what identity
 * compares here — and the tick writes it AFTER any invalidation, so seeing a new
 * one is proof the caches have already been dealt with. The interval floor is
 * 15s and the loop is switched off again immediately, so exactly one tick runs.
 */
async function tickOnce(engineOutput: string) {
  proc.engine = engineOutput;
  const before = (await auto.autoStatus()).lastTick;
  await auto.setAutoEnabled(true);
  for (let i = 0; i < 400 && (await auto.autoStatus()).lastTick === before; i++) await rest(5);
  await auto.setAutoEnabled(false);
  const tick = (await auto.autoStatus()).lastTick;
  expect(tick, "the tick never completed").not.toBe(before);
  return tick!;
}

// The engine's own JSON, one event per line, as `cswap auto --once --json`
// writes it: a poll event and then whatever it decided.
const SWITCHED = [
  JSON.stringify({ event: "poll", active: { number: "2" }, threshold: 90, headroomPct: 4 }),
  JSON.stringify({ event: "switch", trigger: "proactive", from: { number: "2" }, to: { number: "3" }, warnings: [], dryRun: false }),
].join("\n");

const DID_NOTHING = [
  JSON.stringify({ event: "poll", active: { number: "2" }, threshold: 90, headroomPct: 37 }),
  JSON.stringify({ event: "no-switch", reason: "cooldown", detail: "" }),
].join("\n");

beforeEach(async () => {
  proc.calls.length = 0;
  proc.engine = "";
  proc.usage = "";
  proc.holdUsage = false;
  proc.releaseUsage = null;
  proc.usageStarted = null;
  clearStore();
  // A fresh copy of all three modules per test: the result cache, the last known
  // good reading, the self-poll floor, the roster cache and the loop's own state
  // are every one of them module-level. cswap-auto.mjs imports the other two, so
  // importing all three in one reset generation hands the tick the same cache
  // instances these assertions read.
  vi.resetModules();
  quota    = await import("../../server/quota.mjs") as unknown as QuotaModule;
  accounts = await import("../../server/claude-accounts.mjs") as unknown as AccountsModule;
  auto     = await import("../../server/cswap-auto.mjs") as unknown as AutoModule;
});

afterEach(async () => {
  proc.releaseUsage?.();
  await auto.setAutoEnabled(false);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

describe("a tick that moved the live Claude account", () => {
  it("drops the usage reading and the roster it just made wrong", async () => {
    writeStore(2, { 2: 91, 3: 7 });
    const bars   = await quota.fetchClaudeQuota();
    const roster = await accounts.fetchClaudeAccounts();
    expect(bars).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 91 });
    expect(roster).toMatchObject({ ok: true, activeNum: 2 });

    // The engine crosses the threshold and moves the machine onto account 3.
    // claude-swap's store says so; nothing has told either cache.
    writeStore(3, { 2: 91, 3: 7 });
    const tick = await tickOnce(SWITCHED);
    expect(tick.event).toBe("switch");

    // Both panels now describe the account the deck is actually on. Without the
    // invalidation the bars would still read 91% — the number that CAUSED the
    // switch — for the rest of quota.mjs's minute.
    expect(await quota.fetchClaudeQuota(),
           "the usage bars still describe the account the tick just left")
      .toMatchObject({ ok: true, session5hPct: 7 });
    expect(await accounts.fetchClaudeAccounts(),
           "the roster still describes the account the tick just left")
      .toMatchObject({ ok: true, activeNum: 3 });
  });
});

describe("a tick that decided to do nothing", () => {
  it("keeps both caches, because nothing it holds became wrong", async () => {
    writeStore(2, { 2: 44 });
    const bars   = await quota.fetchClaudeQuota();
    const roster = await accounts.fetchClaudeAccounts();

    const tick = await tickOnce(DID_NOTHING);
    expect(tick.event).toBe("no-switch");

    // The same objects, which is what "served from cache" means. Most ticks are
    // a poll that decides nothing — cooldown, no candidates, nobody near the
    // threshold — and invalidating on those would throw away a reading that cost
    // claude-swap a request and the deck a subprocess, once per interval,
    // forever.
    expect(await quota.fetchClaudeQuota()).toBe(bars);
    expect(await accounts.fetchClaudeAccounts()).toBe(roster);
  });
});

describe("a switch that lands while a quota fetch is already running", () => {
  /**
   * Start a fetch that cannot finish, let the tick switch underneath it, then
   * let it finish. The store is empty, so the fetch falls all the way through to
   * `claude --print /usage`, which is held open — the same shape as the real
   * window, where the slow part is a nudge-and-reread or a CLI cold start rather
   * than anything this file can schedule.
   */
  async function switchMidFetch() {
    proc.holdUsage = true;
    proc.usage = usageText(88);                    // the account being left, at 88%
    const started = new Promise<void>(r => { proc.usageStarted = r; });
    const inflight = quota.fetchClaudeQuota();
    await started;

    const tick = await tickOnce(SWITCHED);
    expect(tick.event).toBe("switch");

    proc.holdUsage = false;
    proc.releaseUsage?.();
    return inflight;
  }

  it("still answers the caller who asked for it, since the reading is real", async () => {
    const landed = await switchMidFetch();
    // Not cancelled. Whoever asked is owed an answer and this one is not wrong —
    // it is simply about an account that is no longer active, which makes it a
    // fine return value and a bad cached one.
    expect(landed).toMatchObject({ ok: true, source: "cli", session5hPct: 88 });
  });

  it("does not let that reading become the cache the next poll is served from", async () => {
    await switchMidFetch();
    // claude-swap collects for the account the deck moved to.
    writeStore(3, { 3: 6 });

    // Before the generation guard, `_cache` held the 88% written after the
    // invalidation, and this call — inside CACHE_MS — was answered from it.
    expect(await quota.fetchClaudeQuota(),
           "a fetch that started before the switch wrote its answer back over the cleared cache")
      .toMatchObject({ ok: true, session5hPct: 6 });
  });

  it("does not let it become `_lastGood` either, which is the longer tail", async () => {
    await switchMidFetch();

    // Nothing has been collected for the new account, and the self-poll floor
    // has just been spent, so this lands in the fallback that serves whatever is
    // still held. Held is where `_lastGood` does its damage: it outlives the
    // result cache and comes back under a `stale` label, which vouches for the
    // previous account's percentages as this one's.
    const after = await quota.fetchClaudeQuota({ force: true });

    expect(after, "the account the deck left came back as this one's, under a `stale` label")
      .toMatchObject({ ok: false, reason: "waiting" });
    expect(after.session5hPct).toBeUndefined();
    expect(after.stale).toBeUndefined();
  });
});
