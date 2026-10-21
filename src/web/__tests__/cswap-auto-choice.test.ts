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

const { proc } = vi.hoisted(() => ({ proc: { calls: [] as string[][], config: "" } }));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    if (args[0] === "config") return { ...okay, stdout: proc.config };
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
      return { ...okay, code: 2, ok: false, stdout: JSON.stringify({ event: "no-switch", reason: "below-threshold" }) };
    }
    return okay;
  },
  runDetached: () => {},
  pathLookup: (name: string) => `/usr/bin/${name}`,
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
function writeStore(activeNum: number, rows: Record<number, { five: number; weekIn: number }>, at = Date.now()) {
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
    expect(engineRuns()).toBeGreaterThan(0);
    expect(switches()).toEqual([]);
    expect((await auto.autoStatus()).choice).toEqual({ next: "room", home: null });
  });
});

describe("soonest weekly reset", () => {
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

  it("removing it ends the rule", async () => {
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    await auto.setHomeAccount(1);
    await auto.setHomeAccount(null);
    expect((await auto.autoStatus()).choice.home).toBeNull();
    await tickOnce();
    expect(switches()).toEqual([]);
  });

  it("refuses a slot that holds no account", async () => {
    writeStore(2, { 1: { five: 0, weekIn: 100 }, 2: { five: 30, weekIn: 100 } });
    expect(await auto.setHomeAccount(7)).toEqual({ ok: false, reason: "bad_account" });
    expect(await auto.setHomeAccount(-1 as number)).toEqual({ ok: false, reason: "bad_account" });
  });
});
