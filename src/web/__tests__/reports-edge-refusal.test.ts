// A 4xx that is not the API's own word on the body is tried again (reports.mjs).
//
// api.ccdeck.dev sits behind Cloudflare. Besides the API's answers, the edge
// can answer on its own: a 403 for a challenge, a WAF rule or an IP with a poor
// name that day, a 404 while a tunnel is being moved, a 401 from a proxy on the
// way. None of those is a verdict on the body, and a try from the same machine
// an hour later can get through. Counted as a refusal, they made a once-only
// event — the install with its --ref, "activated", "rated" — final the moment
// the edge said no, and it never went out. Only the API's own refusal is
// final: a 400, 413 or 422 it writes as application/problem+json, which is how
// it answers a body it will not take.
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const START = new Date("2026-10-05T12:00:00Z");

type Answer = { status: number; type?: string };

/** A reporter whose API answers each event with `answer`, on a clock that moves
 *  with the fake timers. */
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
  const delivered: Record<string, unknown>[] = [];
  const tries: Record<string, unknown>[] = [];
  const fetchImpl = async (url: string, init: { body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith("/v1/app/ping")) return { ok: true, status: 204, headers: { get: () => null } };
    tries.push(body);
    const a = answer(body);
    const ok = a.status >= 200 && a.status < 300;
    if (ok) delivered.push(body);
    return { ok, status: a.status, headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? a.type ?? null : null) } };
  };
  const usage = createUsageDay({ now: () => new Date() });
  usage.restore(prefs.report.usage);
  const reporter = createReporter({
    fetchImpl, now: () => new Date(), prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage, setup: () => ({}), setupKnown: () => Promise.resolve(),
    reference: () => "guides-first-run", firstRun: () => true, uptime: () => HOUR,
  });
  return {
    reporter, prefs: () => prefs,
    tried: (kind: string) => tries.filter(b => b.kind === kind).length,
    delivered: (kind: string) => delivered.filter(b => b.kind === kind),
  };
}

afterEach(() => { vi.useRealTimers(); });

/** What the edge, not the API, says now and then. */
const EDGE: [string, Answer][] = [
  ["a Cloudflare 403 challenge", { status: 403, type: "text/html; charset=UTF-8" }],
  ["a 404 from the tunnel", { status: 404, type: "text/html" }],
  ["a proxy's 401 with no body", { status: 401 }],
  ["a 409", { status: 409, type: "text/plain" }],
  ["a 400 that is not the API's", { status: 400, type: "text/html" }],
];

describe("a 4xx the edge made up", () => {
  it.each(EDGE)("keeps the install, and its ref, owed after %s, and sends both once the API answers", async (_what, edge) => {
    let blocked = true;
    const h = harness({ answer: () => (blocked ? edge : { status: 202 }) });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.tried("install")).toBe(1);
    // Not done with: the version is not said, and the page it came from is kept.
    expect(h.prefs().report.lastVersion).toBe("");
    expect(h.prefs().report.ref).toBe("guides-first-run");
    expect(h.prefs().report.lastActiveDay).toBe("");
    blocked = false;
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    h.reporter.stop();
    expect(h.delivered("install")).toHaveLength(1);
    expect(h.delivered("install")[0].ref).toBe("guides-first-run");
    expect(h.delivered("active")).toHaveLength(1);
    expect(h.prefs().report.lastVersion).toBe("3.37.0");
    expect(h.prefs().report.ref).toBe("");
  });

  it("keeps an answer to the question owed, and sends it once the API answers", async () => {
    let blocked = false;
    const h = harness({
      saved: {
        report: {
          installId: "8d4b2c1e-0000-4000-8000-000000000002", lastVersion: "3.37.0", lastActiveDay: "2026-10-05",
          usage: { daysUsed: 9, lastUsedDay: "2026-10-05" },
        },
      },
      answer: () => (blocked ? { status: 403, type: "text/html" } : { status: 202 }),
    });
    expect(h.reporter.ratingAsk()).toBe(true);
    blocked = true;
    expect(await h.reporter.rate(9)).toBe(true);
    expect(h.tried("rated")).toBe(1);
    expect(h.prefs().report.rating).toMatchObject({ score: 9, sent: false });
    // Answered is answered: the question is not asked again while it waits.
    expect(h.reporter.ratingAsk()).toBe(false);
    blocked = false;
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    h.reporter.stop();
    expect(h.delivered("rated")).toHaveLength(1);
    expect(h.delivered("rated")[0].score).toBe(9);
    expect(h.prefs().report.rating).toMatchObject({ score: 9, sent: true });
  });

  it("keeps the first session owed", async () => {
    let blocked = true;
    const h = harness({
      saved: {
        report: {
          installId: "8d4b2c1e-0000-4000-8000-000000000003", lastVersion: "3.37.0", lastActiveDay: "2026-10-05",
          installedAt: "2026-10-05T11:00:00.000Z", firstSessionAt: "2026-10-05T11:03:00.000Z", firstProvider: "codex",
        },
      },
      answer: b => (blocked && b.kind === "activated" ? { status: 403, type: "text/html" } : { status: 202 }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.tried("activated")).toBe(1);
    expect(h.prefs().report.activationSent).toBe(false);
    blocked = false;
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    h.reporter.stop();
    expect(h.delivered("activated")).toHaveLength(1);
    expect(h.prefs().report.activationSent).toBe(true);
  });
});

describe("the API's own refusal", () => {
  it.each([400, 413, 422])("is final on a %i it wrote as problem+json", async (status) => {
    const h = harness({
      answer: b => (b.kind === "install" ? { status, type: "application/problem+json; charset=utf-8" } : { status: 202 }),
    });
    h.reporter.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    h.reporter.stop();
    expect(h.tried("install")).toBe(1);
    expect(h.prefs().report.lastVersion).toBe("3.37.0");
  });
});
