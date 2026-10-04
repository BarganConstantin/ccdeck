// The heartbeat waits out a 429's Retry-After too (reports.mjs).
//
// An API that answers 429 or 503 with a Retry-After is asking to be left alone
// for that long, and the check-ins wait for it (reports-refused-event.test.ts).
// The heartbeat did not: its ping went on every beat, about every ten minutes,
// whatever the answer had asked — the one request a deck sends all day long
// was the one that never heard it. Now a Retry-After quiets the ping as well,
// with the same one-day cap, whichever request it came back on.
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** PING_EVERY_MS (10m) + PING_JITTER_MS (2m): one beat, whatever the jitter. */
const BEAT = 12 * MIN;
const START = new Date("2026-10-04T10:00:00Z");

type Answer = { status: number; headers?: Record<string, string> };

/** A reporter whose install and day are already said, against an API that
 *  answers each ping with `ping` and every event with `event`, on a clock that
 *  moves with the fake timers. Nothing leaves: fetch is the stub below. */
function harness({
  ping = (): Answer => ({ status: 204 }),
  event = (): Answer => ({ status: 202 }),
  lastActiveDay = "2026-10-04",
} = {}) {
  vi.useFakeTimers({ now: START });
  let prefs = normalise({ report: { installId: "id-1", lastVersion: "3.37.0", lastActiveDay } });
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const tries: Array<{ url: string; kind?: string; at: number }> = [];
  const fetchImpl = async (url: string, init: { body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : {};
    tries.push({ url, kind: body.kind, at: Date.now() - START.getTime() });
    const a = url.endsWith("/v1/app/ping") ? ping() : event();
    const headers = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } };
  };
  const reporter = createReporter({
    fetchImpl, now: () => new Date(), prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage: createUsageDay({ now: () => new Date() }), setup: () => ({}), setupKnown: () => Promise.resolve(),
    firstRun: () => false, uptime: () => DAY,
  });
  return {
    reporter,
    /** When each ping went, from the start. */
    pings: () => tries.filter(t => t.url.endsWith("/v1/app/ping")).map(t => t.at),
    events: (kind: string) => tries.filter(t => t.kind === kind).map(t => t.at),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("the heartbeat after a 429", () => {
  it("is not sent again until its Retry-After has passed", async () => {
    let limited = true;
    const h = harness({ ping: () => (limited ? { status: 429, headers: { "Retry-After": "3600" } } : { status: 204 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(h.pings()).toHaveLength(1);
    limited = false;
    const first = h.pings()[0];
    // Four or five beats inside the hour, and none of them pings.
    await vi.advanceTimersByTimeAsync(first + 55 * MIN - Date.now() + START.getTime());
    expect(h.pings()).toHaveLength(1);
    // The first beat past the hour does, and the beats after it go on as before.
    await vi.advanceTimersByTimeAsync(BEAT + 5 * MIN);
    expect(h.pings().length).toBeGreaterThanOrEqual(2);
    expect(h.pings()[1] - first).toBeGreaterThanOrEqual(HOUR);
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    h.reporter.stop();
    expect(h.pings().length).toBeGreaterThanOrEqual(5);
  });

  it("waits for a Retry-After given as a date, and for a 503's", async () => {
    let limited = true;
    const until = new Date(START.getTime() + 2 * HOUR).toUTCString();
    const h = harness({ ping: () => (limited ? { status: 503, headers: { "Retry-After": until } } : { status: 204 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(h.pings()).toHaveLength(1);
    limited = false;
    await vi.advanceTimersByTimeAsync(2 * HOUR - BEAT - MIN);
    expect(h.pings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BEAT + MIN);
    h.reporter.stop();
    expect(h.pings().length).toBeGreaterThanOrEqual(2);
    expect(h.pings()[1]).toBeGreaterThanOrEqual(2 * HOUR);
  });

  it("waits a day at most, whatever the header asks", async () => {
    let limited = true;
    const h = harness({ ping: () => (limited ? { status: 429, headers: { "Retry-After": String(7 * 24 * 3600) } } : { status: 204 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(BEAT);
    limited = false;
    await vi.advanceTimersByTimeAsync(DAY - 2 * BEAT);
    expect(h.pings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    h.reporter.stop();
    expect(h.pings().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps beating when a 429 asks for no particular wait", async () => {
    const h = harness({ ping: () => ({ status: 429 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(6 * BEAT);
    h.reporter.stop();
    expect(h.pings().length).toBeGreaterThanOrEqual(5);
  });

  it("waits out a Retry-After a check-in was given, too", async () => {
    // A new UTC day owes an "active", and the API puts it off for an hour.
    let limited = true;
    const h = harness({
      lastActiveDay: "2026-10-03",
      event: () => (limited ? { status: 429, headers: { "Retry-After": "3600" } } : { status: 202 }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events("active")).toHaveLength(1);
    limited = false;
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(h.pings()).toHaveLength(0);
    expect(h.events("active")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BEAT + 5 * MIN);
    h.reporter.stop();
    expect(h.events("active")).toHaveLength(2);
    expect(h.pings().length).toBeGreaterThanOrEqual(1);
    expect(h.pings()[0]).toBeGreaterThanOrEqual(HOUR);
  });
});
