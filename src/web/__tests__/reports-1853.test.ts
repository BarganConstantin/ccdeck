// Anonymous reports, on unless the person switched them off (#1853).
//
// Nobody is asked, so what these pin is what the README and the switch's own
// note say instead: a deck reports from its first check-in under an id that is
// random and made there; switching it off forgets that id and deletes what was
// sent (and keeps asking until the deletion lands); switching it back on is a
// new install, not the old one recognised; the machine's veto beats the switch;
// and what does leave names nobody — no path, no address, no key.
//
// It was opt-in, behind a one-time question, for the first four commits of the
// same issue. The owner chose on-by-default on 2026-09-30, which is why the
// cases about a saved `false` matter more than they look: an upgrade must never
// turn back on what somebody turned off.
import { describe, it, expect } from "vitest";
import { DEFAULTS, normalise, publicPrefs, reportsVetoed } from "../../server/deck-prefs.mjs";
import {
  createReporter, installFacts, reportsOn, scrub,
  // @ts-expect-error — plain JS module, no types
} from "../../server/reports.mjs";

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };

const HOUR = 60 * 60 * 1000;

/** A prefs store in memory with the same shape as heldPrefs, and an API that records and answers. */
function harness({
  answer = 202, env = {} as Record<string, string>, day = "2026-09-30T10:00:00Z", version = "3.32.2",
  saved = {} as Record<string, unknown>,
} = {}) {
  let prefs = normalise(saved);
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
  const reporterWith = (over: { env?: Record<string, string>; version?: string } = {}) => createReporter({
    fetchImpl, now: () => clock, prefs: store, env: over.env ?? env,
    facts: { ...facts, version: over.version ?? version }, home: "/home/alice",
  });
  return {
    reporter: reporterWith(), reporterWith, calls, store,
    prefs: () => prefs,
    goOffline: () => { status = 0; },
    goOnline: () => { status = answer; },
    later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    nextDay: () => { clock = new Date(clock.getTime() + 24 * HOUR); },
    kinds: () => calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body?.kind),
  };
}

describe("a deck nobody has touched", () => {
  it("has reports on, and keeps a choice somebody saved", () => {
    expect(DEFAULTS.reports).toBe(true);
    expect(normalise({}).reports).toBe(true);
    expect(normalise({ reports: true }).reports).toBe(true);
    // The one that must survive every upgrade: off stays off.
    expect(normalise({ reports: false }).reports).toBe(false);
    // Only a real boolean is a choice; anything else reads as the default.
    for (const notAChoice of ["false", "no", 0, null, undefined, {}]) {
      expect(normalise({ reports: notAChoice }).reports, String(notAChoice)).toBe(true);
    }
  });

  it("counts as sending unless it was switched off or the machine said no", () => {
    expect(reportsOn(normalise({}), {})).toBe(true);
    expect(reportsOn(normalise({ reports: false }), {})).toBe(false);
    expect(reportsOn(normalise({}), { AGENTS_DECK_NO_REPORTS: "1" })).toBe(false);
  });

  it("never hands the page the install id", () => {
    const shown = publicPrefs({ reports: true, report: { installId: "secret-id" } });
    expect(shown.reports).toBe(true);
    expect(JSON.stringify(shown)).not.toContain("secret-id");
    expect(shown).not.toHaveProperty("report");
  });

  it("makes a random id at its first check-in and tells the API about the install and today", async () => {
    const h = harness();
    expect(h.prefs().report.installId).toBe("");

    await h.reporter.checkIn();

    const { installId } = h.prefs().report;
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.kinds()).toEqual(["install", "active"]);
    expect(h.calls.every(c => c.url.startsWith("https://api.ccdeck.dev/"))).toBe(true);
    // toEqual, not toMatchObject: the body is the whole of what leaves, and a
    // field added to it is a change to what the README promises.
    expect(h.calls[0].body).toEqual({
      installId, kind: "install", version: "3.32.2", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0",
    });
    expect(h.calls[1].body).toEqual({
      installId, kind: "active", version: "3.32.2", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0",
    });
  });

  it("has no id to report an error under before that check-in, so it reports none", async () => {
    // A request handler can throw before the prefs are read and the first
    // check-in has run. Making an id there would put an error on the API ahead
    // of the install it belongs to.
    const h = harness();

    expect(await h.reporter.reportError("server", new Error("boom"))).toBe(false);

    expect(h.calls).toEqual([]);
    expect(h.prefs().report.installId).toBe("");
  });

  it("gives two decks two ids", async () => {
    const a = harness();
    const b = harness();
    await a.reporter.checkIn();
    await b.reporter.checkIn();
    expect(a.prefs().report.installId).not.toBe(b.prefs().report.installId);
  });
});

describe("while reports are on", () => {
  it("says active at most once a day", async () => {
    const h = harness();
    await h.reporter.checkIn();

    await h.reporter.checkIn();
    await h.reporter.checkIn();
    expect(h.kinds()).toEqual(["install", "active"]);

    h.nextDay();
    await h.reporter.checkIn();
    await h.reporter.checkIn();
    expect(h.kinds()).toEqual(["install", "active", "active"]);
  });

  it("says an update once, with the version it came from, and under the same id", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const { installId } = h.prefs().report;

    const updated = h.reporterWith({ version: "3.33.0" });
    await updated.checkIn();
    await updated.checkIn();

    const updates = h.calls.filter(c => c.body?.kind === "update");
    expect(updates.length).toBe(1);
    expect(updates[0].body).toMatchObject({ installId, fromVersion: "3.32.2", version: "3.33.0" });
    expect(h.prefs().report.lastVersion).toBe("3.33.0");
    expect(h.kinds().filter(kind => kind === "install").length).toBe(1);
  });

  it("tries again later when the API cannot be reached", async () => {
    const h = harness();
    h.goOffline();
    await h.reporter.checkIn();
    // The id is kept — it is the deck's, not the API's — and nothing is marked
    // as said, so the install is not lost to a laptop that started on a train.
    const { installId } = h.prefs().report;
    expect(installId).not.toBe("");
    expect(h.prefs().report.lastVersion).toBe("");
    expect(h.prefs().report.lastActiveDay).toBe("");

    h.goOnline();
    await h.reporter.checkIn();
    expect(h.kinds().slice(-2)).toEqual(["install", "active"]);
    expect(h.calls.at(-1)?.body?.installId).toBe(installId);
    expect(h.prefs().report.lastVersion).toBe("3.32.2");
    expect(h.prefs().report.lastActiveDay).toBe("2026-09-30");
  });
});

describe("switching it off", () => {
  it("forgets the id and asks the API to delete everything it sent", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const { installId } = h.prefs().report;

    await h.reporter.setReports(false);

    expect(h.prefs().reports).toBe(false);
    expect(h.prefs().report).toEqual({ installId: "", lastVersion: "", lastActiveDay: "", forget: "" });
    expect(h.calls.at(-1)).toMatchObject({ method: "DELETE", url: `https://api.ccdeck.dev/v1/app/installs/${installId}` });
  });

  it("keeps asking for the deletion until it lands, even across a restart", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const { installId } = h.prefs().report;
    h.goOffline();

    await h.reporter.setReports(false);
    expect(h.prefs().report.forget).toBe(installId);
    await h.reporter.checkIn();
    expect(h.prefs().report.forget).toBe(installId);

    h.goOnline();
    // A restart is a new reporter over the same settings file.
    await h.reporterWith().checkIn();
    expect(h.calls.at(-1)).toMatchObject({ method: "DELETE", url: `https://api.ccdeck.dev/v1/app/installs/${installId}` });
    expect(h.prefs().report.forget).toBe("");
  });

  it("sends nothing more after it, and makes no new id", async () => {
    const h = harness();
    await h.reporter.checkIn();
    await h.reporter.setReports(false);
    const before = h.calls.length;

    h.nextDay();
    await h.reporter.checkIn();
    await h.reporterWith({ version: "3.33.0" }).checkIn();
    expect(await h.reporter.reportError("server", new Error("boom"))).toBe(false);

    expect(h.calls.length).toBe(before);
    expect(h.prefs().reports).toBe(false);
    expect(h.prefs().report.installId).toBe("");
  });

  it("is what a deck that starts with it off does too: nothing, and no id", async () => {
    // The upgrade case: somebody switched reports off in a version that had the
    // switch, and the next version starts over the same file.
    const h = harness({ saved: { reports: false } });

    await h.reporter.checkIn();
    expect(await h.reporter.reportError("server", new Error("boom"))).toBe(false);

    expect(h.calls).toEqual([]);
    expect(h.prefs().report.installId).toBe("");
  });

  it("makes a new id when it is switched back on, not the old one again", async () => {
    // Off deleted what was sent under the old id. Coming back under the same
    // one would join the new reports to a history the person was told is gone.
    const h = harness();
    await h.reporter.checkIn();
    const first = h.prefs().report.installId;
    await h.reporter.setReports(false);

    await h.reporter.setReports(true);

    const second = h.prefs().report.installId;
    expect(h.prefs().reports).toBe(true);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(h.calls.slice(-2).map(c => c.body)).toMatchObject([
      { installId: second, kind: "install" },
      { installId: second, kind: "active" },
    ]);
  });
});

describe("the machine's veto", () => {
  it("is AGENTS_DECK_NO_REPORTS, or AGENTS_DECK_NO_INSTALL", () => {
    expect(reportsVetoed({})).toBe(false);
    expect(reportsVetoed({ AGENTS_DECK_NO_REPORTS: "1" })).toBe(true);
    expect(reportsVetoed({ AGENTS_DECK_NO_INSTALL: "1" })).toBe(true);
  });

  it.each(["AGENTS_DECK_NO_REPORTS", "AGENTS_DECK_NO_INSTALL"])("%s sends nothing and makes no id, whatever the switch says", async name => {
    const env = { [name]: "1" };
    const h = harness({ env });
    expect(reportsOn(h.prefs(), env)).toBe(false);

    await h.reporter.checkIn();
    await h.reporter.setReports(true);
    expect(await h.reporter.reportError("server", new Error("boom"))).toBe(false);
    h.nextDay();
    await h.reporter.checkIn();

    expect(h.calls).toEqual([]);
    expect(h.prefs().report.installId).toBe("");
  });

  it("holds back a deletion too, and lets it go on a launch without the veto", async () => {
    // A deck that reported, then was started to stay off the network and had
    // reports switched off there: the deletion is a request like any other, so
    // it waits — and is not lost.
    const installId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const h = harness({
      env: { AGENTS_DECK_NO_REPORTS: "1" },
      saved: { reports: true, report: { installId, lastVersion: "3.32.2", lastActiveDay: "2026-09-30" } },
    });

    await h.reporter.setReports(false);
    expect(h.calls).toEqual([]);
    expect(h.prefs().report).toEqual({ installId: "", lastVersion: "", lastActiveDay: "", forget: installId });

    await h.reporterWith({ env: {} }).checkIn();
    expect(h.calls).toEqual([
      { method: "DELETE", url: `https://api.ccdeck.dev/v1/app/installs/${installId}`, body: undefined },
    ]);
    expect(h.prefs().report.forget).toBe("");
  });
});

describe("errors", () => {
  it("leave without paths, addresses or keys", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const { installId } = h.prefs().report;
    const error = new Error("EACCES: open '/home/alice/.claude/settings.json' for alice@example.com with sk-ant-api03-abcdefghijklmnop");
    error.stack = `${error.message}\n    at save (/home/alice/.npm/_npx/1/node_modules/ccdeck/src/server/atomic-write.mjs:40:3)`;

    expect(await h.reporter.reportError("server", error)).toBe(true);

    const sent = h.calls.at(-1);
    expect(sent?.url).toBe("https://api.ccdeck.dev/v1/app/errors");
    const text = JSON.stringify(sent?.body);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("example.com");
    expect(sent?.body).toMatchObject({ installId, where: "server", version: "3.32.2", os: "linux", arch: "x64", channel: "npm" });
    expect(String(sent?.body?.message)).toContain("~/.claude/settings.json");
    expect(String(sent?.body?.message)).toContain("<email>");
    expect(String(sent?.body?.message)).toContain("<secret>");
    expect(String(sent?.body?.stack)).toContain(".mjs:40:3");
  });

  it("send one message once an hour", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const start = h.calls.length;

    expect(await h.reporter.reportError("server", new Error("same"))).toBe(true);
    expect(await h.reporter.reportError("server", new Error("same"))).toBe(false);
    h.later(HOUR - 1000);
    expect(await h.reporter.reportError("server", new Error("same"))).toBe(false);
    expect(h.calls.length - start).toBe(1);

    h.later(2000);
    expect(await h.reporter.reportError("server", new Error("same"))).toBe(true);
    expect(h.calls.length - start).toBe(2);
  });

  it("send at most twenty an hour in all", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const start = h.calls.length;

    for (let i = 0; i < 30; i++) await h.reporter.reportError("web", new Error(`different ${i}`));
    expect(h.calls.length - start).toBe(20);

    // The hour is a window, not a lifetime: once it has passed, errors go again.
    h.later(HOUR + 1000);
    expect(await h.reporter.reportError("web", new Error("an hour on"))).toBe(true);
    expect(h.calls.length - start).toBe(21);
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
