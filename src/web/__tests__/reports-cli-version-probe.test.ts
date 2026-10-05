// When the reports learn the Claude Code and Codex versions (reports.mjs,
// cli-versions.mjs).
//
// The probe used to start on the first report's facts, which then went out
// with what it had so far: nothing. Install and update are only ever sent at a
// boot, and a deck started each day sends its day's "active" at a boot too, so
// for most decks the versions never left at all. And the probe ran once per
// process, so a deck left running for a week went on reporting the Claude Code
// it booted with while Claude Code updated itself underneath.
//
// Now the probe starts with the reporter, the first report waits a few
// seconds for it, and it is asked again on each new UTC day before that day's
// "active" goes out.
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const DAY = 24 * 60 * 60 * 1000;

/** A reporter whose CLI probe answers `installed` after `takes` ms. */
function harness({
  saved = {} as Record<string, unknown>, env = {} as Record<string, string>, takes = 20,
} = {}) {
  let prefs = normalise(saved);
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: Record<string, unknown>[] = [];
  let clock = new Date("2026-10-04T10:00:00Z");
  const fetchImpl = async (url: string, init: { body?: string }) => {
    if (url.endsWith("/v1/app/events") && init.body) calls.push(JSON.parse(init.body));
    return { ok: true, status: 202 };
  };
  /** What is on the machine right now, and what the probe last said. */
  let installed: Record<string, string> = { claudeVersion: "2.0.1", codexVersion: "0.40.0" };
  let known: Record<string, string> = {};
  let probes = 0;
  const probe = () => {
    probes++;
    const answer = { ...installed };
    return new Promise<void>(r => setTimeout(() => { known = answer; r(); }, takes));
  };
  const reporter = createReporter({
    fetchImpl, now: () => clock, prefs: store, env, home: "/home/alice", ready: Promise.resolve(),
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage: createUsageDay({ now: () => clock }), setup: () => ({}), setupKnown: () => Promise.resolve(),
    versions: () => known, probe, firstRun: () => true,
  });
  return {
    reporter, calls, probes: () => probes,
    update: (v: Record<string, string>) => { installed = { ...installed, ...v }; },
    later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    sent: (kind: string) => calls.filter(c => c.kind === kind),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("the first report", () => {
  it("waits for the probe the reporter started, so install and active carry the versions", async () => {
    const h = harness();
    h.reporter.start();
    await vi.waitFor(() => expect(h.sent("active")).toHaveLength(1));
    h.reporter.stop();
    expect(h.sent("install")[0]).toMatchObject({ claudeVersion: "2.0.1", codexVersion: "0.40.0" });
    expect(h.sent("active")[0]).toMatchObject({ claudeVersion: "2.0.1", codexVersion: "0.40.0" });
    expect(h.probes()).toBe(1);
  });

  it("carries them on an update sent at boot as well", async () => {
    const h = harness({ saved: { report: { installId: "id-1", lastVersion: "3.36.9", lastActiveDay: "2026-10-04" } } });
    await h.reporter.checkIn();
    expect(h.sent("update")[0]).toMatchObject({ fromVersion: "3.36.9", claudeVersion: "2.0.1" });
  });

  it("is not held back for long by a probe that does not answer", async () => {
    vi.useFakeTimers();
    const h = harness({ takes: 60 * 60 * 1000 });
    const done = h.reporter.checkIn();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    // Out on time, without the versions it could not learn.
    expect(h.sent("install")).toHaveLength(1);
    expect(h.sent("install")[0]).not.toHaveProperty("claudeVersion");
  });
});

describe("a deck left running", () => {
  it("asks again on a new day, and that day's active says the CLI it has now", async () => {
    const h = harness();
    await h.reporter.checkIn();
    expect(h.sent("active")[0]).toMatchObject({ claudeVersion: "2.0.1" });

    // Claude Code updates itself. The same day asks nothing more of it.
    h.update({ claudeVersion: "2.0.5" });
    h.later(60 * 60 * 1000);
    await h.reporter.checkIn();
    expect(h.probes()).toBe(1);

    h.later(DAY);
    await h.reporter.checkIn();
    expect(h.probes()).toBe(2);
    expect(h.sent("active")[1]).toMatchObject({ claudeVersion: "2.0.5", codexVersion: "0.40.0" });
  });
});

describe("a deck that is not reporting", () => {
  it("asks the CLIs nothing, switched off or vetoed", async () => {
    const off = harness({ saved: { reports: false } });
    const vetoed = harness({ env: { AGENTS_DECK_NO_REPORTS: "1" } });
    for (const h of [off, vetoed]) {
      h.reporter.start();
      await h.reporter.checkIn();
      await new Promise(r => setTimeout(r, 50));
      h.reporter.stop();
      expect(h.probes()).toBe(0);
      expect(h.calls).toEqual([]);
    }
  });
});
