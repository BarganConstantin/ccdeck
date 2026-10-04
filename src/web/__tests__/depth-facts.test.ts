// How the deck holds up and who runs it, on the daily "active": the run's
// launch time, the usage day's peak memory and events taken in (buckets), the
// Claude and Codex plan (a category), the Claude accounts and paired machines
// (capped counts) — and, on an "update", how the new version arrived. Every
// value is a word off a fixed list or a small number; these pin the lists, the
// edges, what is read to learn them, and that a reading which fails costs the
// report nothing.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
import {
  CLAUDE_PLANS, CODEX_PLANS, COUNT_CAP, EVENT_BUCKETS, LAUNCH_BUCKETS, MEMORY_BUCKETS, SELF_UPDATE_FRESH_MS, UPDATE_VIAS,
  cappedCount, claudePlanToken, codexPlanToken, eventsBucket, launchBucket, memoryBucket, updateVia,
  // @ts-expect-error — plain JS module, no types
} from "../../server/depth-facts.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const HOUR = 60 * 60 * 1000;
const MB = 1024 * 1024;

describe("the buckets", () => {
  it("name each range by its upper edge, and match the API's lists", () => {
    // The API keeps the same words (ccdeck-api AppEventRequest); a word off
    // these lists is dropped there, so they must not drift.
    expect(LAUNCH_BUCKETS).toEqual(["1s", "2s", "5s", "10s", "30s", "later"]);
    expect(MEMORY_BUCKETS).toEqual(["128m", "256m", "512m", "1g", "2g", "more"]);
    expect(EVENT_BUCKETS).toEqual(["0", "100", "1k", "10k", "100k", "more"]);
    expect(CLAUDE_PLANS).toEqual(["free", "pro", "max", "max-5x", "max-20x", "team", "enterprise", "api"]);
    expect(CODEX_PLANS).toEqual(["free", "go", "plus", "pro", "pro-lite", "team", "business", "enterprise", "edu", "api"]);
    expect(UPDATE_VIAS).toEqual(["self-update", "desktop-updater", "npx", "npm", "checkout"]);
  });

  it("put a launch, a peak and a day's events where they belong", () => {
    expect([0, 1000, 1001, 2000, 4999, 10_000, 30_000, 30_001].map(launchBucket))
      .toEqual(["1s", "1s", "2s", "2s", "5s", "10s", "30s", "later"]);
    expect([40, 128, 129, 300, 600, 1500, 2048, 5000].map(memoryBucket))
      .toEqual(["128m", "128m", "256m", "512m", "1g", "2g", "2g", "more"]);
    expect([0, 1, 99, 100, 999, 1000, 99_999, 100_000].map(eventsBucket))
      .toEqual(["0", "100", "100", "1k", "1k", "10k", "100k", "more"]);
  });

  it("say nothing for what is not a measurement", () => {
    for (const bad of [-1, NaN, Infinity, "5", null, undefined]) {
      expect(launchBucket(bad), String(bad)).toBeUndefined();
      expect(memoryBucket(bad), String(bad)).toBeUndefined();
      expect(eventsBucket(bad), String(bad)).toBeUndefined();
    }
    expect(eventsBucket(2.5)).toBeUndefined();
  });

  it("cap the counts, and drop anything that is not one", () => {
    expect([0, 1, 7, COUNT_CAP, 999].map(cappedCount)).toEqual([0, 1, 7, COUNT_CAP, COUNT_CAP]);
    for (const bad of [-1, 1.5, "3", null, undefined]) expect(cappedCount(bad), String(bad)).toBeUndefined();
  });
});

describe("the plans", () => {
  it("are the Claude plan's category, and which Max, and nothing else", () => {
    expect(claudePlanToken({ subscriptionType: "pro" })).toBe("pro");
    expect(claudePlanToken({ subscriptionType: "Max", rateLimitTier: "default_claude_max_20x" })).toBe("max-20x");
    expect(claudePlanToken({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })).toBe("max-5x");
    expect(claudePlanToken({ subscriptionType: "max" })).toBe("max");
    expect(claudePlanToken({ subscriptionType: "team" })).toBe("team");
    // A type this deck does not know, or none, is not guessed at.
    expect(claudePlanToken({ subscriptionType: "galaxy" })).toBeUndefined();
    expect(claudePlanToken({})).toBeUndefined();
  });

  it("are the Codex plan's category, Pro Lite however OpenAI spells it", () => {
    expect(codexPlanToken("plus")).toBe("plus");
    expect(["prolite", "pro_lite", "pro-lite"].map(codexPlanToken)).toEqual(["pro-lite", "pro-lite", "pro-lite"]);
    expect(codexPlanToken("Business")).toBe("business");
    expect(codexPlanToken("api")).toBeUndefined();   // an API key is told by its mode, not a claim
    expect(codexPlanToken("mystery")).toBeUndefined();
    expect(codexPlanToken(null)).toBeUndefined();
  });
});

describe("how an update arrived", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  const fresh = { from: "3.36.9", at: "2026-10-05T09:00:00Z" };

  it("is the deck's own update when it wrote that it started one from this version", () => {
    expect(updateVia({ marker: fresh, lastVersion: "3.36.9", channel: "npm", npx: true, now })).toBe("self-update");
  });

  it("is the channel's way otherwise: a note from another version, or too old, does not count", () => {
    expect(updateVia({ marker: fresh, lastVersion: "3.36.8", channel: "npm", npx: true, now })).toBe("npx");
    const stale = { from: "3.36.9", at: new Date(now.getTime() - SELF_UPDATE_FRESH_MS - HOUR).toISOString() };
    expect(updateVia({ marker: stale, lastVersion: "3.36.9", channel: "npm", npx: false, now })).toBe("npm");
    expect(updateVia({ lastVersion: "3.36.9", channel: "desktop", now })).toBe("desktop-updater");
    expect(updateVia({ lastVersion: "3.36.9", channel: "checkout", now })).toBe("checkout");
    expect(updateVia({ lastVersion: "3.36.9", channel: "elsewhere", now })).toBeUndefined();
  });
});

/** A reporter on a clock and a prefs store of its own, with the API recorded. */
function harness({ channel = "npm", npx = false, depth = async () => ({}) as Record<string, unknown> } = {}) {
  let prefs = normalise({});
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let clock = new Date("2026-10-04T10:00:00Z");
  const fetchImpl = async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : {} });
    return { ok: true, status: 202 };
  };
  const tally = createUsageDay({ now: () => clock });
  let rss = 300 * MB;
  const make = (version: string) => createReporter({
    fetchImpl, now: () => clock, prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
    facts: { version, os: "linux", arch: "x64", channel, runtime: "node-22.18.0" },
    usage: tally, setup: () => ({ claudeHooks: "ok", codexWatch: "on" }), setupKnown: () => Promise.resolve(),
    depth, launchedIn: () => 1500, memory: () => rss, npx,
  });
  return {
    make, calls, tally, prefs: () => prefs,
    setRss: (bytes: number) => { rss = bytes; },
    nextDay: () => { clock = new Date(clock.getTime() + 24 * HOUR); },
    events: (kind: string) => calls.filter(c => c.url.endsWith("/v1/app/events") && c.body.kind === kind).map(c => c.body),
  };
}

describe("the daily report", () => {
  it("carries the run's launch, the day's load and peak, the plans and the counts", async () => {
    const h = harness({ depth: async () => ({ claudePlan: "max-20x", codexPlan: "plus", accounts: 3, machines: 1 }) });
    const r = h.make("3.37.0");
    r.start();   // the deck starts listening: the launch is read, memory sampled, and it checks in
    r.stop();
    await vi.waitFor(() => expect(h.events("active")).toHaveLength(1));
    h.setRss(700 * MB);
    for (let i = 0; i < 150; i++) h.tally.noteUse({ session_id: `s${i % 3}` });
    h.tally.notePeak(700);
    h.nextDay();
    await r.checkIn();

    const [first, second] = h.events("active");
    // The first day has no finished day yet: the run and the plans, no load.
    expect(first).toMatchObject({ launch: "2s", claudePlan: "max-20x", codexPlan: "plus", accounts: 3, machines: 1 });
    expect(first).not.toHaveProperty("events");
    expect(second).toMatchObject({ usageDay: "2026-10-04", events: "1k", deckMemory: "1g", launch: "2s", sessions: 3 });
  });

  it("drops a plan off the list and an absurd count, and loses nothing when the reading throws", async () => {
    const odd = harness({ depth: async () => ({ claudePlan: "galaxy", codexPlan: "plus", accounts: 5000, machines: -1 }) });
    await odd.make("3.37.0").checkIn();
    const [sent] = odd.events("active");
    expect(sent).not.toHaveProperty("claudePlan");
    expect(sent).toMatchObject({ codexPlan: "plus", accounts: 50 });
    expect(sent).not.toHaveProperty("machines");

    const broken = harness({ depth: async () => { throw new Error("keychain locked"); } });
    await broken.make("3.37.0").checkIn();
    expect(broken.events("active")).toHaveLength(1);
  });

  it("never says what the plan was read from", async () => {
    const h = harness({ depth: async () => ({ claudePlan: "pro" }) });
    await h.make("3.37.0").checkIn();
    const text = JSON.stringify(h.calls);
    for (const word of ["subscriptionType", "rateLimitTier", "accessToken", "email", "credentials"]) expect(text).not.toContain(word);
  });
});

describe("the update", () => {
  it("says the deck updated itself after it wrote so, then forgets the note", async () => {
    const h = harness({ npx: true });
    const old = h.make("3.36.9");
    await old.checkIn();
    await old.noteSelfUpdate();
    expect(h.prefs().report.selfUpdate).toMatchObject({ from: "3.36.9" });

    await h.make("3.37.0").checkIn();

    expect(h.events("update")).toEqual([expect.objectContaining({ fromVersion: "3.36.9", via: "self-update" })]);
    expect(h.prefs().report.selfUpdate).toBeNull();
  });

  it("says the channel's way when the deck did not start it", async () => {
    const npx = harness({ npx: true });
    await npx.make("3.36.9").checkIn();
    await npx.make("3.37.0").checkIn();
    expect(npx.events("update")[0]).toMatchObject({ via: "npx" });

    const desktop = harness({ channel: "desktop" });
    await desktop.make("3.36.9").checkIn();
    await desktop.make("3.37.0").checkIn();
    expect(desktop.events("update")[0]).toMatchObject({ via: "desktop-updater" });
  });

  it("is noted by every way the deck updates itself, handed in by the server", () => {
    const life = readFileSync(new URL("../../server/lifecycle.mjs", import.meta.url), "utf8");
    // The Upgrade press, the npx relaunch, and both branches of the away-update.
    expect(life.match(/selfUpdateStarted\(\);/g)?.length).toBe(4);
    expect(life).toContain("if (out.ok) selfUpdateStarted();");
    expect(life).toContain('if (mode === "npx") selfUpdateStarted();');
    expect(readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8")).toContain("onSelfUpdate: () => reporter.noteSelfUpdate()");
  });
});

describe("the day's tally", () => {
  it("keeps the day's highest memory and counts every live event", () => {
    let clock = new Date("2026-10-04T10:00:00Z");
    const t = createUsageDay({ now: () => clock });
    t.notePeak(300.4);
    t.notePeak(900);
    t.notePeak(450);
    t.notePeak(-5);
    for (let i = 0; i < 4; i++) t.noteUse({ session_id: "s1" });
    clock = new Date(clock.getTime() + 24 * HOUR);
    expect(t.finished("2026-10-05")).toMatchObject({ day: "2026-10-04", events: 4, peakMb: 900, sessions: 1 });
  });

  it("carries both across a restart: events added, the peak the higher of the two", () => {
    const at = new Date("2026-10-04T10:00:00Z");
    const before = createUsageDay({ now: () => at });
    before.noteUse({ session_id: "s1" });
    before.noteUse({ session_id: "s1" });
    before.notePeak(800);
    const t = createUsageDay({ now: () => at });
    t.notePeak(200);
    t.restore(before.saved());
    t.noteUse({ session_id: "s2" });
    expect(t.saved().current).toMatchObject({ events: 3, peakMb: 800 });
  });
});

describe("the deck's own readings", () => {
  it("read the plan's category from the files the CLIs keep, and the paired decks from the prefs", async () => {
    const root = mkdtempSync(join(tmpdir(), "depth-facts-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    mkdirSync(claudeDir);
    mkdirSync(codexDir);
    writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "sk-secret", subscriptionType: "max", rateLimitTier: "default_claude_max_5x" },
    }));
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const idToken = `${b64({ alg: "none" })}.${b64({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })}.sig`;
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", id_token: idToken } }));
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
    vi.stubEnv("CODEX_HOME", codexDir);
    vi.resetModules();
    try {
      const { deckDepth } = await import("../../server/depth-facts.mjs");
      const prefs = { lan: { trusted: [{ fp: "a" }, { fp: "b" }] } };
      expect(await deckDepth({ setup: { claudeHooks: "ok", codexWatch: "on" }, prefs, env: {} }))
        .toMatchObject({ claudePlan: "max-5x", codexPlan: "plus", machines: 2 });
      // Codex not watched, Claude switched off: neither file is read.
      expect(await deckDepth({ setup: { claudeHooks: "off", codexWatch: "off" }, prefs: null, env: {} }))
        .toMatchObject({ claudePlan: undefined, codexPlan: undefined, machines: undefined });
      // Bedrock is billed per token: an API plan, whatever the file says.
      expect((await deckDepth({ setup: {}, env: { CLAUDE_CODE_USE_BEDROCK: "1" } })).claudePlan).toBe("api");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
