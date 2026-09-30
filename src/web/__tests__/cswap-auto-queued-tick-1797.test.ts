// #1797: a tick queued on the store lock when auto-switch is turned off.
//
// runTick re-checks `_enabled` after its `externalAutoRunning` await (#768),
// and then calls runAutoTick, which awaits `withStoreLock` — a FIFO chain with
// no timeout. The lock is held for the length of the user's own Add, Switch or
// Remove, or the deck's stale-copy recapture, and a tick that arrives meanwhile
// waits behind it. Turning the switch off in that window cleared the interval
// and nothing else, so when the lock came free the queued tick ran
// `cswap auto --once` anyway and could move the live Claude account, with
// /api/cswap-auto reporting `enabled: false` beside a `switch` lastTick.
//
// Nothing here spawns anything. `run` is mocked and records argv; AGENTS_DECK_CSWAP
// names a path in the temp home that is never executed; HOME, CLAUDE_CONFIG_DIR,
// XDG_DATA_HOME and CLAUDE_SWAP_BACKUP all point into that temp home before the
// modules are imported, and the swap log is mocked so a switch that did happen
// would write nothing either.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { calls, swaps } = vi.hoisted(() => ({
  calls: [] as string[][],
  swaps: [] as unknown[],
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, stdout: "{}", stderr: "" };
    if (args[0] === "auto") {
      // What the engine prints when it decides to move the live account.
      return {
        ...okay,
        stdout: [
          JSON.stringify({ event: "poll", active: 1, threshold: 90, headroomPct: 5 }),
          JSON.stringify({ event: "switch", from: 1, to: 2 }),
        ].join("\n"),
      };
    }
    // `cswap config`, and `ps` for externalAutoRunning: nothing of the user's.
    return { ...okay, stdout: args[0] === "config" ? "{}" : "" };
  },
  runDetached: () => {},
}));

vi.mock("../../server/swap-log.mjs", () => ({
  recordSwap: async (...a: unknown[]) => { swaps.push(a); },
}));

const HOME = mkdtempSync(join(tmpdir(), "cswap-auto-queued-"));
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CSWAP"] as const;
const prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLAUDE_CONFIG_DIR = join(HOME, ".claude");
process.env.XDG_DATA_HOME = join(HOME, ".local", "share");
process.env.CLAUDE_SWAP_BACKUP = join(HOME, "claude-swap");
process.env.AGENTS_DECK_CSWAP = join(HOME, "fake-cswap");

const mod = await import("../../server/cswap-auto.mjs");
const { lastTick } = await import("../../server/cswap-auto-loop.mjs");
const { withStoreLock } = await import("../../server/store-lock.mjs");

const autoRuns = () => calls.filter(c => c.includes("auto"));
/** externalAutoRunning's process-table read: `ps` here, PowerShell on Windows. */
const tableRead = () => calls.some(c => c[0] === "ps" || c[0] === "powershell.exe");
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

// The lock a case is holding, let go of afterwards whatever the case did — the
// chain is first-in first-out, so one left held would wedge every case after it.
let release: () => void = () => {};

afterEach(() => { release(); });

beforeEach(async () => {
  mod.invalidateCswapAutoCache();
  await mod.setAutoEnabled(false);
  calls.length = 0;
  swaps.length = 0;
});

afterAll(async () => {
  await mod.setAutoEnabled(false);
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmTempDir(HOME);
});

describe("a tick waiting on the store lock when auto-switch is turned off", () => {
  it("runs nothing once the lock frees and records the tick as skipped", async () => {
    // Another store mutation holds the lock — an Add, a Switch, a recapture.
    const holding = withStoreLock(() => new Promise<void>(r => { release = r; }));

    await mod.setAutoEnabled(true);
    // The eager first tick gets past its own checks and queues on the lock.
    await rest(40);
    expect(tableRead(), "the tick never reached its external-engine check").toBe(true);
    expect(autoRuns(), "the tick ran while the lock was held").toEqual([]);

    await mod.setAutoEnabled(false);
    release();
    await holding;
    await rest(40);

    expect(autoRuns(), "`cswap auto --once` ran after the switch was turned off").toEqual([]);
    expect(swaps, "a switch was recorded for a loop the user turned off").toEqual([]);
    expect(lastTick()).toMatchObject({ event: "skipped", reason: "disabled" });
    expect((await mod.autoStatus()).enabled).toBe(false);
  });

  it("still runs a queued tick when the switch stays on", async () => {
    const holding = withStoreLock(() => new Promise<void>(r => { release = r; }));

    await mod.setAutoEnabled(true);
    await rest(40);
    expect(autoRuns()).toEqual([]);

    release();
    await holding;
    await rest(40);

    expect(autoRuns().length, "a tick for a loop that stayed on never ran").toBe(1);
    expect(lastTick()).toMatchObject({ event: "switch", switched: true, to: 2 });
  });
});
