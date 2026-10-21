// The home account and "soonest weekly reset" rules, wired into a real
// auto-switch tick: the loop, claude-swap's store as files, the notifier.
//
// account-choice.test.ts pins the rules. This file pins the doors around
// them: that with nothing set a tick is exactly the engine's, that a move the
// rules make is the tick (the engine is not run after it) and is announced
// like any other, that a switch made by hand is left alone, and that the
// engine running a strategy of its own turns the optional moves off.
//
// Nothing spawns: exec.mjs is replaced, and `cswap switch` writes the store
// the way the real one does. HOME, the deck's data and the store all point
// inside one temp directory checked before anything is imported.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-auto-choice-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME", "AGENTS_DECK_NO_LAN"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ["HOME", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME"] as const) if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}`);
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const ROOT = join(DIR, "cswap");
const H = 3600_000;

const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][], config: "",
    duringConfig: null as null | (() => Promise<unknown>),
    duringPoll: null as null | (() => unknown),
    engineTarget: null as number | null, engineTrigger: "proactive", pollTimeout: false,
    peers: [] as { paired: boolean; lastSeen?: number; offers?: { at?: number; current?: { key?: string } } }[],
  },
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    if (args[0] === "config") {
      // Something the panel does while a tick is reading the engine's
      // settings — the one await in the middle of a tick's decision.
      const during = proc.duringConfig;
      proc.duringConfig = null;
      if (during) await during();
      return { ...okay, stdout: proc.config };
    }
    if (args[0] === "switch") {
      // What `cswap switch N` leaves behind: the store names N as active.
      const { readFileSync: read, writeFileSync: write } = await import("node:fs");
      const { join: j } = await import("node:path");
      const path = j(process.env.CLAUDE_SWAP_BACKUP!, "sequence.json");
      const seq = JSON.parse(read(path, "utf8"));
      seq.activeAccountNumber = Number(args[1]);
      write(path, JSON.stringify(seq));
      return okay;
    }
    if (args[0] === "auto") {
      await proc.duringPoll?.();
      proc.duringPoll = null;
      if (proc.pollTimeout) return { ...okay, ok: false, timedOut: true, stdout: JSON.stringify({ event: "poll" }) };
      if (proc.engineTarget != null) {
        const dryRun = args.includes("--dry-run");
        if (!dryRun) {
          const { readFileSync: read, writeFileSync: write } = await import("node:fs");
          const { join: j } = await import("node:path");
          const path = j(process.env.CLAUDE_SWAP_BACKUP!, "sequence.json");
          const seq = JSON.parse(read(path, "utf8"));
          seq.activeAccountNumber = proc.engineTarget;
          write(path, JSON.stringify(seq));
        }
        return { ...okay, stdout: JSON.stringify({ event: "switch", trigger: proc.engineTrigger, dryRun, to: { number: proc.engineTarget } }) };
      }
      return { ...okay, code: 2, ok: false, stdout: JSON.stringify({ event: "no-switch", reason: "below-threshold" }) };
    }
    return okay;
  },
  runDetached: () => {},
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

vi.mock("../../server/lan-deck.mjs", () => ({
  lanEngine: { status: () => ({ peers: proc.peers }) },
}));

const CONFIG = (strategy = "best") => [
  "autoswitch.threshold          90      (default)",
  "autoswitch.intervalSeconds    60      (default)",
  "autoswitch.cooldownSeconds    300     (default)",
  `autoswitch.strategy           ${strategy}    ${strategy === "best" ? "(default)" : ""}`,
  "autoswitch.model              (none)  (default)",
].join("\n");

const account = (num: number) => ({ email: `account-${num}@b.c`, organizationUuid: `org-${num}` });

/** A store with `activeNum` live: per account its 5-hour percentage and the
 *  hours to its weekly reset, every row read a minute before `at`. */
function writeStore(activeNum: number, rows: Record<number, { five: number; weekIn: number; week?: number }>, at = Date.now()) {
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
        seven_day: { pct: rows[n].week ?? 10, resets_at: new Date(at + rows[n].weekIn * H).toISOString() },
      },
    }])),
  }));
}

/** claude-swap's own state file, as its engine writes it: when it last
 *  switched (unix seconds) and the slots it quarantined, each by email. */
function writeEngineState(state: { lastSwitchAt?: number; quarantine?: Record<string, { email: string }> }) {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "autoswitch_state.json"), JSON.stringify(state));
}

/** A `cswap run` session on account `num`: the record Claude Code writes for
 *  its process, in the profile claude-swap made for that account —
 *  `<store>/sessions/<slot>-<email, slugged>/sessions/<pid>.json`. */
function writeSession(num: number, pid: number) {
  const dir = join(ROOT, "sessions", `${num}-account-${num}_b.c`, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: "s", cwd: "/w", startedAt: Date.now() }));
}
/** A pid no process holds. */
const GONE_PID = 999_999_999;

const activeInStore = () => JSON.parse(readFileSync(join(ROOT, "sequence.json"), "utf8")).activeAccountNumber;
const engineRuns = () => proc.calls.filter(c => c[1] === "auto").length;
const switches = () => proc.calls.filter(c => c[1] === "switch").map(c => Number(c[2]));
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

type Tick = { event: string; switched?: boolean; trigger?: string | null; to?: { number: number } | null } | null;
type Auto = {
  setAutoEnabled: (on: boolean) => Promise<unknown>;
  autoStatus: () => Promise<{ lastTick: Tick; choice: { next: string; home: { email: string; orgUuid: string | null } | null } }>;
  setNextChoice: (v: unknown) => Promise<{ ok: boolean; reason?: string }>;
  setHomeAccount: (n: number | null) => Promise<{ ok: boolean; reason?: string }>;
  invalidateCswapAutoCache: () => void;
};
type Choice = typeof import("../../server/cswap-auto-choice.mjs");
type Accounts = { invalidateClaudeAccountsCache: () => void };

let auto: Auto;
let choice: Choice;
let accounts: Accounts;
const said: { title: string; body: string }[] = [];

/** One deck-managed tick, waited out, and the notifier after it. */
async function tickOnce() {
  accounts.invalidateClaudeAccountsCache();
  const before = (await auto.autoStatus()).lastTick;
  await auto.setAutoEnabled(true);
  for (let i = 0; i < 400 && (await auto.autoStatus()).lastTick === before; i++) await rest(5);
  await auto.setAutoEnabled(false);
  await rest(150);
  return (await auto.autoStatus()).lastTick;
}

beforeEach(async () => {
  proc.calls.length = 0;
  proc.config = CONFIG();
  proc.duringConfig = null;
  proc.duringPoll = null;
  proc.engineTarget = null;
  proc.engineTrigger = "proactive";
  proc.pollTimeout = false;
  proc.peers = [];
  said.length = 0;
  rmTempDir(ROOT);
  rmTempDir(join(DIR, "deck"));
  vi.resetModules();
  const watch = await import("../../server/account-watch.mjs");
  watch.connectAccountNotify({
    notify: (title: string, body: string) => { said.push({ title, body }); },
    settings: () => ({ swap: true, quota: false, reset: false }), product: "ccdeck", onError: () => {},
  });
  auto = await import("../../server/cswap-auto.mjs") as unknown as Auto;
  choice = await import("../../server/cswap-auto-choice.mjs");
  accounts = await import("../../server/claude-accounts.mjs") as unknown as Accounts;
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

describe("with nothing set", () => {
  it("a tick is the engine's alone, as before", async () => {
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 10 } });
    await tickOnce();
    expect(engineRuns()).toBe(1);
    expect(switches()).toEqual([]);
    expect((await auto.autoStatus()).choice).toEqual({ next: "room", home: null });
  });
});

describe("soonest weekly reset", () => {
  it("keeps a recent deck-managed move's cooldown instead of falling back to most room", async () => {
    const rows = {
      1: { five: 95, weekIn: 16 },
      14: { five: 0, weekIn: 100 },
      15: { five: 40, weekIn: 82 },
    };
    writeStore(1, rows);
    await auto.setNextChoice("weekly");
    expect((await choice.chooseBeforeEngine()).result?.to?.number).toBe(15);
    // A manual return to the full account happens while the deck's cooldown
    // is still running. cswap's own lastSwitchAt did not change on our move.
    writeStore(1, rows);
    accounts.invalidateClaudeAccountsCache();
    proc.engineTarget = 14;
    const tick = await tickOnce();
    expect(activeInStore()).toBe(1);
    expect(tick).toMatchObject({ event: "no-switch", switched: false, reason: "cooldown" });
    expect(proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run"))).toEqual([]);
    const later = Date.now() + 301_000;
    writeStore(1, rows, later);
    accounts.invalidateClaudeAccountsCache();
    expect((await choice.chooseBeforeEngine({ now: later })).result?.to?.number).toBe(15);
  });

  it("still escapes a fully exhausted account using the weekly rule during cooldown", async () => {
    const rows = { 1: { five: 95, weekIn: 16 }, 14: { five: 0, weekIn: 100 }, 15: { five: 40, weekIn: 82 } };
    writeStore(1, rows);
    await auto.setNextChoice("weekly");
    expect((await choice.chooseBeforeEngine()).result?.to?.number).toBe(15);
    writeStore(1, { ...rows, 1: { five: 100, weekIn: 16 } });
    accounts.invalidateClaudeAccountsCache();
    const tick = await tickOnce();
    expect(activeInStore()).toBe(15);
    expect(tick?.trigger).toBe("weekly-reset");
  });

  it("allows the engine's emergency failover during the deck cooldown", async () => {
    const rows = { 1: { five: 95, weekIn: 16 }, 14: { five: 0, weekIn: 100 }, 15: { five: 40, weekIn: 82 } };
    writeStore(1, rows);
    await auto.setNextChoice("weekly");
    expect((await choice.chooseBeforeEngine()).result?.to?.number).toBe(15);
    writeStore(1, { ...rows, 1: { five: 20, weekIn: 16 } });
    accounts.invalidateClaudeAccountsCache();
    proc.engineTarget = 14;
    proc.engineTrigger = "failover";
    const tick = await tickOnce();
    expect(activeInStore()).toBe(14);
    expect(tick).toMatchObject({ switched: true, trigger: "failover" });
  });

  it("selects the soonest reset even when a paired device uses that account", async () => {
    // Reported case: active at 95% weekly, a 24% account resetting in 4d,
    // and a 51% account resetting in 3d10h that another deck is using.
    proc.config = CONFIG().replace("threshold          90", "threshold          95");
    const now = Date.now();
    proc.peers = [{ paired: true, lastSeen: now, offers: { at: now, current: { key: "account-15@b.c@@org-15" } } }];
    writeStore(1, {
      1: { five: 9, week: 95, weekIn: 16 },
      14: { five: 0, week: 24, weekIn: 100 },
      15: { five: 37, week: 51, weekIn: 82 },
    }, now);
    proc.engineTarget = 14;
    await auto.setNextChoice("weekly");
    const tick = await tickOnce();
    expect(activeInStore()).toBe(15);
    expect(tick?.trigger).toBe("weekly-reset");
    expect(switches()).toEqual([15]);
    expect(proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run"))).toEqual([]);
  });

  it.each(["stale", "below threshold"])("honors the weekly policy after the engine refreshes a %s active reading", async initial => {
    // The active reading is stale or still below the limit. The engine's
    // next poll updates it, then its default most-room rule would choose 2.
    // The weekly rule must see that update BEFORE any real engine switch.
    writeStore(1, { 1: { five: initial === "stale" ? 95 : 20, weekIn: 60 }, 2: { five: 0, weekIn: 118 }, 3: { five: 40, weekIn: 70 } });
    proc.duringPoll = () => writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 118 }, 3: { five: 40, weekIn: 70 } });
    proc.engineTarget = 2;
    await auto.setNextChoice("weekly");
    const path = join(ROOT, "cache", "usage.json");
    const usage = JSON.parse(readFileSync(path, "utf8"));
    if (initial === "stale") usage.accounts["1"].fetchedAt = (Date.now() - 20 * 60_000) / 1000;
    writeFileSync(path, JSON.stringify(usage));
    const tick = await tickOnce();
    expect(activeInStore()).toBe(3);
    expect(tick?.trigger).toBe("weekly-reset");
    expect(proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run"))).toEqual([]);
  });

  it("refreshes stale candidates before allowing the most-room fallback to switch", async () => {
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 118 }, 3: { five: 40, weekIn: 70 } });
    const path = join(ROOT, "cache", "usage.json");
    const usage = JSON.parse(readFileSync(path, "utf8"));
    usage.accounts["3"].fetchedAt = (Date.now() - 20 * 60_000) / 1000;
    writeFileSync(path, JSON.stringify(usage));
    proc.duringPoll = () => writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 118 }, 3: { five: 40, weekIn: 70 } });
    proc.engineTarget = 2;
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(activeInStore()).toBe(3);
    expect(switches()).toEqual([3]);
    expect(proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run"))).toEqual([]);
    expect(said).toHaveLength(1);
  });

  it("keeps the engine fallback when no weekly target qualifies after polling", async () => {
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 118 } });
    proc.engineTarget = 2;
    await auto.setNextChoice("weekly");
    const tick = await tickOnce();
    expect(activeInStore()).toBe(2);
    expect(tick?.switched).toBe(true);
    expect(proc.calls.filter(c => c[1] === "auto").map(c => c.includes("--dry-run"))).toEqual([true, false]);
    expect(said).toHaveLength(1);
  });

  it("does not switch if Auto-switch is disabled during the poll", async () => {
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 118 } });
    proc.engineTarget = 2;
    proc.duringPoll = () => auto.setAutoEnabled(false);
    await auto.setNextChoice("weekly");
    const tick = await tickOnce();
    expect(activeInStore()).toBe(1);
    expect(tick?.event).toBe("skipped");
    expect(proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run"))).toEqual([]);
    expect(said).toEqual([]);
  });

  it("reports a poll timeout without attempting a real switch", async () => {
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 118 } });
    proc.pollTimeout = true;
    await auto.setNextChoice("weekly");
    const tick = await tickOnce();
    expect(activeInStore()).toBe(1);
    expect(tick).toMatchObject({ ok: false, reason: "tick_timeout" });
    expect(proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run"))).toEqual([]);
    expect(said).toEqual([]);
  });

  it("leaving at the threshold, moves to the soonest reset itself and does not run the engine after", async () => {
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 90 }, 3: { five: 40, weekIn: 20 } });
    expect(await auto.setNextChoice("weekly")).toEqual({ ok: true });
    const tick = await tickOnce();
    expect(switches()).toEqual([3]);
    expect(activeInStore()).toBe(3);
    expect(engineRuns()).toBe(0);
    expect(tick?.switched).toBe(true);
    expect(tick?.trigger).toBe("weekly-reset");
    expect(said.map(s => s.body)).toEqual(["Switched to account-3@b.c · account-1@b.c reached 90%"]);
  });

  it("below the threshold, says the move is for the weekly reset", async () => {
    writeStore(1, { 1: { five: 20, weekIn: 80 }, 2: { five: 0, weekIn: 30 } });
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(switches()).toEqual([2]);
    expect(said.map(s => s.body)).toEqual([expect.stringMatching(/^Switched to account-2@b\.c · weekly limit resets in 1d 5h|^Switched to account-2@b\.c · weekly limit resets in 1d 6h/)]);
  });

  it("refuses a value that is not one of the two", async () => {
    expect(await auto.setNextChoice("consume-first")).toEqual({ ok: false, reason: "bad_value" });
    expect((await auto.autoStatus()).choice.next).toBe("room");
  });

  it("never moves onto an account claude-swap has quarantined", async () => {
    // 3 resets soonest but its refresh token is dead: the engine would not
    // activate it, and neither may the deck.
    writeEngineState({ quarantine: { "3": { email: "account-3@b.c" } } });
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 90 }, 3: { five: 40, weekIn: 20 } });
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(switches()).toEqual([2]);
  });

  it("reads a quarantine as the account's, not the slot's: one for whoever held the slot before does not count", async () => {
    writeEngineState({ quarantine: { "3": { email: "someone-else@b.c" } } });
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 90 }, 3: { five: 40, weekIn: 20 } });
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(switches()).toEqual([3]);
  });

  it("never moves onto an account a `cswap run` session is working on", async () => {
    // Activating it too would put one rotating refresh token in two places,
    // and one of the two gets signed out. claude-swap's engine skips such an
    // account; `cswap switch`, which a move here runs, only warns.
    writeSession(3, process.pid);
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 90 }, 3: { five: 40, weekIn: 20 } });
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(switches()).toEqual([2]);
  });

  it("counts a session only while its process is running", async () => {
    writeSession(3, GONE_PID);
    writeStore(1, { 1: { five: 95, weekIn: 100 }, 2: { five: 0, weekIn: 90 }, 3: { five: 40, weekIn: 20 } });
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(switches()).toEqual([3]);
  });

  it("names a session profile the way claude-swap does", () => {
    expect(choice.sessionSlug("account-3@b.c")).toBe("account-3_b.c");
    expect(choice.sessionSlug("a.b-c_d@x.com")).toBe("a.b-c_d_x.com");
    expect(choice.sessionSlug("Ünï+tag@x.com")).toBe("_n__tag_x.com");
  });

  it("makes no move below the threshold while the engine runs a strategy of its own", async () => {
    proc.config = CONFIG("consume-first");
    auto.invalidateCswapAutoCache();
    writeStore(1, { 1: { five: 20, weekIn: 80 }, 2: { five: 0, weekIn: 30 } });
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(switches()).toEqual([]);
    expect(engineRuns()).toBeGreaterThan(0);
  });
});

describe("home account", () => {
  it.each([
    { name: "a fresh paired manifest", age: 0, paired: true, beacon: true },
    { name: "an inbound-only peer", age: 0, paired: true, beacon: false },
    { name: "a retained offline manifest", age: H, paired: true, beacon: true },
    { name: "an unpaired row", age: 0, paired: false, beacon: true },
  ])("selects Home even when another device reports it in $name", async ({ age, paired, beacon }) => {
    const now = Date.now();
    proc.peers = [{ paired, ...(beacon ? { lastSeen: now } : {}), offers: {
      at: now - age, current: { key: "account-1@b.c@@org-1" },
    } }];
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 95, weekIn: 100 }, 3: { five: 10, weekIn: 20 } }, now);
    await auto.setNextChoice("weekly");
    await auto.setHomeAccount(1);
    const tick = await tickOnce();
    expect(activeInStore()).toBe(1);
    expect(tick?.trigger).toBe("home");
    expect(switches()).toEqual([1]);
  });

  it("rechecks Home after the engine refreshes its stale usage", async () => {
    const rows = { 1: { five: 0, weekIn: 100 }, 2: { five: 95, weekIn: 100 }, 3: { five: 10, weekIn: 20 } };
    writeStore(2, rows);
    const path = join(ROOT, "cache", "usage.json");
    const usage = JSON.parse(readFileSync(path, "utf8"));
    usage.accounts["1"].fetchedAt = (Date.now() - 20 * 60_000) / 1000;
    writeFileSync(path, JSON.stringify(usage));
    // Do not let the weekly alternate preempt polling either.
    usage.accounts["3"].fetchedAt = (Date.now() - 20 * 60_000) / 1000;
    writeFileSync(path, JSON.stringify(usage));
    proc.duringPoll = () => writeStore(2, rows);
    proc.engineTarget = 3;
    await auto.setNextChoice("weekly");
    await auto.setHomeAccount(1);
    const tick = await tickOnce();
    expect(activeInStore()).toBe(1);
    expect(tick?.trigger).toBe("home");
    expect(switches()).toEqual([1]);
    expect(proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run"))).toEqual([]);
  });

  it("setting one takes the user there, and says so", async () => {
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    expect(await auto.setHomeAccount(1)).toEqual({ ok: true });
    expect((await auto.autoStatus()).choice.home).toEqual({ email: "account-1@b.c", orgUuid: "org-1" });
    const tick = await tickOnce();
    expect(tick?.trigger).toBe("home");
    expect(activeInStore()).toBe(1);
    expect(said.map(s => s.body)).toEqual(["Back on account-1@b.c · your home account"]);
  });

  it("a switch made by hand away from home is left alone until home is set again", async () => {
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    await auto.setHomeAccount(1);
    expect((await choice.chooseBeforeEngine()).result?.to?.number).toBe(1);
    // By hand, back to 2: the next ticks see an account they did not pick —
    // hours later, with fresh readings and home plainly usable.
    for (const later of [3 * H, 4 * H]) {
      writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } }, Date.now() + later);
      accounts.invalidateClaudeAccountsCache();
      expect((await choice.chooseBeforeEngine({ now: Date.now() + later })).result).toBeNull();
    }
    // Setting home again is asking to go there.
    await auto.setHomeAccount(1);
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } }, Date.now() + 5 * H);
    accounts.invalidateClaudeAccountsCache();
    expect((await choice.chooseBeforeEngine({ now: Date.now() + 5 * H })).result?.to?.number).toBe(1);
  });

  it("passes over a quarantined home, and leaves the move to the engine", async () => {
    writeEngineState({ quarantine: { "1": { email: "account-1@b.c" } } });
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    await auto.setHomeAccount(1);
    await tickOnce();
    expect(switches()).toEqual([]);
    expect(engineRuns()).toBeGreaterThan(0);
  });

  it("passes over a home a `cswap run` session is working on, and leaves the move to the engine", async () => {
    writeSession(1, process.pid);
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    await auto.setHomeAccount(1);
    await tickOnce();
    expect(switches()).toEqual([]);
    expect(engineRuns()).toBeGreaterThan(0);
  });

  it("removing it ends the rule", async () => {
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    await auto.setHomeAccount(1);
    await auto.setHomeAccount(null);
    expect((await auto.autoStatus()).choice.home).toBeNull();
    await tickOnce();
    expect(switches()).toEqual([]);
  });

  it("keeps a home set while a tick was deciding, and goes there on the next one", async () => {
    // The engine moved ten minutes ago: past its cooldown, inside the half
    // hour optional moves wait — so only a home just set may be gone to.
    writeEngineState({ lastSwitchAt: (Date.now() - 10 * 60_000) / 1000 });
    writeStore(1, { 1: { five: 20, weekIn: 80 }, 2: { five: 30, weekIn: 100 } });
    await auto.setNextChoice("weekly");
    auto.invalidateCswapAutoCache();
    proc.duringConfig = () => auto.setHomeAccount(2);
    expect((await choice.chooseBeforeEngine()).result).toBeNull();
    accounts.invalidateClaudeAccountsCache();
    expect((await choice.chooseBeforeEngine()).result?.to?.number).toBe(2);
  });

  it("refuses a slot that holds no account", async () => {
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    expect(await auto.setHomeAccount(7)).toEqual({ ok: false, reason: "bad_account" });
    expect(await auto.setHomeAccount(-1 as number)).toEqual({ ok: false, reason: "bad_account" });
  });
});
