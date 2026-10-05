// A day this deck did not count events for in full says nothing about events
// (usage-day.mjs, reports.mjs).
//
// 3.36.9 saved the day's tally with no `events`: it did not count them. Read
// back as 0, the first "active" after an upgrade said events "0" for a day with
// sessions — impossible, since every session arrives as an event — and a deck
// upgraded mid-day added that 0 to the part of the day it did count, so the day
// came out low. A day whose events were not all counted here leaves `events`
// out, as a peak of 0 already leaves deckMemory out.
import { describe, it, expect } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const INSTALL = "11111111-2222-4333-8444-555555555555";

/** prefs.json's report as 3.36.9 left it: a day counted, with no events and no peak. */
function legacyReport(usage: Record<string, unknown>) {
  return {
    installId: INSTALL, lastVersion: "3.36.9", lastActiveDay: "2026-10-02",
    installedAt: "2026-09-01T00:00:00.000Z", firstSessionAt: "2026-09-01T00:01:00.000Z", firstProvider: "claude",
    activationSent: true, usage,
  };
}

/** A 3.37 deck booting at `at` over `report`, its API answering every event. */
function deckAt(at: string, report: Record<string, unknown>) {
  let clock = new Date(at);
  let held = normalise({ reports: true, report });
  const prefs = {
    current: () => held,
    update: async (m: (prev: typeof held) => Partial<typeof held> | undefined) => {
      held = normalise({ ...held, ...(m(held) ?? {}) });
      return held;
    },
  };
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: string, init: { body?: string }) => {
    sent.push(JSON.parse(init.body ?? "null"));
    return { ok: true, status: 202, headers: { get: () => null } };
  };
  const now = () => clock;
  const usage = createUsageDay({ now });
  const reporter = createReporter({
    fetchImpl, now, prefs, env: {}, usage, ready: Promise.resolve(), setupKnown: async () => {},
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22" },
  });
  reporter.restoreUsage();
  return {
    reporter, usage, prefs: () => held,
    active: () => sent.filter(b => b?.kind === "active"),
    at: (iso: string) => { clock = new Date(iso); },
  };
}

describe("a day 3.36.9 counted", () => {
  it("goes out with its sessions and no events, on the first check-in after the upgrade", async () => {
    const d = deckAt("2026-10-04T10:00:00Z", legacyReport({
      current: { day: "2026-10-03", sessions: 12, subagents: 3, projects: 2, features: ["claude-sessions"] }, done: null, sent: "2026-10-02",
    }));
    await d.reporter.checkIn();
    expect(d.active()).toHaveLength(1);
    expect(d.active()[0]).toMatchObject({ usageDay: "2026-10-03", sessions: 12, subagents: 3, projects: 2 });
    expect(d.active()[0]).not.toHaveProperty("events");
    expect(d.active()[0]).not.toHaveProperty("deckMemory");
  });

  it("is a day upgraded mid-way: what this deck counted is not the day, so no events go out for it", async () => {
    const d = deckAt("2026-10-03T15:00:00Z", { ...legacyReport({
      current: { day: "2026-10-03", sessions: 4, subagents: 0, projects: 1, features: ["claude-sessions"] }, done: null, sent: "2026-10-02",
    }), lastActiveDay: "2026-10-03" });
    for (let i = 0; i < 30; i++) d.usage.noteUse({ session_id: `s${i % 3}` });
    // The day carries on across another restart: what the save says survives it.
    await d.reporter.checkIn();
    const next = deckAt("2026-10-04T09:00:00Z", { ...d.prefs().report, lastVersion: "3.37.0" });
    await next.reporter.checkIn();
    expect(next.active()).toHaveLength(1);
    expect(next.active()[0]).toMatchObject({ usageDay: "2026-10-03", sessions: 7 });
    expect(next.active()[0]).not.toHaveProperty("events");
  });

  it("is not a day this deck counted in full: that one says its events, zero included", async () => {
    const d = deckAt("2026-10-03T00:30:00Z", { ...legacyReport({ current: null, done: null, sent: "2026-10-02" }), lastActiveDay: "2026-10-03", lastVersion: "3.37.0" });
    for (let i = 0; i < 30; i++) d.usage.noteUse({ session_id: `s${i % 3}` });
    d.at("2026-10-04T09:00:00Z");
    await d.reporter.checkIn();
    expect(d.active()[0]).toMatchObject({ usageDay: "2026-10-03", sessions: 3, events: "100" });

    const idle = deckAt("2026-10-04T09:00:00Z", { ...legacyReport({
      current: { day: "2026-10-03", sessions: 0, subagents: 0, projects: 0, features: [], events: 0, peakMb: 0 }, done: null, sent: "2026-10-02",
    }), lastVersion: "3.37.0" });
    await idle.reporter.checkIn();
    expect(idle.active()[0]).toMatchObject({ usageDay: "2026-10-03", sessions: 0, events: "0" });
  });
});
