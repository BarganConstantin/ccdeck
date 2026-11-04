// The first heartbeat after a start comes in a minute or two (reports.mjs).
//
// The ping is what moves an install's "last seen", which is how the admin shows
// who is online now. It used to wait a full beat — ten minutes plus up to two of
// jitter — after the boot, and a restart on a day and a version already
// reported sends nothing at its check-in: a restarted deck showed as offline
// for ten to twelve minutes. Now one ping goes 60 to 120 seconds in, with the
// same body and under the same rules, and the beats keep their old pace.
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const SEC = 1000;
const MIN = 60 * SEC;
const START = new Date("2026-11-04T10:00:00Z");

/** A reporter whose install, version and day are already said — a restart —
 *  so its boot check-in sends nothing and the only thing its timers send is
 *  the ping. Nothing leaves: fetch is the stub below. */
function harness({ reports = true, env = {} as Record<string, string>, installId = "id-1" } = {}) {
  vi.useFakeTimers({ now: START });
  let prefs = normalise({ reports, report: { installId, lastVersion: "3.81.2", lastActiveDay: "2026-11-04" } });
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const tries: Array<{ url: string; body: unknown; at: number }> = [];
  const fetchImpl = async (url: string, init: { body?: string }) => {
    tries.push({ url, body: init.body ? JSON.parse(init.body) : undefined, at: Date.now() - START.getTime() });
    return { ok: true, status: url.endsWith("/v1/app/ping") ? 204 : 202, headers: { get: () => null } };
  };
  const reporter = createReporter({
    fetchImpl, now: () => new Date(), prefs: store, env, home: "/home/alice", ready: Promise.resolve(),
    facts: { version: "3.81.2", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage: createUsageDay({ now: () => new Date() }), setup: () => ({}), setupKnown: () => Promise.resolve(),
    firstRun: () => false, uptime: () => 0,
  });
  return {
    reporter,
    all: () => tries,
    pings: () => tries.filter(t => t.url.endsWith("/v1/app/ping")),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the first heartbeat after a start", () => {
  it("goes out between one and two minutes in, with the install id alone", async () => {
    const h = harness();
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(59 * SEC);
    expect(h.all()).toEqual([]);                 // nothing at the boot itself
    await vi.advanceTimersByTimeAsync(61 * SEC);
    h.reporter.stop();
    expect(h.pings()).toHaveLength(1);
    expect(h.pings()[0].body).toEqual({ installId: "id-1" });
    expect(h.pings()[0].at).toBeGreaterThanOrEqual(MIN);
    expect(h.pings()[0].at).toBeLessThanOrEqual(2 * MIN);
  });

  it("is spread across the minute by its jitter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = harness();
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(89 * SEC);
    expect(h.pings()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * SEC);
    h.reporter.stop();
    expect(h.pings().map(p => p.at)).toEqual([90 * SEC]);
  });

  it("leaves the beats where they were: ten to twelve minutes from the start, and apart", async () => {
    const h = harness();
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(4 * 12 * MIN);
    h.reporter.stop();
    const [first, ...beats] = h.pings().map(p => p.at);
    expect(first).toBeLessThanOrEqual(2 * MIN);
    expect(beats.length).toBeGreaterThanOrEqual(4);
    expect(beats[0]).toBeGreaterThanOrEqual(10 * MIN);
    expect(beats[0]).toBeLessThanOrEqual(12 * MIN);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i] - beats[i - 1]).toBeGreaterThanOrEqual(10 * MIN);
      expect(beats[i] - beats[i - 1]).toBeLessThanOrEqual(12 * MIN);
    }
    for (const p of h.pings()) expect(p.body).toEqual({ installId: "id-1" });
  });

  it("is not sent with reports switched off", async () => {
    const h = harness({ reports: false, installId: "" });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    h.reporter.stop();
    expect(h.all()).toEqual([]);
  });

  it("is not sent under the machine's veto, even with an id already saved", async () => {
    const h = harness({ env: { AGENTS_DECK_NO_REPORTS: "1" } });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    h.reporter.stop();
    expect(h.all()).toEqual([]);
  });

  it("is not sent once the reporter is stopped", async () => {
    const h = harness();
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(30 * SEC);
    h.reporter.stop();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(h.pings()).toEqual([]);
  });

  it("is not sent twice when start runs twice", async () => {
    const h = harness();
    h.reporter.start();
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    h.reporter.stop();
    expect(h.pings()).toHaveLength(1);
  });
});
