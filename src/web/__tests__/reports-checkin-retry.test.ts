// A check-in that could not get through, or a UTC day that has no "active" yet,
// is tried again on the heartbeat's next beat — not six hours of awake time
// later (reports.mjs).
//
// Two decks this is for. One started as a login item before the Wi-Fi was up:
// its boot check-in failed, and until the six-hour timer came round the API
// heard ten-minute pings for an install it had never been told about. The other
// lives on a laptop that sleeps between uses: Node's timers do not run while
// the machine is suspended, so six hours of awake time can be days of calendar
// time, and a day the deck was used could end with no "active" at all.
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
/** PING_EVERY_MS (10m) + PING_JITTER_MS (2m): one beat, whatever the jitter. */
const BEAT = 12 * MIN;

type Call = { url: string; body: Record<string, unknown> };

function harness({ saved = {} as Record<string, unknown> } = {}) {
  let prefs = normalise(saved);
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: Call[] = [];
  let online = true;
  /** A send that does not answer until it is let go: an API that is slow, not down. */
  let hold: Promise<void> | null = null;
  // The wall clock runs with the fake timers, as a real one runs with real
  // time; a sleep moves it alone.
  const t0 = Date.now();
  let slept = 0;
  const clock = () => new Date(Date.parse("2026-10-04T10:00:00Z") + (Date.now() - t0) + slept);
  let offlineTries = 0;
  const fetchImpl = async (url: string, init: { body?: string }) => {
    if (!online) { if (url.endsWith("/v1/app/events")) offlineTries++; throw new Error("getaddrinfo ENOTFOUND api.ccdeck.dev"); }
    calls.push({ url, body: init.body ? JSON.parse(init.body) : {} });
    if (hold && url.endsWith("/v1/app/events")) await hold;
    return { ok: true, status: 202 };
  };
  let depthReads = 0;
  const reporter = createReporter({
    fetchImpl, now: clock, prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage: createUsageDay({ now: clock }), setup: () => ({}), setupKnown: () => Promise.resolve(),
    depth: async () => { depthReads++; return {}; },
    firstRun: () => true,
  });
  return {
    reporter, calls, prefs: () => prefs,
    goOffline: () => { online = false; },
    goOnline: () => { online = true; },
    holdEvents: () => { let go = () => {}; hold = new Promise<void>(r => { go = r; }); return () => { hold = null; go(); }; },
    /** The machine slept: the wall clock moved, the deck's timers did not. */
    sleep: (ms: number) => { slept += ms; },
    offlineTries: () => offlineTries,
    depthReads: () => depthReads,
    kinds: () => calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body.kind),
    pings: () => calls.filter(c => c.url.endsWith("/v1/app/ping")).length,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("a check-in the boot could not send", () => {
  it("goes out on the next beat once the network is back, not six hours later", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.goOffline();
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(10);
    // The id is the deck's and was made, but the API heard nothing.
    expect(h.prefs().report.installId).not.toBe("");
    expect(h.prefs().report.lastVersion).toBe("");

    h.goOnline();
    await vi.advanceTimersByTimeAsync(BEAT);
    h.reporter.stop();

    expect(h.kinds()).toEqual(["install", "active"]);
    expect(h.prefs().report.lastVersion).toBe("3.37.0");
    expect(h.prefs().report.lastActiveDay).toBe("2026-10-04");
  });

  it("keeps trying while the API stays out of reach, and gets through once it is back", async () => {
    // Less often the longer it stays out (reports-refused-event.test.ts), so
    // it is given until a few beats past the longest wait three misses make.
    vi.useFakeTimers();
    const h = harness();
    h.goOffline();
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    // The boot's install and "active", and at least one more go at them.
    expect(h.offlineTries()).toBeGreaterThanOrEqual(4);
    h.goOnline();
    await vi.advanceTimersByTimeAsync(6 * BEAT);
    h.reporter.stop();
    expect(h.kinds()).toEqual(["install", "active"]);
  });
});

describe("a day with no 'active' yet", () => {
  it("gets one on the first beat after the machine wakes into it", async () => {
    vi.useFakeTimers();
    const h = harness({
      saved: { report: { installId: "id-1", lastVersion: "3.37.0", lastActiveDay: "2026-10-04" } },
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.kinds()).toEqual([]);   // today was already said

    // Asleep overnight: a day on the wall clock, no time at all on the timers.
    h.sleep(DAY);
    await vi.advanceTimersByTimeAsync(BEAT);
    h.reporter.stop();

    expect(h.kinds()).toEqual(["active"]);
    expect(h.prefs().report.lastActiveDay).toBe("2026-10-05");
  });
});

describe("a beat with nothing due", () => {
  it("sends the ping alone, and reads nothing an 'active' would", async () => {
    vi.useFakeTimers();
    const h = harness({
      saved: { report: { installId: "id-1", lastVersion: "3.37.0", lastActiveDay: "2026-10-04" } },
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    h.reporter.stop();
    expect(h.kinds()).toEqual([]);
    expect(h.pings()).toBeGreaterThanOrEqual(2);
    expect(h.depthReads()).toBe(0);
  });

  it("never starts a second check-in while one is still waiting on the API", async () => {
    vi.useFakeTimers();
    const h = harness();
    const release = h.holdEvents();
    h.reporter.start();
    // The boot's install is in flight and stays there across two beats.
    await vi.advanceTimersByTimeAsync(2 * BEAT);
    expect(h.kinds()).toEqual(["install"]);
    release();
    await vi.advanceTimersByTimeAsync(10);
    h.reporter.stop();
    expect(h.kinds()).toEqual(["install", "active"]);
  });
});
