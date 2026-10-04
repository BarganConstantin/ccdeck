// The question is asked once, even when an older deck writes the settings in
// between (reports.mjs, rating.mjs).
//
// A 3.36.x deck shares the data dir with this one — the desktop app before it
// updates, an `npx ccdeck@3.36.9` — and its normalise drops every key it does
// not know the first time it writes prefs.json: report.rating among them, and
// the days used. Back on this version the question read as never answered, was
// asked again after a week, and a second "rated" went out for the same
// install. The outcome is kept a second time beside prefs.json, where that
// write cannot reach it, and comes back from there.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter, ratingFile } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const INSTALL = "8d4b2c1e-0000-4000-8000-000000000004";
const NOW = new Date("2026-10-20T12:00:00Z");
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function dataDir() {
  const d = await mkdtemp(join(tmpdir(), "ccdeck-rating-"));
  dirs.push(d);
  return d;
}

type Prefs = ReturnType<typeof normalise>;

/** What a 3.36.9 deck writes back: its normalise keeps only the keys it knows
 *  (v3.36.9 deck-prefs.mjs normaliseReport, usage-day.mjs normaliseUsage). */
function writtenByOlderDeck(p: Prefs) {
  const r = p.report;
  return normalise({
    ...p,
    report: {
      installId: r.installId, lastVersion: r.lastVersion, lastActiveDay: r.lastActiveDay, forget: r.forget,
      usage: r.usage ? { current: r.usage.current, done: r.usage.done, sent: r.usage.sent } : null,
      installedAt: r.installedAt, firstSessionAt: r.firstSessionAt, firstProvider: r.firstProvider,
      activationSent: r.activationSent,
    },
  });
}

/** One run of this version over `saved`, with its outcome file in `dir`. */
function deck(saved: Prefs, dir: string, daysUsed: number, { down = false } = {}) {
  let prefs = saved;
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: Prefs) => Partial<Prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const rated: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: string, init: { body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (down) return { ok: false, status: 503, headers: { get: () => null } };
    if (body.kind === "rated") rated.push(body);
    return { ok: true, status: 202, headers: { get: () => null } };
  };
  const usage = createUsageDay({ now: () => NOW });
  usage.restore({ daysUsed, lastUsedDay: "2026-10-19" });
  const reporter = createReporter({
    fetchImpl, now: () => NOW, prefs: store, env: {}, ready: Promise.resolve(), setupKnown: async () => {},
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22" },
    usage, uptime: () => 60 * 60 * 1000, ratingKept: ratingFile(dir),
  });
  return { reporter, prefs: () => prefs, rated };
}

/** Booted as start() boots it: what was saved, merged in, then the check-in. */
async function boot(d: ReturnType<typeof deck>) {
  d.reporter.restoreUsage();
  await d.reporter.restoreRating?.();
  await d.reporter.checkIn();
}

const SAVED = normalise({
  reports: true,
  report: { installId: INSTALL, lastVersion: "3.37.0", lastActiveDay: "2026-10-20", usage: { daysUsed: 9, lastUsedDay: "2026-10-19" } },
});

describe("an older deck writing prefs.json in between", () => {
  it("does not bring an answered question back, nor send a second answer", async () => {
    const dir = await dataDir();
    const first = deck(SAVED, dir, 9);
    await boot(first);
    expect(first.reporter.ratingAsk()).toBe(true);
    expect(await first.reporter.rate(9)).toBe(true);
    expect(first.rated).toHaveLength(1);

    const after = writtenByOlderDeck(first.prefs());
    expect(after.report.rating.score).toBeNull();
    // A week and more of use later, on this version again.
    const again = deck(after, dir, 7);
    await boot(again);
    expect(again.reporter.ratingAsk()).toBe(false);
    expect(again.prefs().report.rating).toMatchObject({ score: 9, sent: true });
    expect(again.rated).toHaveLength(0);
  });

  it("still sends an answer that had not got out, once", async () => {
    const dir = await dataDir();
    // Answered while the API could not be reached: kept, and owed.
    const first = deck(SAVED, dir, 9, { down: true });
    await boot(first);
    expect(await first.reporter.rate(4)).toBe(true);
    expect(first.prefs().report.rating).toMatchObject({ score: 4, sent: false });
    const again = deck(writtenByOlderDeck(first.prefs()), dir, 9);
    await boot(again);
    expect(again.rated).toHaveLength(1);
    expect(again.rated[0].score).toBe(4);
    expect(again.prefs().report.rating).toMatchObject({ score: 4, sent: true });
    expect(again.reporter.ratingAsk()).toBe(false);
  });

  it("does not bring back a question put off twice", async () => {
    const dir = await dataDir();
    const first = deck(SAVED, dir, 9);
    await boot(first);
    expect(await first.reporter.rateLater()).toBe(true);
    expect(await first.reporter.rateLater()).toBe(true);
    const again = deck(writtenByOlderDeck(first.prefs()), dir, 60);
    await boot(again);
    expect(again.prefs().report.rating.later).toBe(2);
    expect(again.reporter.ratingAsk()).toBe(false);
  });

  it("is kept under the install it belongs to, and forgotten with it", async () => {
    const dir = await dataDir();
    const first = deck(SAVED, dir, 9);
    await boot(first);
    await first.reporter.rate(9);
    expect(JSON.parse(await readFile(join(dir, "rating.json"), "utf8"))).toMatchObject({ installId: INSTALL, rating: { score: 9, sent: true } });
    // Another install over the same folder is a new one: the answer is not its.
    const other = deck(normalise({ ...SAVED, report: { ...SAVED.report, installId: "8d4b2c1e-0000-4000-8000-000000000005" } }), dir, 9);
    await boot(other);
    expect(other.reporter.ratingAsk()).toBe(true);
    // Switching reports off forgets the id here — this file with it.
    await first.reporter.setReports(false);
    await expect(readFile(join(dir, "rating.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("comes back on start(), before the first check-in", async () => {
    const dir = await dataDir();
    const first = deck(SAVED, dir, 9);
    await boot(first);
    await first.reporter.rate(10);
    const again = deck(writtenByOlderDeck(first.prefs()), dir, 9);
    again.reporter.start();
    try {
      await vi.waitFor(() => expect(again.prefs().report.rating).toMatchObject({ score: 10, sent: true }), { timeout: 5000 });
    } finally {
      again.reporter.stop();
    }
    expect(again.reporter.ratingAsk()).toBe(false);
    expect(again.rated).toHaveLength(0);
  });
});
