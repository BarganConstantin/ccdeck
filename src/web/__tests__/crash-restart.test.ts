// Before the deck ran in the background, a crash was self-reporting: the
// terminal came back, the stack was on screen, and you knew within a second.
// Detached, nothing says anything. The deck stops receiving hook events, stops
// answering the LAN beacon, stops watching the quota — and the first sign is
// noticing, hours later, that a day of work was never recorded.
//
// So the supervisor puts it back. The interesting half is the ceiling, because
// the other failure is worse than the one being fixed: a deck that dies on its
// own boot, respawned forever, is a process spinning on a machine nobody is
// watching, writing the same stack into the same log a thousand times an hour.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain .mjs module, no types
const sup = await import("../../server/supervisor.mjs");
const { CRASH_BACKOFF_MAX_MS, CRASH_CEILING, CRASH_WINDOW_MS, crashPolicy, isCrash } = sup as {
  CRASH_BACKOFF_MAX_MS: number;
  CRASH_CEILING: number;
  CRASH_WINDOW_MS: number;
  crashPolicy: (h?: number[], o?: Record<string, number>) => Verdict;
  isCrash: (o: { code?: number | null; signal?: string | null; served?: boolean; stopping?: boolean }) => boolean;
};
type Verdict = { restart: boolean; delayMs: number; recent: number; history: number[] };

const SUPERVISOR = readFileSync(
  fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url)), "utf8",
);

describe("what counts as a crash", () => {
  const up = { served: true, stopping: false };

  it("is only a deck that was actually up", () => {
    // A worker that never bound a port did not crash, it failed to START — a
    // port the OS will not give us, a `dist/` that was never built. Retrying
    // that five times prints the same refusal six times and fixes nothing.
    expect(isCrash({ ...up, code: 1 })).toBe(true);
    expect(isCrash({ served: false, stopping: false, code: 1 })).toBe(false);
  });

  it("is never a stop, however the stop was spelled", () => {
    // Ctrl+C, a SIGTERM, and `--stop`'s fallback ladder all set `stopping`, and
    // every one of them is somebody asking for this deck to be gone.
    expect(isCrash({ served: true, stopping: true, code: 1 })).toBe(false);
    expect(isCrash({ served: true, stopping: true, signal: "SIGKILL" })).toBe(false);
    // And exit 0 is the deck ending ITSELF — the shutdown /api/shutdown runs,
    // which is exactly what `ccdeck --stop` asks for. Answering that with a
    // restart would make the off switch a no-op.
    expect(isCrash({ ...up, code: 0 })).toBe(false);
  });

  it("counts a signal, because `kill -9` on the worker is not a request", () => {
    // An OOM killer or a stray hand. `--stop` ends the SUPERVISOR first,
    // precisely so this rule and that ladder do not fight over the same deck.
    expect(isCrash({ ...up, signal: "SIGKILL" })).toBe(true);
    expect(isCrash({ ...up, signal: "SIGSEGV" })).toBe(true);
  });

  it("does not read a missing code as a crash", () => {
    // `exit` hands (code, signal) and exactly one of them is null. A null code
    // with a null signal is not a thing the runtime produces, and guessing at
    // it would respawn on a shape nobody has seen.
    expect(isCrash({ ...up, code: null, signal: null })).toBe(false);
    expect(isCrash({ ...up })).toBe(false);
  });
});

describe("the ceiling, and the window that gives it meaning", () => {
  it("doubles the wait, so the two shapes of crash get what each needs", () => {
    // A deck that falls over once an hour should come back immediately — a
    // second of downtime is a second of unrecorded work. A deck that dies in
    // its own first instruction should be tried slowly enough that the log is
    // readable and the CPU is idle in between. Measured on a real supervisor:
    // 1s, 2s, 4s, 8s, 16s, and the same port kept every time.
    const now = 1_000_000;
    const delays: number[] = [];
    let history: number[] = [];
    for (let i = 0; i < CRASH_CEILING; i++) {
      const v = crashPolicy(history, { now });
      expect(v.restart, `attempt ${i + 1}`).toBe(true);
      delays.push(v.delayMs);
      history = v.history;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(crashPolicy(history, { now })).toMatchObject({ restart: false, delayMs: 0 });
  });

  it("stops doubling before the wait outlives the window it is counted in", () => {
    const now = 0;
    const many = Array.from({ length: 20 }, () => 0);
    expect(crashPolicy(many, { now, ceiling: 99 }).delayMs).toBe(CRASH_BACKOFF_MAX_MS);
  });

  it("forgets crashes older than the window", () => {
    // Five crashes in ten minutes is a deck that cannot run. Five crashes over
    // three weeks is a machine that went to sleep oddly three times, and
    // putting it back each time is exactly right.
    const now = 10 * CRASH_WINDOW_MS;
    const old = Array.from({ length: CRASH_CEILING }, (_, i) => now - CRASH_WINDOW_MS - i * 1000);
    const v = crashPolicy(old, { now });
    expect(v.restart).toBe(true);
    expect(v.delayMs).toBe(1000);
    // And the pruned list is handed back, so nothing carries last Tuesday into
    // this decision forever.
    expect(v.history).toEqual([now]);
  });

  it("does not count a refusal against the count", () => {
    // Otherwise a machine that crashes once more after the ceiling would need a
    // longer and longer quiet period to ever be allowed back.
    const now = 1_000;
    const full = Array.from({ length: CRASH_CEILING }, () => now);
    expect(crashPolicy(full, { now }).history).toEqual(full);
  });
});

describe("how the supervisor spends it", () => {
  it("keeps the timer ref'd, or the promise to come back is not kept", () => {
    // Everything else in this file is unref'd on purpose. This one IS the
    // supervisor's reason to stay alive: unref it and the event loop empties
    // and the process exits before the deck it just promised to restart.
    const at = SUPERVISOR.indexOf("if (!stopping) launch(true); }, verdict.delayMs)");
    expect(at).toBeGreaterThan(0);
    expect(SUPERVISOR.slice(at, at + 120)).not.toContain("unref");
  });

  it("checks `stopping` again when the timer fires, not only when it is set", () => {
    // Sixteen seconds is long enough for somebody to Ctrl+C in the gap, and a
    // restart that ignored that would resurrect a deck the user had stopped.
    expect(SUPERVISOR).toContain("if (!stopping) launch(true);");
  });

  it("says the count and the ceiling, so the number means something", () => {
    expect(SUPERVISOR).toContain("the deck stopped on its own");
    expect(SUPERVISOR).toContain("${verdict.recent}/${CRASH_CEILING}");
    expect(SUPERVISOR).toContain("not starting it again");
  });

  it("guards the `booted` forward, which a crash restart is what found", () => {
    // The launcher disconnects the moment the FIRST boot finishes, so every
    // later boot forwards this down a dead channel — and `process.send` on a
    // closed channel does not throw where the call is, it emits 'error' on
    // `process` a tick later. Unhandled, that ends the supervisor: the deck came
    // back and the thing supervising it died of saying so.
    expect(SUPERVISOR).toContain('m.type === "booted" && process.connected');
    expect(SUPERVISOR).toContain('process.send({ type: "booted" }, () => {})');
  });
});
