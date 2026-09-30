// Anonymous reports, sent only when the person said yes (#1853).
//
// What these pin is the promise the question makes: nothing leaves before a
// yes, a no deletes what was sent (and keeps asking until the deletion lands),
// the machine's veto beats the person's yes, and what does leave names nobody —
// no path, no address, no key, and an id that is random and belongs to the yes.
import { describe, it, expect } from "vitest";
import { DEFAULTS, normalise, publicPrefs, reportsVetoed } from "../../server/deck-prefs.mjs";
import {
  createReporter, installFacts, reportsOn, scrub,
  // @ts-expect-error — plain JS module, no types
} from "../../server/reports.mjs";

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };

/** A prefs store in memory with the same shape as heldPrefs, and an API that records and answers. */
function harness({ answer = 202, env = {} as Record<string, string>, day = "2026-09-30T10:00:00Z", version = "3.32.2" } = {}) {
  let prefs = normalise({});
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: Call[] = [];
  let status = answer;
  let clock = new Date(day);
  const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (status === 0) throw new Error("offline");
    return { ok: status >= 200 && status < 300, status };
  };
  const facts = { version, os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" };
  const reporter = createReporter({ fetchImpl, now: () => clock, prefs: store, env, facts, home: "/home/alice" });
  return {
    reporter, calls, store,
    prefs: () => prefs,
    goOffline: () => { status = 0; },
    goOnline: () => { status = answer; },
    nextDay: () => { clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000); },
    kinds: () => calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body?.kind),
  };
}

describe("before anybody answers", () => {
  it("has not been asked, and sends nothing", async () => {
    expect(DEFAULTS.reports).toBeNull();
    expect(normalise({}).reports).toBeNull();
    const h = harness();

    await h.reporter.checkIn();
    expect(await h.reporter.reportError("server", new Error("boom"))).toBe(false);

    expect(h.calls).toEqual([]);
  });

  it("keeps the three answers apart: never asked, yes and no", () => {
    expect(normalise({ reports: true }).reports).toBe(true);
    expect(normalise({ reports: false }).reports).toBe(false);
    expect(normalise({ reports: "yes" }).reports).toBeNull();
  });

  it("never hands the page the install id", () => {
    const shown = publicPrefs({ reports: true, report: { installId: "secret-id" } });
    expect(shown.reports).toBe(true);
    expect(JSON.stringify(shown)).not.toContain("secret-id");
    expect(shown).not.toHaveProperty("report");
  });
});

describe("saying yes", () => {
  it("makes a random id and tells the API about the install and today", async () => {
    const h = harness();

    await h.reporter.setReports(true);

    const { installId } = h.prefs().report;
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.kinds()).toEqual(["install", "active"]);
    expect(h.calls.every(c => c.url.startsWith("https://api.ccdeck.dev/"))).toBe(true);
    expect(h.calls[0].body).toEqual({
      installId, kind: "install", version: "3.32.2", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0",
    });
  });

  it("says active at most once a day, and an update once, with the version it came from", async () => {
    const h = harness();
    await h.reporter.setReports(true);

    await h.reporter.checkIn();
    await h.reporter.checkIn();
    expect(h.kinds()).toEqual(["install", "active"]);

    h.nextDay();
    await h.reporter.checkIn();
    expect(h.kinds()).toEqual(["install", "active", "active"]);

    const updated = createReporter({
      fetchImpl: async (url: string, init: { method: string; body?: string }) => {
        h.calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
        return { ok: true, status: 202 };
      },
      now: () => new Date("2026-10-02T09:00:00Z"),
      prefs: h.store, env: {}, facts: { ...installFacts(), version: "3.33.0" },
    });
    await updated.checkIn();
    const update = h.calls.find(c => c.body?.kind === "update");
    expect(update?.body).toMatchObject({ fromVersion: "3.32.2", version: "3.33.0" });
    expect(h.prefs().report.lastVersion).toBe("3.33.0");
  });

  it("tries again later when the API cannot be reached", async () => {
    const h = harness();
    h.goOffline();
    await h.reporter.setReports(true);
    expect(h.prefs().report.lastVersion).toBe("");

    h.goOnline();
    await h.reporter.checkIn();
    expect(h.kinds().slice(-2)).toEqual(["install", "active"]);
    expect(h.prefs().report.lastVersion).toBe("3.32.2");
  });
});

describe("saying no", () => {
  it("forgets the id and asks the API to delete everything it sent", async () => {
    const h = harness();
    await h.reporter.setReports(true);
    const { installId } = h.prefs().report;

    await h.reporter.setReports(false);

    expect(h.prefs().reports).toBe(false);
    expect(h.prefs().report).toEqual({ installId: "", lastVersion: "", lastActiveDay: "", forget: "" });
    expect(h.calls.at(-1)).toMatchObject({ method: "DELETE", url: `https://api.ccdeck.dev/v1/app/installs/${installId}` });
  });

  it("keeps asking for the deletion until it lands, even across a restart", async () => {
    const h = harness();
    await h.reporter.setReports(true);
    const { installId } = h.prefs().report;
    h.goOffline();

    await h.reporter.setReports(false);
    expect(h.prefs().report.forget).toBe(installId);

    h.goOnline();
    await h.reporter.checkIn();
    expect(h.calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(h.prefs().report.forget).toBe("");
  });

  it("sends nothing more after it", async () => {
    const h = harness();
    await h.reporter.setReports(true);
    await h.reporter.setReports(false);
    const before = h.calls.length;

    h.nextDay();
    await h.reporter.checkIn();
    await h.reporter.reportError("server", new Error("boom"));

    expect(h.calls.length).toBe(before);
  });
});

describe("the machine's veto", () => {
  it("is AGENTS_DECK_NO_REPORTS, or AGENTS_DECK_NO_INSTALL", () => {
    expect(reportsVetoed({})).toBe(false);
    expect(reportsVetoed({ AGENTS_DECK_NO_REPORTS: "1" })).toBe(true);
    expect(reportsVetoed({ AGENTS_DECK_NO_INSTALL: "1" })).toBe(true);
  });

  it("wins over a yes, and holds back a deletion too", async () => {
    const h = harness({ env: { AGENTS_DECK_NO_REPORTS: "1" } });

    await h.reporter.setReports(true);
    expect(reportsOn(h.prefs(), { AGENTS_DECK_NO_REPORTS: "1" })).toBe(false);
    await h.reporter.setReports(false);

    expect(h.calls).toEqual([]);
    expect(h.prefs().report.forget).not.toBe("");
  });
});

describe("errors", () => {
  it("leave without paths, addresses or keys", async () => {
    const h = harness();
    await h.reporter.setReports(true);
    const error = new Error("EACCES: open '/home/alice/.claude/settings.json' for alice@example.com with sk-ant-api03-abcdefghijklmnop");
    error.stack = `${error.message}\n    at save (/home/alice/.npm/_npx/1/node_modules/ccdeck/src/server/atomic-write.mjs:40:3)`;

    expect(await h.reporter.reportError("server", error)).toBe(true);

    const sent = h.calls.at(-1);
    expect(sent?.url).toBe("https://api.ccdeck.dev/v1/app/errors");
    const text = JSON.stringify(sent?.body);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("sk-ant");
    expect(sent?.body).toMatchObject({ where: "server", version: "3.32.2", os: "linux", channel: "npm" });
    expect(String(sent?.body?.message)).toContain("~/.claude/settings.json");
  });

  it("send one message once an hour, and at most twenty an hour in all", async () => {
    const h = harness();
    await h.reporter.setReports(true);
    const start = h.calls.length;

    await h.reporter.reportError("server", new Error("same"));
    await h.reporter.reportError("server", new Error("same"));
    for (let i = 0; i < 30; i++) await h.reporter.reportError("web", new Error(`different ${i}`));

    expect(h.calls.length - start).toBe(20);
  });
});

describe("scrubbing", () => {
  it.each([
    ["/home/alice/x", "~/x"],
    ["/Users/Bob/Library/ccdeck", "~/Library/ccdeck"],
    ["C:\\Users\\Bob Smith\\AppData\\ccdeck", "~\\AppData\\ccdeck"],
    ["mail bob@example.org now", "mail <email> now"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", "<secret>"],
    ["a plain message 42", "a plain message 42"],
  ])("%s → %s", (input, output) => {
    expect(scrub(input, "/nowhere")).toBe(output);
  });

  it("replaces this user's own home wherever it is", () => {
    expect(scrub("/srv/homes/alice/work failed", "/srv/homes/alice")).toBe("~/work failed");
  });
});

describe("what an install says about itself", () => {
  it("is the version, the system, the channel and the runtime, nothing else", () => {
    const facts = installFacts({ version: "3.32.2", platform: "darwin", arch: "arm64", versions: { node: "22.18.0" }, env: { CCDECK_APP: "1" } });
    expect(facts).toEqual({ version: "3.32.2", os: "darwin", arch: "arm64", channel: "desktop", runtime: "node-22.18.0" });
    expect(installFacts({ versions: { node: "22.18.0", electron: "42.11.6" }, env: {} })).toMatchObject({ channel: "npm", runtime: "electron-42.11.6" });
  });
});
