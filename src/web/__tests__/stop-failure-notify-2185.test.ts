// #2185: sessions that stopped on a dead login, said once per incident.
//
// Every Claude Code session on a machine shares one login, so when it expires
// they all stop within seconds of each other — and with a page closed the user
// hears about none of them. The deck says it once for the whole incident, with
// how many stopped and what to type; and when the auto-switch tick it runs at
// once moves the account, the stop rides in the swap notice rather than beside
// it, so one incident is never two notifications.
//
// The real factory, with an injected clock, disk and OS call, as
// account-notify.test.ts drives it: nothing here raises a notification.
import { describe, it, expect } from "vitest";
import {
  createAccountNotifier, STOP_INCIDENT_MS, STOP_SESSIONS_MAX, stoppedNotice, withStopped,
} from "../../server/account-notify.mjs";

type Said = { title: string; body: string };
type Settings = { swap: boolean; quota: boolean; reset: boolean; stopped: boolean };

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const ALL_ON: Settings = { swap: true, quota: false, reset: false, stopped: true };

function harness({ settings = { ...ALL_ON } as Settings } = {}) {
  const said: Said[] = [];
  const clock = { now: T0 };
  const timers: { fn: () => void; ms: number }[] = [];
  const n = createAccountNotifier({
    notify: (title: string, body: string) => { said.push({ title, body }); },
    settings: () => settings,
    product: "ccdeck",
    now: () => clock.now,
    load: async () => null,
    save: async () => {},
    later: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return 0; },
    onError: (err: unknown) => { throw err; },
  });
  /** Fire every timer armed so far — the gather or the hold. */
  const fireTimers = () => { for (const t of timers.splice(0)) t.fn(); };
  return { n, said, clock, settings, timers, fireTimers };
}

const login = (sessionId: string, who: string, at: number) => ({ sessionId, who, kind: "login", at });
const limit = (sessionId: string, who: string, at: number) => ({ sessionId, who, kind: "usage-limit", at });

/** A tick that moved the account off personal@x.com, as summarise leaves it. */
const switched = () => ({
  ok: true, event: "switch", switched: true, reason: null, detail: null,
  from: { number: 2, email: "personal@x.com" }, to: { number: 3, email: "work@x.com" },
  active: { number: 2, email: "personal@x.com" }, threshold: 90,
  headroom: { "2": 7, "3": 70 }, windows: { "2": { "5h": 93, "7d": 40 } },
});
const nothing = (reason = "no-candidates") => ({ ok: true, event: "no-switch", switched: false, reason, threshold: 90 });
const ROSTER = {
  "2": { email: "personal@x.com", organizationUuid: "org-1" },
  "3": { email: "work@x.com", organizationUuid: "org-2", alias: "work" },
};

describe("what the stopped notice says", () => {
  it("counts the sessions, names a few, and says what to type", () => {
    expect(stoppedNotice({ names: ["vcrm-core", "api", "web"], count: 3, kinds: new Set(["login"]) })).toEqual({
      who: "3 Claude sessions stopped",
      body: "Login expired · vcrm-core, api and web. Type “continue” in each once a working login is active.",
    });
    expect(stoppedNotice({ names: ["vcrm-core"], count: 1, kinds: new Set(["usage-limit"]) })).toEqual({
      who: "1 Claude session stopped",
      body: "Usage limit reached · vcrm-core. Type “continue” in it once the limit resets or another account is active.",
    });
    expect(stoppedNotice({ names: ["a", "b", "c", "d", "e"], count: 5, kinds: new Set(["login", "usage-limit"]) }).body)
      .toBe("Login expired or usage limit reached · a, b, c and 2 more. Type “continue” in each once a working account is active.");
  });

  it("rides in a swap notice as one clause", () => {
    expect(withStopped({ who: "Claude auto-switch", body: "Switched to work · personal@x.com reached 90%" }, 3).body)
      .toBe("Switched to work · personal@x.com reached 90% · 3 sessions stopped, type “continue” in each");
  });
});

describe("an incident with no tick coming", () => {
  it("is gathered, then said once for every session in it", () => {
    const { n, said, timers, fireTimers } = harness();
    n.stopped(login("s-1", "vcrm-core", T0));
    n.stopped(login("s-2", "api", T0 + 800));
    n.stopped(login("s-3", "web", T0 + 1_900));
    expect(said, "said before the rest of the incident arrived").toEqual([]);
    expect(timers.map(t => t.ms), "armed more than once").toEqual([5_000]);
    fireTimers();
    expect(said).toEqual([{
      title: "3 Claude sessions stopped — ccdeck",
      body: "Login expired · vcrm-core, api and web. Type “continue” in each once a working login is active.",
    }]);
  });

  it("says nothing more for a straggler, or for a session stopping twice", () => {
    const { n, said, timers, fireTimers } = harness();
    n.stopped(login("s-1", "vcrm-core", T0));
    fireTimers();
    n.stopped(login("s-1", "vcrm-core", T0 + 30_000));
    n.stopped(login("s-4", "docs", T0 + 4 * 60_000));
    expect(timers).toEqual([]);
    expect(said).toHaveLength(1);
    expect(n.incident()!.ids.size).toBe(2);
  });

  it("starts a new incident when the login dies again later", () => {
    const { n, said, fireTimers } = harness();
    n.stopped(login("s-1", "vcrm-core", T0));
    fireTimers();
    n.stopped(login("s-1", "vcrm-core", T0 + STOP_INCIDENT_MS + 1));
    fireTimers();
    expect(said.map(s => s.title)).toEqual(["1 Claude session stopped — ccdeck", "1 Claude session stopped — ccdeck"]);
  });

  it("is about the two errors another login cures, and no other", () => {
    const { n, said, timers } = harness();
    n.stopped({ sessionId: "s-1", who: "vcrm-core", kind: "api-error", at: T0 });
    n.stopped({ sessionId: "", who: "x", kind: "login", at: T0 });
    expect(timers).toEqual([]);
    expect(n.incident()).toBeNull();
    expect(said).toEqual([]);
  });

  it("is said by its own switch alone", () => {
    const { n, said, fireTimers } = harness({ settings: { ...ALL_ON, stopped: false } });
    n.stopped(login("s-1", "vcrm-core", T0));
    fireTimers();
    expect(said).toEqual([]);
  });

  it("remembers a bounded number of sessions, from a post that needs no token", () => {
    const { n, fireTimers, said } = harness();
    for (let i = 0; i < STOP_SESSIONS_MAX + 50; i++) n.stopped(login(`s-${i}`, `p-${i}`, T0 + i));
    expect(n.incident()!.ids.size).toBe(STOP_SESSIONS_MAX);
    expect(n.incident()!.names.length).toBeLessThanOrEqual(STOP_SESSIONS_MAX);
    fireTimers();
    expect(said[0].title).toBe(`${STOP_SESSIONS_MAX} Claude sessions stopped — ccdeck`);
  });

  it("names a session with no name by its id", () => {
    const { n, said, fireTimers } = harness();
    n.stopped({ sessionId: "4f1c9e2a-0000", who: "", kind: "usage-limit", at: T0 });
    fireTimers();
    expect(said[0].body).toContain("· 4f1c9e2a.");
  });
});

describe("an incident while the auto-switch loop is on", () => {
  it("is held for the tick, and said inside the swap when the tick switched", async () => {
    const { n, said, timers, fireTimers } = harness();
    n.autoSwitch(true);
    n.stopped(login("s-1", "vcrm-core", T0));
    n.stopped(login("s-2", "api", T0 + 500));
    expect(timers.map(t => t.ms), "not held for the tick").toEqual([150_000]);
    await n.tick(switched(), ROSTER, { startedAt: T0 + 1_500 });
    expect(said).toEqual([{
      title: "Claude auto-switch — ccdeck",
      body: "Switched to work · personal@x.com reached 90% · 2 sessions stopped, type “continue” in each",
    }]);
    // The hold running out later says nothing: the incident was said.
    fireTimers();
    n.stopped(login("s-3", "web", T0 + 20_000));
    expect(said).toHaveLength(1);
  });

  it("is said on its own when the tick switched nothing", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    n.stopped(limit("s-1", "vcrm-core", T0));
    await n.tick(nothing(), null, { startedAt: T0 + 1_500 });
    expect(said).toEqual([{
      title: "1 Claude session stopped — ccdeck",
      body: "Usage limit reached · vcrm-core. Type “continue” in it once the limit resets or another account is active.",
    }]);
  });

  it("is said on its own through a cooldown too: the sessions are stopped already", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    n.stopped(login("s-1", "vcrm-core", T0));
    await n.tick(nothing("cooldown"), null, { startedAt: T0 + 1_500 });
    expect(said.map(s => s.title)).toEqual(["1 Claude session stopped — ccdeck"]);
  });

  it("waits past a tick that began before the stop, which cannot have seen it", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    n.stopped(login("s-1", "vcrm-core", T0));
    await n.tick(switched(), ROSTER, { startedAt: T0 - 2_000 });
    expect(said.map(s => s.body)).toEqual(["Switched to work · personal@x.com reached 90%"]);
    await n.tick(nothing(), null, { startedAt: T0 + 30_000 });
    expect(said.map(s => s.title)).toEqual(["Claude auto-switch — ccdeck", "1 Claude session stopped — ccdeck"]);
  });

  it("is said when the hold runs out with no tick at all", () => {
    const { n, said, fireTimers } = harness();
    n.autoSwitch(true);
    n.stopped(login("s-1", "vcrm-core", T0));
    fireTimers();
    expect(said.map(s => s.title)).toEqual(["1 Claude session stopped — ccdeck"]);
  });

  it("is said when the loop is turned off while it is held", () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    n.stopped(login("s-1", "vcrm-core", T0));
    n.autoSwitch(false);
    expect(said.map(s => s.title)).toEqual(["1 Claude session stopped — ccdeck"]);
  });

  it("is not held with the swap switch off, since no swap would carry it", async () => {
    const { n, said, timers, fireTimers } = harness({ settings: { ...ALL_ON, swap: false } });
    n.autoSwitch(true);
    n.stopped(login("s-1", "vcrm-core", T0));
    expect(timers.map(t => t.ms)).toEqual([5_000]);
    fireTimers();
    await n.tick(switched(), ROSTER, { startedAt: T0 + 1_500 });
    expect(said.map(s => s.title)).toEqual(["1 Claude session stopped — ccdeck"]);
  });

  it("leaves the swap notice as it was with the stopped switch off", async () => {
    const { n, said } = harness({ settings: { ...ALL_ON, stopped: false } });
    n.autoSwitch(true);
    n.stopped(login("s-1", "vcrm-core", T0));
    await n.tick(switched(), ROSTER, { startedAt: T0 + 1_500 });
    expect(said.map(s => s.body)).toEqual(["Switched to work · personal@x.com reached 90%"]);
  });
});
