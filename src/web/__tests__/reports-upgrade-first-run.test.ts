// Only a real first run is timed (reports.mjs, activation.mjs).
//
// The "activated" report says how long after the install its first session
// came, measured from `installedAt`, which is made with the install id. An
// install from before the reports existed (3.33 and older) has no id, so its
// first check-in on a version with them made one — and dated the install
// "now". Its first session this run then went out as a new install that
// activated within five minutes, for somebody who had used the deck for months.
//
// What tells a first run from an upgrade is the settings file: the boot read
// finds none on a machine the deck has never run on. Anything else — a LAN key,
// pairings, a tour seen, a file it could not read — is a deck that ran here
// before, and its install is not timed, the same way an id without
// `installedAt` never is.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";
import { rmTempDir } from "./rm-temp-dir";

function harness({ saved = {} as Record<string, unknown>, firstRun = true } = {}) {
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
  const fetchImpl = async (_url: string, init: { body?: string }) => {
    if (init.body) calls.push(JSON.parse(init.body));
    return { ok: true, status: 202 };
  };
  const tally = createUsageDay({ now: () => clock });
  const reporter = createReporter({
    fetchImpl, now: () => clock, prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage: tally, setup: () => ({}), setupKnown: () => Promise.resolve(),
    firstRun: () => firstRun,
  });
  return {
    reporter, tally, prefs: () => prefs,
    later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    kinds: () => calls.map(c => c.kind),
  };
}

/** What a 3.33 deck leaves in prefs.json: a LAN key, a pairing, the tour seen —
 *  and no report state at all, because there were no reports. */
const UPGRADER = {
  tourSeen: true,
  lan: { secret: "MC4CAQAwBQYDK2VwBCIEIA", trusted: [{ fp: "ab12", name: "laptop", pub: "cd34" }] },
};

describe("an install upgraded from a version without reports", () => {
  it("is reported as an install, but its first session here is not timed", async () => {
    const h = harness({ saved: UPGRADER, firstRun: false });
    await h.reporter.checkIn();
    expect(h.kinds()).toEqual(["install", "active"]);
    expect(h.prefs().report.installId).not.toBe("");
    expect(h.prefs().report.installedAt).toBe("");

    h.later(2 * 60 * 1000);
    h.tally.noteUse({ session_id: "s1" });
    await h.reporter.sendActivation();
    await h.reporter.checkIn();
    expect(h.kinds()).not.toContain("activated");
  });
});

describe("a real first run", () => {
  it("is timed from the moment its id is made", async () => {
    const h = harness({ firstRun: true });
    await h.reporter.checkIn();
    expect(h.prefs().report.installedAt).toBe("2026-10-04T10:00:00.000Z");

    h.later(2 * 60 * 1000);
    h.tally.noteUse({ session_id: "s1" });
    await h.reporter.sendActivation();
    expect(h.kinds()).toEqual(["install", "active", "activated"]);
  });
});

describe("what the boot read found", () => {
  const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-first-run-"));
  const was = process.env.CCDECK_HOME;
  afterAll(() => {
    if (was === undefined) delete process.env.CCDECK_HOME;
    else process.env.CCDECK_HOME = was;
    rmTempDir(SANDBOX);
  });

  /** prefs-state.mjs as a fresh boot imports it, over `dir`. */
  async function bootOver(dir: string) {
    if (!resolve(dir).startsWith(resolve(SANDBOX))) throw new Error("sandbox escaped");
    process.env.CCDECK_HOME = dir;
    vi.resetModules();
    // @ts-expect-error — plain JS module, no types
    const mod = await import("../../server/prefs-state.mjs");
    await mod.prefsRead;
    return mod;
  }

  it("says a first run only when there was no settings file at all", async () => {
    const empty = join(SANDBOX, "empty");
    mkdirSync(empty, { recursive: true });
    expect((await bootOver(empty)).bootFoundNoPrefs()).toBe(true);

    const used = join(SANDBOX, "used");
    mkdirSync(used, { recursive: true });
    writeFileSync(join(used, "prefs.json"), JSON.stringify(UPGRADER));
    expect((await bootOver(used)).bootFoundNoPrefs()).toBe(false);

    // A file it could not make sense of was still a deck that ran here.
    const corrupt = join(SANDBOX, "corrupt");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "prefs.json"), "{ not json");
    expect((await bootOver(corrupt)).bootFoundNoPrefs()).toBe(false);
  });
});
