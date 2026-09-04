// A killed tick is not a healthy tick.
//
// `run`'s timeout path deliberately keeps an 8 KB tail of whatever the child
// managed to print — the last line a hung tool wrote is usually the only clue
// why it hung. `runAutoTick` then tested `!r.ok && !r.stdout`, which is false
// for a `cswap auto --once` that emitted its `{"event":"poll"}` line and then
// stalled, so the killed run fell through to `{ ok: true, ...summarise() }`.
//
// The panel showed a healthy `no-switch` every two minutes, forever, while the
// engine did nothing at all — the exact trap exec.mjs's own header names about
// reading `ok` without reading `timedOut`.
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { state } = vi.hoisted(() => ({ state: { timedOut: false } }));

vi.mock("../../server/exec.mjs", () => ({
  run: async (_cmd: string, args: string[] = []) => {
    if (args[0] === "auto") {
      // What `run` really returns for a deadline: not ok, killed, timedOut, and
      // a tail of what the child had already printed.
      return state.timedOut
        ? { ok: false, code: null, killed: true, timedOut: true,
            stdout: '{"event":"poll","active":2,"threshold":90}\n', stderr: "" }
        : { ok: true, code: 0, killed: false, timedOut: false,
            stdout: '{"event":"poll","active":2,"threshold":90}\n{"event":"no-switch"}\n', stderr: "" };
    }
    return { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  },
  runDetached: () => {},
}));

const HOME = mkdtempSync(join(tmpdir(), "cswap-tick-timeout-"));
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const mod = await import("../../server/cswap-auto.mjs");

afterAll(async () => {
  await mod.setAutoEnabled(false);
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmTempDir(HOME);
});

describe("what the panel is told about a tick that was killed", () => {
  it("reports the timeout instead of a healthy no-switch", async () => {
    state.timedOut = true;
    await mod.setAutoEnabled(true);
    await new Promise(r => setTimeout(r, 60));
    const status = await mod.autoStatus();
    expect(status.lastTick, "no tick was recorded at all").toBeTruthy();
    expect(status.lastTick.ok).toBe(false);
    expect(status.lastTick.reason).toBe("tick_timeout");
    await mod.setAutoEnabled(false);
  });

  it("still reports a real tick as a real tick", async () => {
    state.timedOut = false;
    await mod.setAutoEnabled(true);
    await new Promise(r => setTimeout(r, 60));
    const status = await mod.autoStatus();
    expect(status.lastTick.ok).toBe(true);
    expect(status.lastTick.event).toBe("no-switch");
    await mod.setAutoEnabled(false);
  });
});
