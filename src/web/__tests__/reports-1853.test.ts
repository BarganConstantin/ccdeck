// Usage reports, on unless the person switched them off (#1853). They are NOT
// anonymous: every report carries a stable hashed device id (an identifier) and
// the server records the IP it arrives from.
//
// Nobody is asked, so what these pin is what the README says instead, and what
// the server still does with a `false` (saved by a deck that had Appearance's
// switch, gone since 2026-10-01): a deck reports from its first check-in under
// an install id that is random and made there; switching it off forgets that
// id and deletes what was sent (and keeps asking until the deletion lands);
// switching it back on is a new install, not the old one recognised; the
// machine's veto beats the switch; and what does leave carries no path, no
// prompt, no file, no project name — but a device fingerprint rides along, so
// the reports name a machine.
//
// The fingerprint was opt-in behind AGENTS_DECK_FINGERPRINT for a few commits of
// the same issue; the owner made it always-on on 2026-09-30, the same day the
// reports went on by default — which is why the cases about a saved `false`
// matter more than they look: an upgrade must never turn back on what somebody
// turned off.
import { Readable } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import { DEFAULTS, normalise, publicPrefs, reportsVetoed } from "../../server/deck-prefs.mjs";
import {
  createReporter, deviceIdToken, installFacts, localeToken, reportsOn, scrub, shellToken, termToken,
  // @ts-expect-error — plain JS module, no types
} from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { feedbackFacts, handleFeedback, handleFeedbackFacts } from "../../server/reports-routes.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

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
  // The day's tally on the harness's own clock, so the suite never touches the
  // deck's.
  const tally = createUsageDay({ now: () => clock });
  const reporterWith = (over: {
    env?: Record<string, string>; version?: string;
    usage?: unknown; versions?: () => unknown; setup?: () => unknown;
    facts?: Record<string, unknown>; ready?: Promise<unknown>;
  } = {}) => createReporter({
    fetchImpl, now: () => clock, prefs: store, env: over.env ?? env,
    facts: { ...facts, version: over.version ?? version, ...(over.facts ?? {}) }, home: "/home/alice",
    ...(over.ready ? { ready: over.ready } : {}),
    usage: over.usage ?? tally,
    ...(over.setup ? { setup: over.setup } : {}),
    ...(over.versions ? { versions: over.versions } : {}),
  });
  return {
    reporter: reporterWith(), reporterWith, calls, store, tally,
    newTally: () => createUsageDay({ now: () => clock }),
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

describe("the coarse usage counts", () => {
  const bodyOf = (h: ReturnType<typeof harness>, kind: string) =>
    h.calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body).filter(b => b?.kind === kind).at(-1);
  const COUNTS = ["usageDay", "sessions", "subagents", "projects"];
  /** One day's use: two sessions (one heard from twice), a subagent, two projects. */
  const useADay = (t: ReturnType<typeof createUsageDay>) => {
    t.noteUse({ session_id: "s1" });
    t.noteUse({ session_id: "s1", agent_id: "a1" });
    t.noteUse({ session_id: "s2" });
    t.noteProject("/home/alice/.claude/projects/-home-alice-shop/s1.jsonl");
    t.noteProject("/home/alice/.claude/projects/-home-alice-blog/s2.jsonl");
  };

  it("are the last finished day's totals, with its date, on the next day's 'active'", async () => {
    // Not what is live at the moment the report goes out: that moment is the
    // first check-in, at launch, before anybody has done anything — 24 of 33
    // reports said zero sessions in production on 2026-10-01.
    const h = harness();
    await h.reporter.checkIn();
    // A first day has no yesterday, so its "active" carries no counts at all.
    for (const k of COUNTS) expect(bodyOf(h, "active")).not.toHaveProperty(k);

    useADay(h.tally);
    h.nextDay();
    await h.reporter.checkIn();

    expect(bodyOf(h, "active")).toMatchObject({ usageDay: "2026-09-30", sessions: 2, subagents: 1, projects: 2 });
  });

  it("say which features were used that day, by name only", async () => {
    const h = harness();
    useADay(h.tally);
    h.tally.noteFeature("usage-history");
    h.nextDay();
    await h.reporter.checkIn();
    expect(bodyOf(h, "active")?.features).toEqual(["usage-history", "claude-sessions"]);

    // A day the deck ran and nothing was opened says so with an empty list.
    h.nextDay();
    await h.reporter.checkIn();
    expect(bodyOf(h, "active")?.features).toEqual([]);
  });

  it("ride on the 'active' report alone, never on install or update", async () => {
    const h = harness();
    useADay(h.tally);
    h.nextDay();
    await h.reporter.checkIn();
    expect(bodyOf(h, "active")).toMatchObject({ sessions: 2 });
    const install = bodyOf(h, "install")!;
    for (const k of COUNTS) expect(install).not.toHaveProperty(k);

    useADay(h.tally);
    h.nextDay();
    await h.reporterWith({ version: "3.33.0" }).checkIn();
    const update = bodyOf(h, "update")!;
    for (const k of COUNTS) expect(update).not.toHaveProperty(k);
  });

  it("go out once: the next day says its own totals, zero when nobody used the deck", async () => {
    const h = harness();
    useADay(h.tally);
    h.nextDay();
    await h.reporter.checkIn();
    expect(bodyOf(h, "active")).toMatchObject({ usageDay: "2026-09-30" });

    // The deck ran on the first of October and nothing was used.
    h.nextDay();
    await h.reporter.checkIn();
    expect(bodyOf(h, "active")).toMatchObject({ usageDay: "2026-10-01", sessions: 0, subagents: 0, projects: 0 });

    // A day the deck did not run at all is not a day: nothing is said for it.
    h.nextDay();
    h.nextDay();
    await h.reporter.checkIn();
    expect(bodyOf(h, "active")).toMatchObject({ usageDay: "2026-10-02", sessions: 0 });
  });

  it("are not lost when the 'active' cannot get through", async () => {
    const h = harness();
    useADay(h.tally);
    h.nextDay();
    h.goOffline();
    await h.reporter.checkIn();
    h.goOnline();
    await h.reporter.checkIn();
    expect(bodyOf(h, "active")).toMatchObject({ usageDay: "2026-09-30", sessions: 2 });
  });

  it("survive a restart, the saved day coming back as a floor", async () => {
    const h = harness();
    await h.reporter.checkIn();
    useADay(h.tally);
    await h.reporter.saveUsage();

    // What prefs.json keeps is counts and days — no session id, no subagent id, no path.
    const saved = JSON.stringify(h.prefs().report.usage);
    for (const secret of ["s1", "s2", "a1", "alice", "shop", "jsonl"]) expect(saved).not.toContain(secret);

    // The deck restarts the same day; a new session after it counts on top.
    const after = h.newTally();
    const restarted = h.reporterWith({ usage: after });
    restarted.restoreUsage();
    after.noteUse({ session_id: "s3" });
    h.nextDay();
    await restarted.checkIn();

    expect(bodyOf(h, "active")).toMatchObject({ usageDay: "2026-09-30", sessions: 3, subagents: 1, projects: 2 });
  });

  it("are not saved while reports are off, and switching off drops what was saved", async () => {
    const h = harness();
    await h.reporter.checkIn();
    useADay(h.tally);
    await h.reporter.saveUsage();
    expect(h.prefs().report.usage).not.toBeNull();

    await h.reporter.setReports(false);
    expect(h.prefs().report.usage).toBeNull();
    h.tally.noteUse({ session_id: "s9" });
    await h.reporter.saveUsage();
    expect(h.prefs().report.usage).toBeNull();
  });

  it("keep only whole counts of zero or more", async () => {
    const h = harness();
    const usage = { ...h.tally, finished: () => ({ day: "2026-09-29", sessions: 2.5, subagents: -1, projects: 4 }) };
    await h.reporterWith({ usage }).checkIn();
    const active = bodyOf(h, "active")!;
    expect(active).toMatchObject({ usageDay: "2026-09-29", projects: 4 });
    expect(active).not.toHaveProperty("sessions");   // not a whole number
    expect(active).not.toHaveProperty("subagents");  // below zero
  });

  it("never carry a day that is not finished yet", async () => {
    const h = harness();
    const usage = { ...h.tally, finished: () => ({ day: "2026-09-30", sessions: 4 }) };
    await h.reporterWith({ usage }).checkIn();
    for (const k of COUNTS) expect(bodyOf(h, "active")).not.toHaveProperty(k);
  });

  it("never let the tally break the report", async () => {
    const h = harness();
    const usage = { ...h.tally, finished: () => { throw new Error("tally blew up"); } };
    await h.reporterWith({ usage }).checkIn();
    // The active still went out — just without any counts.
    expect(h.kinds()).toEqual(["install", "active"]);
    for (const k of COUNTS) expect(bodyOf(h, "active")).not.toHaveProperty(k);
  });

  it("are read only when an 'active' is actually due", async () => {
    const h = harness();
    let asked = 0;
    const usage = { ...h.tally, finished: (day: string) => { asked++; return h.tally.finished(day); } };
    const rep = h.reporterWith({ usage });
    await rep.checkIn();
    expect(asked).toBe(1);
    // Same day, nothing new to say: the tally is not asked again.
    await rep.checkIn();
    expect(asked).toBe(1);
    h.nextDay();
    await rep.checkIn();
    expect(asked).toBe(2);
  });
});

describe("uninstall: an install leaving", () => {
  const sent = (h: ReturnType<typeof harness>) =>
    h.calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body).filter(b => b?.kind === "uninstall");

  it("says so once asked, with the reason picked and the usual facts", async () => {
    const h = harness();
    await h.reporter.checkIn();
    expect(await h.reporter.willReport()).toBe(true);
    expect(await h.reporter.reportUninstall("too-noisy")).toBe(true);
    expect(sent(h)[0]).toMatchObject({ kind: "uninstall", reason: "too-noisy", version: "3.32.2", installId: h.prefs().report.installId });
    // The id stays: running the deck again later is the same install coming back.
    expect(h.prefs().report.installId).not.toBe("");
  });

  it("sends a reason only off the list, and none at all when none was picked", async () => {
    const h = harness();
    await h.reporter.checkIn();
    await h.reporter.reportUninstall("I hate it /home/alice");
    await h.reporter.reportUninstall(null);
    for (const body of sent(h)) expect(body).not.toHaveProperty("reason");
  });

  it("sends nothing with reports off, under the veto, or before there is an id", async () => {
    const off = harness({ saved: { reports: false } });
    const vetoed = harness({ env: { AGENTS_DECK_NO_REPORTS: "1" }, saved: { report: { installId: "id-1" } } });
    const fresh = harness();
    for (const h of [off, vetoed, fresh]) {
      expect(await h.reporter.willReport()).toBe(false);
      expect(await h.reporter.reportUninstall("broken")).toBe(false);
      expect(sent(h)).toEqual([]);
    }
  });
});

describe("activation: did a new install work", () => {
  const events = (h: ReturnType<typeof harness>, kind: string) =>
    h.calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body).filter(b => b?.kind === kind);
  const SETUP = () => ({ claudeHooks: "ok", codexWatch: "off" });

  it("says what the boot set up on install, update and active — never on a ping or an error", async () => {
    const h = harness();
    const rep = h.reporterWith({ setup: SETUP });
    await rep.checkIn();
    for (const kind of ["install", "active"]) {
      expect(events(h, kind)[0]).toMatchObject({ claudeHooks: "ok", codexWatch: "off" });
    }
    await h.reporterWith({ setup: SETUP, version: "3.33.0" }).checkIn();
    expect(events(h, "update")[0]).toMatchObject({ claudeHooks: "ok" });

    await rep.ping();
    await rep.reportError("server", new Error("boom"));
    for (const c of h.calls.filter(c => !c.url.endsWith("/v1/app/events"))) {
      expect(c.body).not.toHaveProperty("claudeHooks");
      expect(c.body).not.toHaveProperty("codexWatch");
    }
  });

  it("sends only the tokens it knows, and nothing while the boot has not said", async () => {
    const h = harness();
    await h.reporterWith({ setup: () => ({ claudeHooks: "maybe", codexWatch: "on" }) }).checkIn();
    expect(events(h, "install")[0]).not.toHaveProperty("claudeHooks");
    expect(events(h, "install")[0]).toMatchObject({ codexWatch: "on" });
    const quiet = harness();
    await quiet.reporterWith({ setup: () => { throw new Error("no"); } }).checkIn();
    expect(events(quiet, "install")[0]).not.toHaveProperty("codexWatch");
  });

  it("says a new install's first session once, with how long after the install it came", async () => {
    const h = harness();
    const rep = h.reporterWith({ setup: SETUP });
    await rep.checkIn();
    expect(events(h, "activated")).toEqual([]);   // installed, nothing used yet

    h.later(3 * 60 * 1000);
    h.tally.noteUse({ session_id: "s1" });
    await rep.sendActivation();
    await rep.sendActivation();
    await rep.checkIn();

    const sent = events(h, "activated");
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ firstSession: "5m", firstProvider: "claude", claudeHooks: "ok", version: "3.32.2" });
    // A bucket leaves, never the times: those stay in prefs.json.
    expect(JSON.stringify(sent[0])).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(h.prefs().report.installedAt).toMatch(/^2026-09-30T10:00/);
    expect(h.prefs().report.firstSessionAt).toMatch(/^2026-09-30T10:03/);
  });

  it("buckets a slow start, and names a Codex one", async () => {
    const h = harness();
    const rep = h.reporterWith();
    await rep.checkIn();
    h.later(3 * HOUR);
    h.tally.noteUse({ session_id: "c1", provider: "codex" });
    await rep.sendActivation();
    expect(events(h, "activated")[0]).toMatchObject({ firstSession: "1d", firstProvider: "codex" });
  });

  it("dates a session that came before the first check-in had an id when it happened", async () => {
    const h = harness();
    h.tally.noteUse({ session_id: "s1" });
    h.later(20 * 60 * 1000);   // the first check-in is late: offline at launch
    await h.reporter.checkIn();
    expect(events(h, "activated")[0]).toMatchObject({ firstSession: "5m" });
  });

  it("tries again at the next check-in when the API cannot be reached", async () => {
    const h = harness();
    await h.reporter.checkIn();
    h.tally.noteUse({ session_id: "s1" });
    h.goOffline();
    await h.reporter.sendActivation();
    expect(h.prefs().report.activationSent).toBe(false);
    h.goOnline();
    await h.reporter.checkIn();
    expect(h.prefs().report.activationSent).toBe(true);
    expect(events(h, "activated").length).toBe(2);   // the failed try, then the one that landed
  });

  it("never measures an install from before it was tracked: its first session was long ago", async () => {
    const h = harness({ saved: { reports: true, report: { installId: "id-old", lastVersion: "3.32.2", lastActiveDay: "2026-09-29" } } });
    h.tally.noteUse({ session_id: "s1" });
    await h.reporter.checkIn();
    await h.reporter.sendActivation();
    expect(events(h, "activated")).toEqual([]);
  });

  it("sends nothing with reports off", async () => {
    const h = harness({ saved: { reports: false } });
    h.tally.noteUse({ session_id: "s1" });
    await h.reporter.checkIn();
    await h.reporter.sendActivation();
    expect(events(h, "activated")).toEqual([]);
  });
});

describe("the CLI versions", () => {
  const bodyOf = (h: ReturnType<typeof harness>, kind: string) =>
    h.calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body).find(b => b?.kind === kind);

  it("fold into every facts-carrying report once the probe knows them", async () => {
    const h = harness();
    await h.reporterWith({ versions: () => ({ claudeVersion: "1.2.3", codexVersion: "0.5.0-beta.1" }) }).checkIn();
    expect(bodyOf(h, "install")).toMatchObject({ claudeVersion: "1.2.3", codexVersion: "0.5.0-beta.1" });
    expect(bodyOf(h, "active")).toMatchObject({ claudeVersion: "1.2.3", codexVersion: "0.5.0-beta.1" });
  });

  it("are omitted while the probe has nothing, and a provider that throws is survived", async () => {
    const h = harness();
    await h.reporterWith({ versions: () => { throw new Error("not ready"); } }).checkIn();
    const install = bodyOf(h, "install")!;
    expect(install).not.toHaveProperty("claudeVersion");
    expect(install).not.toHaveProperty("codexVersion");
  });
});

describe("the heartbeat ping", () => {
  it("says it is still here, with the id and nothing else", async () => {
    const h = harness();
    await h.reporter.checkIn();            // makes an id, sends install + active
    const { installId } = h.prefs().report;
    const before = h.calls.length;

    await h.reporter.ping();

    const sent = h.calls.at(-1)!;
    expect(h.calls.length).toBe(before + 1);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://api.ccdeck.dev/v1/app/ping");
    // The whole of what a heartbeat carries: the id, and not one field more.
    expect(sent.body).toEqual({ installId });
    for (const k of ["version", "os", "arch", "channel", "runtime", "deviceId", "kind"]) {
      expect(sent.body).not.toHaveProperty(k);
    }
  });

  it("does not ping before an install id exists — the first check-in has not run", async () => {
    const h = harness();
    expect(h.prefs().report.installId).toBe("");

    await h.reporter.ping();

    expect(h.calls).toEqual([]);
    expect(h.prefs().report.installId).toBe(""); // and it never makes one
  });

  it("does not ping when reports are switched off", async () => {
    const h = harness();
    await h.reporter.checkIn();
    await h.reporter.setReports(false);
    const before = h.calls.length;

    await h.reporter.ping();

    expect(h.calls.length).toBe(before);
  });

  it("does not ping under the machine's veto, even with an id already saved", async () => {
    const env = { AGENTS_DECK_NO_REPORTS: "1" };
    const h = harness({
      env,
      saved: { reports: true, report: { installId: "id-1", lastVersion: "3.32.2", lastActiveDay: "2026-09-30" } },
    });

    await h.reporter.ping();

    expect(h.calls).toEqual([]);
  });

  it("a failed ping is dropped and never throws", async () => {
    const h = harness();
    await h.reporter.checkIn();
    h.goOffline();

    await expect(h.reporter.ping()).resolves.toBeUndefined();
  });

  it("beats on its own timer, apart from the six-hour check-in", async () => {
    vi.useFakeTimers();
    try {
      // An id already saved, on today's version and day, so the boot check-in is
      // a no-op and the only thing the timer produces is the ping.
      const h = harness({
        saved: { reports: true, report: { installId: "id-1", lastVersion: "3.32.2", lastActiveDay: "2026-09-30" } },
      });
      const rep = h.reporterWith({ ready: Promise.resolve() });

      rep.start();
      // PING_EVERY_MS (10m) + PING_JITTER_MS (2m) from reports.mjs: covers one
      // beat whatever the jitter, and never a second (its delay is ≥ 10m).
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 2 * 60 * 1000);

      const pings = h.calls.filter(c => c.url.endsWith("/v1/app/ping"));
      expect(pings.length).toBe(1);
      expect(pings[0].body).toEqual({ installId: "id-1" });
      rep.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the device fingerprint on the wire", () => {
  const bodyOf = (h: ReturnType<typeof harness>, kind: string) =>
    h.calls.filter(c => c.url.endsWith("/v1/app/events")).map(c => c.body).find(b => b?.kind === kind);

  it("rides on install, update and active — but never on a ping or an error", async () => {
    const id = "d1e2f3a4b5c6d7e8";
    const h = harness();
    const rep = h.reporterWith({ facts: { deviceId: id } });
    await rep.checkIn();

    expect(bodyOf(h, "install")).toMatchObject({ deviceId: id });
    expect(bodyOf(h, "active")).toMatchObject({ deviceId: id });

    // An update over the same install carries it too.
    const updated = h.reporterWith({ version: "3.33.0", facts: { deviceId: id } });
    await updated.checkIn();
    expect(bodyOf(h, "update")).toMatchObject({ deviceId: id });

    // The heartbeat carries the id alone.
    await rep.ping();
    expect(h.calls.filter(c => c.url.endsWith("/v1/app/ping")).at(-1)!.body).not.toHaveProperty("deviceId");

    // An error is not one of the events the fingerprint rides on.
    expect(await rep.reportError("server", new Error("boom"))).toBe(true);
    expect(h.calls.filter(c => c.url.endsWith("/v1/app/errors")).at(-1)!.body).not.toHaveProperty("deviceId");
  });
});

describe("switching it off", () => {
  it("forgets the id and asks the API to delete everything it sent", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const { installId } = h.prefs().report;

    await h.reporter.setReports(false);

    expect(h.prefs().reports).toBe(false);
    expect(h.prefs().report).toEqual({
      installId: "", lastVersion: "", lastActiveDay: "", forget: "", usage: null,
      installedAt: "", firstSessionAt: "", firstProvider: "", activationSent: false, ref: "", selfUpdate: null,
    });
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
    expect(h.prefs().report).toEqual({
      installId: "", lastVersion: "", lastActiveDay: "", forget: installId, usage: null,
      installedAt: "", firstSessionAt: "", firstProvider: "", activationSent: false, ref: "", selfUpdate: null,
    });

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
    // And the frame still says where: a scrubber that ate the path would leave a
    // stack nobody can use.
    expect(String(sent?.body?.stack)).toContain("at save (~/.npm/_npx/1/node_modules/ccdeck/src/server/atomic-write.mjs:40:3)");
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
  // Everything host- or env-derived is injected, so the whole of what leaves is
  // pinned rather than the machine the test happens to run on: a field added to
  // this shape is still a change to what the README promises.
  const controlled = {
    version: "3.32.2", platform: "darwin", arch: "arm64", versions: { node: "22.18.0" },
    env: { CCDECK_APP: "1" }, cpus: 10, memMb: 32768, locale: "en-US", shell: "zsh", term: "iTerm.app",
    // Injected so the whole shape stays pinned; its own derivation is tested below.
    deviceId: "0123456789abcdef",
  };

  it("is the version, the system, the channel, the runtime and the coarse environment", () => {
    expect(installFacts(controlled)).toEqual({
      version: "3.32.2", os: "darwin", arch: "arm64", channel: "desktop", runtime: "node-22.18.0",
      cpus: 10, memMb: 32768, locale: "en-US", shell: "zsh", term: "iTerm.app", deviceId: "0123456789abcdef",
    });
    expect(installFacts({ versions: { node: "22.18.0", electron: "42.11.6" }, env: {}, checkout: false })).toMatchObject({ channel: "npm", runtime: "electron-42.11.6" });
    // A deck run out of a git checkout is development, and says so.
    expect(installFacts({ env: {}, checkout: true }).channel).toBe("checkout");
    expect(installFacts({ env: { CCDECK_APP: "1" }, checkout: true }).channel).toBe("desktop");
  });

  it("counts the CPUs and the RAM, and never as anything but a whole number", () => {
    const facts = installFacts({ env: {} });
    expect(Number.isInteger(facts.cpus)).toBe(true);
    expect(facts.cpus).toBeGreaterThan(0);
    expect(Number.isInteger(facts.memMb)).toBe(true);
    expect(facts.memMb).toBeGreaterThan(0);
  });

  it("sends every string field as a token — no spaces, no paths, no free text", () => {
    // "Apple Terminal" is the one the API would reject as-is; it rides as a token.
    const facts = installFacts({
      ...controlled, env: {}, locale: undefined, shell: undefined, term: undefined,
      cpus: 4, memMb: 8000,
    });
    // Whatever the running machine resolved, each token matches the API's shape.
    const shape = /^[0-9A-Za-z.+_-]+$/;
    for (const key of ["locale", "shell", "term"] as const) {
      if (facts[key] !== undefined) {
        expect(String(facts[key]), key).toMatch(shape);
        expect(String(facts[key]), key).not.toContain(" ");
      }
    }
  });

  it("derives the locale, the shell and the terminal from the OS and the environment", () => {
    // Locale: the runtime's resolved value first, then LANG with the encoding off.
    expect(localeToken({ LANG: "de_DE.UTF-8" }, "")).toBe("de_DE");
    expect(localeToken({}, "en-GB")).toBe("en-GB");
    // Shell: the basename of $SHELL on POSIX; a Windows hint otherwise.
    expect(shellToken({ SHELL: "/usr/bin/zsh" }, "linux")).toBe("zsh");
    expect(shellToken({ PSModulePath: "C:\\x" }, "win32")).toBe("pwsh");
    expect(shellToken({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toBe("cmd");
    // Terminal: TERM_PROGRAM, tokenised; then Windows Terminal; then TERM.
    expect(termToken({ TERM_PROGRAM: "Apple Terminal" })).toBe("Apple_Terminal");
    expect(termToken({ WT_SESSION: "abc" })).toBe("Windows_Terminal");
    expect(termToken({ TERM: "xterm-256color" })).toBe("xterm-256color");
  });

  it("carries the CLI versions when known, tokenised, and omits them when not", () => {
    const withVersions = installFacts({ env: {}, claudeVersion: "1.2.3", codexVersion: "0.5.0-beta" });
    expect(withVersions).toMatchObject({ claudeVersion: "1.2.3", codexVersion: "0.5.0-beta" });
    // Not supplied → not sent. A field the deck cannot determine is simply absent.
    const bare = installFacts({ env: {} });
    expect(bare).not.toHaveProperty("claudeVersion");
    expect(bare).not.toHaveProperty("codexVersion");
  });

  it("carries a device fingerprint that is a hash-shaped token, stable, and never the machine in the clear", () => {
    // On by default now: installFacts computes it from the real machine — opaque,
    // hex, and the same on two calls, so it is stable across a restart.
    const a = installFacts({ env: {} });
    const b = installFacts({ env: {} });
    expect(a.deviceId).toMatch(/^[0-9a-f]{16}$/);        // an opaque hex token
    expect(a.deviceId).toMatch(/^[0-9A-Za-z.+_-]+$/);    // the API's token shape
    expect(String(a.deviceId).length).toBeLessThanOrEqual(64);
    expect(a.deviceId).not.toContain(" ");
    expect(b.deviceId).toBe(a.deviceId);                 // stable across calls
  });

  it("derives the fingerprint by a one-way hash of stable traits, hiding every one of them", () => {
    const traits = {
      platform: "linux", arch: "x64", cpuModel: "Test CPU @ 3.00GHz",
      cpuCount: 8, memBytes: 16 * 1024 ** 3, hostname: "alices-macbook",
    };
    const id = deviceIdToken(traits);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(deviceIdToken(traits)).toBe(id);              // same machine → same id
    // Non-reversible: nothing identifying survives in readable form.
    expect(id).not.toContain("alices-macbook");
    expect(id).not.toContain("Test CPU");
    // A different machine hashes to a different token — the hostname and any
    // single trait each change the whole of it.
    expect(deviceIdToken({ ...traits, hostname: "bobs-pc" })).not.toBe(id);
    expect(deviceIdToken({ ...traits, cpuCount: 4 })).not.toBe(id);
    expect(deviceIdToken({ ...traits, memBytes: 8 * 1024 ** 3 })).not.toBe(id);
  });
});

// Feedback is stored by the API and read by the people who make ccdeck, who may
// open a public issue from it. It used to become an issue by being sent, and the
// deck's server handed the page that issue's link; there is no link to hand now,
// and the page must not be given one the API happens to answer with.
describe("the feedback dialog's route", () => {
  function post(body: unknown) {
    const req = Readable.from([JSON.stringify(body)]);
    const res = {
      headersSent: false,
      status: 0,
      text: "",
      writeHead(status: number) { res.status = status; res.headersSent = true; },
      end(text: string) { res.text = text; },
    };
    return { req, res, answer: () => ({ status: res.status, body: JSON.parse(res.text) }) };
  }
  const MESSAGE = { kind: "idea", title: "A quieter chime", body: "The done chime is loud at night.", contact: " bob@example.org " };

  it("passes the message on with the version and the system, and answers that it arrived", async () => {
    const upstream: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = async (url: string, init: { body: string }) => {
      upstream.push({ url, body: JSON.parse(init.body) });
      // An API that still answered with a link must not get one to the page.
      return { status: 202, json: async () => ({ id: "fb_1", issue: "https://github.com/BarganConstantin/ccdeck/issues/1" }) };
    };
    const { req, res, answer } = post(MESSAGE);

    await handleFeedback(req, res, { fetchImpl, env: {} });

    expect(answer()).toEqual({ status: 200, body: { ok: true } });
    expect(upstream.length).toBe(1);
    expect(upstream[0].url).toBe("https://api.ccdeck.dev/v1/feedback");
    expect(upstream[0].body).toEqual({
      kind: "idea", title: "A quieter chime", body: "The done chime is loud at night.", contact: "bob@example.org",
      appVersion: installFacts({ env: {} }).version, platform: `${process.platform}-${process.arch}`,
    });
  });

  it("says before Send exactly what it adds to a report, and nothing more", async () => {
    // The dialog's line under the message — `ccdeck 3.36.0 · macOS · arm64` —
    // is drawn from this answer, which is the same function the post uses, so
    // the page never guesses at what is sent and cannot say something else.
    const answer = { status: 0, text: "" };
    const res = {
      headersSent: false,
      writeHead(status: number) { answer.status = status; res.headersSent = true; },
      end(text: string) { answer.text = text; },
    };
    await handleFeedbackFacts({}, res, { env: {} });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({
      ok: true, appVersion: installFacts({ env: {} }).version, platform: `${process.platform}-${process.arch}`,
    });
    // Two facts and no more: installFacts knows the channel, the runtime, a
    // locale and a device fingerprint, and none of them goes with feedback.
    expect(Object.keys(feedbackFacts({ env: {} })).sort()).toEqual(["appVersion", "platform"]);

    const upstream: Record<string, unknown>[] = [];
    const { req, res: postRes } = post(MESSAGE);
    await handleFeedback(req, postRes, {
      fetchImpl: async (_url: string, init: { body: string }) => { upstream.push(JSON.parse(init.body)); return { status: 202, json: async () => ({}) }; },
      env: {},
    });
    const { ok, ...said } = JSON.parse(answer.text);
    expect(ok).toBe(true);
    expect(upstream[0]).toMatchObject(said);
  });

  it("sends nothing from a deck started with AGENTS_DECK_NO_INSTALL=1", async () => {
    let asked = 0;
    const fetchImpl = async () => { asked++; return { status: 202, json: async () => ({}) }; };
    const { req, res, answer } = post(MESSAGE);

    await handleFeedback(req, res, { fetchImpl, env: { AGENTS_DECK_NO_INSTALL: "1" } });

    expect(answer()).toEqual({ status: 403, body: { ok: false, reason: "vetoed" } });
    expect(asked).toBe(0);
  });

  it("says so when the API is over its limit or cannot be reached", async () => {
    const busy = post(MESSAGE);
    await handleFeedback(busy.req, busy.res, { fetchImpl: async () => ({ status: 429, json: async () => ({}) }), env: {} });
    expect(busy.answer()).toEqual({ status: 429, body: { ok: false, reason: "too_many" } });

    const down = post(MESSAGE);
    await handleFeedback(down.req, down.res, { fetchImpl: async () => { throw new Error("offline"); }, env: {} });
    expect(down.answer()).toEqual({ status: 502, body: { ok: false, reason: "unavailable" } });
  });
});
