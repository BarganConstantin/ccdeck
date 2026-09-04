// A toggle that says off while it keeps switching accounts.
//
// startLoop's guard was `if (_timer) return`, and `_timer` is assigned AFTER
// `await tickInterval()` — which shells out to `cswap config`. The check and the
// assignment sat on opposite sides of a subprocess, so two callers could both be
// past the check before either had set anything.
//
// Two ways in, both reachable from the panel:
//
//   - enable, then disable a few hundred milliseconds later. The disable set
//     `_enabled = false` and called stopLoop, which cleared nothing because
//     `_timer` was still null; the enable then came back and installed the
//     interval. autoStatus() reported `enabled: false` and the toggle read off,
//     while every tick ran `cswap auto --once` — which switches the user's live
//     Claude account. A control that says it is off while it moves credentials
//     is the worst shape this could take.
//
//   - two enables, from a double click or two tabs: two intervals with only the
//     second reachable from `_timer`, so the first could never be cleared again
//     for the life of the process.
//
// initCswapAuto is a third way in — index.mjs fires it unawaited while the
// server is already accepting requests.
//
// And a third defect on the same loop: nothing stopped ticks stacking. The
// interval floor is 15s (SETTINGS allows exactly that) while one tick can take 8
// for externalAutoRunning plus 120 for runAutoTick's own timeout, so a slow
// `cswap auto --once` could have eight copies of itself running against each
// other two minutes later, each switching accounts.
//
// Nothing here spawns anything. `run` is mocked: `cswap config` is given a real
// 60ms so the enable/disable window is a place this file can stand rather than a
// thing it has to race, and `cswap auto --once` is held open on demand.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { calls, state } = vi.hoisted(() => ({
  calls: [] as string[][],
  state: { configMs: 0, tickHeld: false, releaseTick: null as null | (() => void) },
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, stdout: "{}", stderr: "" };
    if (args[0] === "config") {
      if (state.configMs) await new Promise(r => setTimeout(r, state.configMs));
      return okay;
    }
    if (args[0] === "auto") {
      if (state.tickHeld) await new Promise<void>(r => { state.releaseTick = r; });
      return okay;
    }
    // `ps` / Get-CimInstance, and cswapBin's `--version` probe.
    return { ...okay, stdout: "" };
  },
  runDetached: () => {},
}));

// The module writes its enabled flag under the home directory, so point that
// somewhere disposable before it is imported.
const HOME = mkdtempSync(join(tmpdir(), "cswap-auto-loop-"));
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const mod = await import("../../server/cswap-auto.mjs");

/** Every `cswap auto --once` this test has provoked. */
const ticks = () => calls.filter(c => c[1] === "auto" && c[2] === "--once").length;
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  state.tickHeld = false;
  state.releaseTick?.();
  state.releaseTick = null;
  state.configMs = 0;
  // #616 gave `cswap config` a three-second floor, and tickInterval reads it
  // through readCswapConfig like everybody else. Two of the cases below stand
  // INSIDE that read — `state.configMs = 60` is the window they need startLoop
  // to still be waiting in — and a reading left over from the previous case
  // makes startLoop return before they can get there, so they would pass
  // without the race they exist for ever happening. The module's own reset
  // drops it.
  mod.invalidateCswapAutoCache();
  await mod.setAutoEnabled(false);
  calls.length = 0;
});

afterEach(async () => {
  state.tickHeld = false;
  state.releaseTick?.();
  vi.useRealTimers();
  await mod.setAutoEnabled(false);
});

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmTempDir(HOME);
});

describe("a tick that is already running when the user turns it off", () => {
  it("does not switch an account after the panel has drawn itself as off", async () => {
    // `stopLoop` clears the interval and nothing else, so a tick past its first
    // await went on to run `cswap auto --once` — which moves the user's live
    // Claude account. That await is not short: ticks are at least fifteen
    // seconds apart against a ten-second floor, so each one pays a real
    // process-table read, and on Windows that is a PowerShell Get-CimInstance
    // with an eight-second deadline. The panel showed `enabled: false` beside a
    // `lastTick` of `{event: "switch"}` stamped after the disable.
    state.tickHeld = true;              // hold `cswap auto --once` open
    await mod.setAutoEnabled(true);
    await rest(30);
    expect(ticks(), "the first tick did not start").toBeGreaterThan(0);

    // The next tick has to find the switch off. Turn it off while the held one
    // is still in flight, then let everything drain.
    await mod.setAutoEnabled(false);
    state.tickHeld = false;
    state.releaseTick?.();
    const before = ticks();
    await rest(120);

    expect(ticks(), "another `auto --once` ran after the toggle said off").toBe(before);
    const status = await mod.autoStatus();
    expect(status.enabled).toBe(false);
  });
});

describe("changing the interval", () => {
  it("restarts the timer instead of only changing what the panel reports", async () => {
    // `tickInterval()` is read once, at startLoop. Setting 3600 used to return
    // ok and read back an hour while the loop went on firing at the old rate
    // for the life of the process — sixty `cswap auto --once` spawns an hour
    // instead of one, against the shared per-account budget this subsystem
    // exists to protect.
    await mod.setAutoEnabled(true);
    await rest(30);
    calls.length = 0;

    const r = await mod.setCswapConfig("autoswitch.intervalSeconds", 300);
    expect(r).toEqual({ ok: true });
    // The restart is observable as the immediate tick startLoop always fires,
    // plus the `config get` read that gave it the new interval.
    await rest(40);
    expect(calls.some(c => c[1] === "config" && c[2] === "set"), "the setting was never written").toBe(true);
    expect(calls.some(c => c[1] === "auto" && c[2] === "--once"), "the loop was not restarted").toBe(true);
  });

  it("leaves the timer alone when auto-switch is off", async () => {
    await mod.setAutoEnabled(false);
    calls.length = 0;
    await mod.setCswapConfig("autoswitch.intervalSeconds", 120);
    await rest(40);
    expect(calls.some(c => c[1] === "auto"), "a disabled loop was started by a settings change").toBe(false);
  });
});

describe("enabling and disabling across the config read", () => {
  it("leaves no loop running behind a toggle that says off", async () => {
    state.configMs = 60;
    const enabling = mod.setAutoEnabled(true);
    await rest(15);                    // inside the window, well before config answers

    await mod.setAutoEnabled(false);
    await enabling;                    // this is where the interval used to appear
    state.configMs = 0;

    expect((await mod.autoStatus()).enabled).toBe(false);
    expect(ticks(), "a tick ran for a loop the user had switched off").toBe(0);
  });

  it("installs one loop for two enables, not two", async () => {
    state.configMs = 60;
    const a = mod.setAutoEnabled(true);
    await rest(15);
    // #616 gave `cswap config` a shared in-flight promise, and the race under
    // test here is startLoop's rather than the reader's. Without this the second
    // enable joins the first's read and both resume in the SAME microtask, where
    // the one-tick-at-a-time guard collapses their two eager ticks into one and
    // the count below can no longer tell one installed interval from two. The
    // leak is still real — a second setInterval overwrites `_timer`, so the
    // first can never be cleared again — it just stops being visible from here.
    mod.invalidateCswapAutoCache();
    const b = mod.setAutoEnabled(true);
    await Promise.all([a, b]);
    state.configMs = 0;
    await rest(20);

    // startLoop fires one tick eagerly so the user does not wait a whole
    // interval. Two loops would mean two of them — and one interval that could
    // never be cleared again.
    expect(ticks()).toBe(1);
  });
});

describe("one tick at a time", () => {
  it("skips an interval that arrives while a tick is still running", async () => {
    // Fake timers BEFORE the loop is installed, so the interval this asserts
    // about is one this test can advance. Switching to them afterwards leaves
    // the real 60-second interval pending in real time and nothing to advance —
    // which is a way to write a test that can only ever pass.
    vi.useFakeTimers();
    state.tickHeld = true;
    const enabling = mod.setAutoEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    await enabling;
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks(), "the eager first tick never started").toBe(1);

    // Three intervals go by with that tick still in flight. Without the
    // in-flight guard each one starts another `cswap auto --once`, and they
    // switch accounts against each other.
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(ticks()).toBe(1);

    // And the loop is not wedged afterwards: once the tick settles, the next
    // interval runs normally. The release resolves a promise, and clearing the
    // guard is a few microtask hops further down runTick's own chain.
    state.tickHeld = false;
    state.releaseTick?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks()).toBe(2);
  });
});
