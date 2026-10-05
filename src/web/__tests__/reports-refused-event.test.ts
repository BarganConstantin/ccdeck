// An event the API refuses is not sent again (reports.mjs).
//
// Since the heartbeat checks in whatever a check-in still owes, an install,
// update, "active", "activated" or "rated" the API answered with a 400, a 413
// or a 422 — a field it validates differently, say — went out again on every
// beat, about every ten minutes, for as long as the deck ran. The API will
// refuse the same body the same way every time, so its refusal — written as
// application/problem+json — is final for that event: it is not sent again.
// What is worth another try — no answer at all, a 5xx, a 408 or a 429, or a
// 4xx the edge answered with (reports-edge-refusal.test.ts) — is tried again on
// the heartbeat, less often the longer it keeps failing, and never sooner than
// a 429's Retry-After asks.
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
/** How the API writes a body it turns down: a ValidationProblem. */
const PROBLEM = { "Content-Type": "application/problem+json; charset=utf-8" };

type Answer = { status: number; headers?: Record<string, string> } | "offline";
type Sent = { url: string; body: Record<string, unknown>; at: number };

/** A reporter against an API that answers each event with `answer`, on a clock
 *  that moves with the fake timers, as a real one moves with real time. */
function harness({
  saved = {} as Record<string, unknown>,
  answer = (_body: Record<string, unknown>): Answer => ({ status: 202 }),
} = {}) {
  vi.useFakeTimers({ now: START });
  let prefs = normalise(saved);
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const tries: Sent[] = [];
  const fetchImpl = async (url: string, init: { body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith("/v1/app/ping")) return { ok: true, status: 204 };
    tries.push({ url, body, at: Date.now() });
    const a = answer(body);
    if (a === "offline") throw new Error("getaddrinfo ENOTFOUND api.ccdeck.dev");
    const headers = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } };
  };
  const usage = createUsageDay({ now: () => new Date() });
  const reporter = createReporter({
    fetchImpl, now: () => new Date(), prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage, setup: () => ({}), setupKnown: () => Promise.resolve(),
    firstRun: () => true, uptime: () => DAY,
  });
  return {
    reporter, usage, prefs: () => prefs,
    /** How many times an event of `kind` went to the API. */
    sent: (kind: string) => tries.filter(t => t.body.kind === kind).length,
    times: (kind: string) => tries.filter(t => t.body.kind === kind).map(t => t.at - START.getTime()),
    deletes: () => tries.filter(t => t.url.includes("/v1/app/installs/")).length,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("an event the API refuses", () => {
  it.each([400, 413, 422])("goes out once on a %i, and not again on later beats", async (status) => {
    const h = harness({ answer: b => (b.kind === "install" ? { status, headers: PROBLEM } : { status: 202 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(6 * BEAT);
    h.reporter.stop();
    expect(h.sent("install")).toBe(1);
    // Done with: the version is said, and the day's "active" went beside it.
    expect(h.prefs().report.lastVersion).toBe("3.37.0");
    expect(h.sent("active")).toBe(1);
  });

  it("is an update said once, not resent all day", async () => {
    const h = harness({
      saved: { report: { installId: "id-1", lastVersion: "3.36.0", lastActiveDay: "2026-10-04" } },
      answer: b => (b.kind === "update" ? { status: 400, headers: PROBLEM } : { status: 202 }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(6 * BEAT);
    h.reporter.stop();
    expect(h.sent("update")).toBe(1);
    expect(h.prefs().report.lastVersion).toBe("3.37.0");
  });

  it("is a refused 'active' given up for that day, and the next day's is sent", async () => {
    const h = harness({
      saved: { report: { installId: "id-1", lastVersion: "3.37.0", lastActiveDay: "2026-10-03" } },
      answer: b => (b.kind === "active" ? { status: 422, headers: PROBLEM } : { status: 202 }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(6 * BEAT);
    expect(h.sent("active")).toBe(1);
    expect(h.prefs().report.lastActiveDay).toBe("2026-10-04");
    await vi.advanceTimersByTimeAsync(DAY);
    h.reporter.stop();
    expect(h.sent("active")).toBe(2);
    expect(h.prefs().report.lastActiveDay).toBe("2026-10-05");
  });

  it("is an 'activated' or a 'rated' sent once", async () => {
    const h = harness({
      saved: {
        report: {
          installId: "id-1", lastVersion: "3.37.0", lastActiveDay: "2026-10-04",
          installedAt: "2026-10-04T09:00:00.000Z", firstSessionAt: "2026-10-04T09:30:00.000Z", firstProvider: "claude",
          rating: { score: 9 },
        },
      },
      answer: b => (b.kind === "activated" || b.kind === "rated" ? { status: 400, headers: PROBLEM } : { status: 202 }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(6 * BEAT);
    h.reporter.stop();
    expect(h.sent("activated")).toBe(1);
    expect(h.sent("rated")).toBe(1);
    expect(h.prefs().report.activationSent).toBe(true);
    expect(h.prefs().report.rating).toMatchObject({ score: 9, sent: true });
  });

  it("is not a deletion: that stays owed, asked again less and less often", async () => {
    // Switching off ends in a deletion, so one refused is never dropped — but
    // it is not asked for every ten minutes either.
    const h = harness({
      saved: { reports: false, report: { forget: "8d4b2c1e-0000-4000-8000-000000000001" } },
      answer: () => ({ status: 404, headers: PROBLEM }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    h.reporter.stop();
    expect(h.prefs().report.forget).toBe("8d4b2c1e-0000-4000-8000-000000000001");
    expect(h.deletes()).toBeGreaterThanOrEqual(4);
    expect(h.deletes()).toBeLessThan(12);
  });
});

describe("an event that did not get through", () => {
  it.each([
    ["no answer", "offline" as const],
    ["a 503", { status: 503 }],
    ["a 408", { status: 408 }],
    ["a 429", { status: 429 }],
  ])("is tried again after %s, less often the longer it fails", async (_what, failure) => {
    const h = harness({ answer: b => (b.kind === "install" ? failure : { status: 202 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    h.reporter.stop();
    const at = h.times("install");
    // Tried again — the first retry on the next beat, as before — but not on
    // all thirty beats of six hours: each wait is longer than the one before.
    expect(at.length).toBeGreaterThanOrEqual(4);
    expect(at.length).toBeLessThan(12);
    expect(at[1]).toBeLessThanOrEqual(BEAT);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(2 * gaps[0]);
    expect(h.prefs().report.lastVersion).toBe("");
  });

  it("goes out once the API answers again", async () => {
    let down = true;
    const h = harness({ answer: () => (down ? { status: 500 } : { status: 202 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    down = false;
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(h.prefs().report.lastVersion).toBe("3.37.0");
    expect(h.prefs().report.lastActiveDay).toBe("2026-10-04");
    // And it is said once: nothing goes again after it.
    const installs = h.sent("install");
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    h.reporter.stop();
    expect(h.sent("install")).toBe(installs);
  });

  it("waits as long as a 429's Retry-After asks", async () => {
    let limited = true;
    const h = harness({
      answer: b => (b.kind === "install" && limited ? { status: 429, headers: { "Retry-After": "3600" } } : { status: 202 }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sent("install")).toBe(1);
    limited = false;
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(h.sent("install")).toBe(1);
    await vi.advanceTimersByTimeAsync(BEAT + 5 * MIN);
    h.reporter.stop();
    expect(h.sent("install")).toBe(2);
    expect(h.prefs().report.lastVersion).toBe("3.37.0");
  });
});
