// The three account notifications: the deck's auto-switch moved the live Claude
// account, a quota window of the account a provider is live on reached 90% and
// then 100%, and a window that had been high is available again.
//
// What is pinned here is mostly the deck NOT speaking. A poll every minute that
// finds the same 93% must say nothing after the first time; a restart must not
// say it again; an account must never inherit what another account was told;
// and the crossing that made the auto-switch move the account is the swap's to
// tell, once, not the swap's and then the threshold's. Every case drives the
// real factory with an injected clock, disk and OS call, so nothing here raises
// a notification or touches a file.
import { describe, it, expect } from "vitest";
import {
  claudeWindows, codexWindows, createAccountNotifier, HOLD_MS, inDuration, relate, RESET_NEWS_MS,
  swapNotice, usedBefore, accountOfRef, claudeAccountKey, codexAccountKey,
} from "../../server/account-notify.mjs";

type Said = { title: string; body: string; meta: { who: string; chime: null; silent: boolean } };
type Settings = { swap: boolean; quota: boolean; reset: boolean };

const H = 3600;
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const ALL_ON: Settings = { swap: true, quota: true, reset: true };

/** A notifier with every outside thing replaced: what it said, what it saved,
 *  a clock this file moves, and the hold timer handed back to be fired by hand. */
function harness({ settings = { ...ALL_ON } as Settings, saved = null as unknown, notify = null as null | ((t: string, b: string, m: unknown) => unknown) } = {}) {
  const said: Said[] = [];
  const clock = { now: T0 };
  const timers: (() => void)[] = [];
  const disk = { records: saved };
  const errors: unknown[] = [];
  const n = createAccountNotifier({
    notify: notify ?? ((title: string, body: string, meta: Said["meta"]) => { said.push({ title, body, meta }); }),
    settings: () => settings,
    product: "ccdeck",
    now: () => clock.now,
    load: async () => disk.records,
    save: async (records: unknown) => { disk.records = records; },
    later: (fn: () => void) => { timers.push(fn); return 0; },
    onError: (err: unknown) => errors.push(err),
  });
  const fireTimers = () => { const due = timers.splice(0); for (const fn of due) fn(); };
  return { n, said, clock, settings, disk, errors, fireTimers };
}

const PERSONAL = { key: claudeAccountKey("personal@x.com", "org-1")!, name: "personal@x.com" };
const WORK = { key: claudeAccountKey("work@x.com", "org-2")!, name: "work" };

/** A Claude reading as quota.mjs publishes it, the 5-hour window resetting at `reset5h`. */
const claude = (pct5h: number, { pct7d = 20, reset5h = T0 / 1000 + 2 * H, reset7d = T0 / 1000 + 50 * H } = {}) => claudeWindows({
  ok: true, source: "claude-swap",
  session5hPct: pct5h, session5hWindowSec: 5 * H, session5hResetAt: reset5h,
  week7dPct: pct7d, week7dWindowSec: 7 * 24 * H, week7dResetAt: reset7d,
  fetchedAt: T0,
});

const bodies = (s: Said[]) => s.map(x => x.body);

describe("a quota window crossing 90% and 100%", () => {
  it("says 90% once, however many polls find it there", async () => {
    const { n, said } = harness();
    await n.observe("claude", PERSONAL, claude(85));
    await n.observe("claude", PERSONAL, claude(91));
    await n.observe("claude", PERSONAL, claude(93));
    await n.observe("claude", PERSONAL, claude(93));
    expect(bodies(said)).toEqual(["5-hour usage reached 90% · resets in 2h"]);
    expect(said[0].title).toBe("Claude · personal@x.com — ccdeck");
    expect(said[0].meta).toEqual({ who: "Claude · personal@x.com", chime: null, silent: true });
  });

  it("says 100% after 90%, once more and only once", async () => {
    const { n, said } = harness();
    await n.observe("claude", PERSONAL, claude(92));
    await n.observe("claude", PERSONAL, claude(100));
    await n.observe("claude", PERSONAL, claude(100));
    expect(bodies(said)).toEqual([
      "5-hour usage reached 90% · resets in 2h",
      "5-hour usage reached 100% · resets in 2h",
    ]);
  });

  it("says only 100% for a window first seen full, and not 90% after it", async () => {
    const { n, said } = harness();
    await n.observe("claude", PERSONAL, claude(100));
    await n.observe("claude", PERSONAL, claude(100));
    expect(bodies(said)).toEqual(["5-hour usage reached 100% · resets in 2h"]);
  });

  it("says it again for the next window, and not before it", async () => {
    const { n, said, clock } = harness({ settings: { swap: true, quota: true, reset: false } });
    await n.observe("claude", PERSONAL, claude(95));
    clock.now = T0 + 2 * H * 1000 + 60_000;
    // A reading of the window that just ended is about a window that is over.
    await n.observe("claude", PERSONAL, claude(95));
    await n.observe("claude", PERSONAL, claude(4, { reset5h: T0 / 1000 + 7 * H }));
    await n.observe("claude", PERSONAL, claude(96, { reset5h: T0 / 1000 + 7 * H }));
    expect(bodies(said)).toEqual([
      "5-hour usage reached 90% · resets in 2h",
      "5-hour usage reached 90% · resets in 4h 59m",
    ]);
  });

  it("takes a reset instant a few minutes off as the same window", async () => {
    // claude --print /usage prints its reset to the minute and the store to the
    // second, and the source can change between two polls.
    const { n, said } = harness();
    await n.observe("claude", PERSONAL, claude(92));
    await n.observe("claude", PERSONAL, claude(94, { reset5h: T0 / 1000 + 2 * H + 40 }));
    await n.observe("claude", PERSONAL, claude(94, { reset5h: T0 / 1000 + 2 * H - 50 }));
    expect(said).toHaveLength(1);
  });

  it("ignores a reading of a window it has already moved past", async () => {
    const { n, said } = harness();
    await n.observe("claude", PERSONAL, claude(10, { reset5h: T0 / 1000 + 4 * H }));
    await n.observe("claude", PERSONAL, claude(97, { reset5h: T0 / 1000 + 1 * H }));
    expect(said).toEqual([]);
  });

  it("watches the 7-day and the model windows too", async () => {
    const { n, said } = harness();
    const w = claudeWindows({
      ok: true, session5hPct: 30, session5hResetAt: T0 / 1000 + H, week7dPct: 91, week7dResetAt: T0 / 1000 + 30 * H,
      weekSonnetPct: 100, fetchedAt: T0,
    });
    await n.observe("claude", PERSONAL, w);
    expect(bodies(said)).toEqual([
      "7-day usage reached 90% · resets in 1d 6h",
      "Sonnet 7-day usage reached 100%",
    ]);
  });
});

describe("a restart", () => {
  it("reads back what was said and says none of it again", async () => {
    const first = harness();
    await first.n.observe("claude", PERSONAL, claude(92));
    await first.n.settled();
    expect(first.said).toHaveLength(1);

    const second = harness({ saved: JSON.parse(JSON.stringify(first.disk.records)) });
    await second.n.observe("claude", PERSONAL, claude(93));
    expect(second.said).toEqual([]);
    await second.n.observe("claude", PERSONAL, claude(100));
    expect(bodies(second.said)).toEqual(["5-hour usage reached 100% · resets in 2h"]);
  });

  it("drops a record nobody has read for five weeks", async () => {
    const first = harness();
    await first.n.observe("claude", PERSONAL, claude(92));
    await first.n.settled();
    const later = harness({ saved: first.disk.records });
    later.clock.now = T0 + 36 * 24 * H * 1000;
    await later.n.ready;
    expect(Object.keys(later.n.records().windows)).toEqual([]);
  });
});

describe("one account's state", () => {
  it("is never another account's", async () => {
    const { n, said } = harness();
    await n.observe("claude", PERSONAL, claude(92));
    // The live account changes: the new one at 95% has been told nothing yet.
    await n.observe("claude", WORK, claude(95));
    // And back: the first account's crossing was already said.
    await n.observe("claude", PERSONAL, claude(93));
    expect(said.map(s => s.meta.who)).toEqual(["Claude · personal@x.com", "Claude · work"]);
  });

  it("is never another provider's, even for the same address", async () => {
    const { n, said } = harness();
    await n.observe("claude", { key: "same", name: "a@x.com" }, claude(92));
    await n.observe("codex", { key: "same", name: "a@x.com" }, codexWindows({
      ok: true, windows: [{ id: "session", key: "session", label: "5-hour window", pct: 92, windowSec: 5 * H, resetAt: T0 / 1000 + H }],
    }));
    expect(said.map(s => s.meta.who)).toEqual(["Claude · a@x.com", "Codex · a@x.com"]);
  });

  it("is not kept for a reading nobody can name", async () => {
    const { n, said } = harness();
    await n.observe("claude", { key: null, name: "?" }, claude(99));
    expect(said).toEqual([]);
    expect(n.records().windows).toEqual({});
  });
});

describe("a reset", () => {
  it("is said for a window that had reached 90%", async () => {
    const { n, said, clock } = harness({ settings: { swap: true, quota: false, reset: true } });
    await n.observe("claude", PERSONAL, claude(94));
    clock.now = T0 + 2 * H * 1000 + 5 * 60_000;
    await n.observe("claude", PERSONAL, claude(2, { reset5h: T0 / 1000 + 7 * H }));
    await n.observe("claude", PERSONAL, claude(3, { reset5h: T0 / 1000 + 7 * H }));
    expect(bodies(said)).toEqual(["5-hour window available again"]);
  });

  it("is not said for a window that never got high", async () => {
    const { n, said, clock } = harness();
    await n.observe("claude", PERSONAL, claude(60));
    clock.now = T0 + 2 * H * 1000 + 5 * 60_000;
    await n.observe("claude", PERSONAL, claude(1, { reset5h: T0 / 1000 + 7 * H }));
    expect(said).toEqual([]);
  });

  it("is not news hours after the window ended", async () => {
    const { n, said, clock } = harness();
    await n.observe("claude", PERSONAL, claude(94));
    said.length = 0;
    clock.now = T0 + 2 * H * 1000 + RESET_NEWS_MS + 60_000;
    await n.observe("claude", PERSONAL, claude(1, { reset5h: clock.now / 1000 + 4 * H }));
    expect(said).toEqual([]);
  });

  it("is found for a window with no reset instant by how far it fell", async () => {
    const { n, said, clock } = harness({ settings: { swap: true, quota: false, reset: true } });
    const sonnet = (pct: number) => claudeWindows({ ok: true, session5hPct: 1, weekSonnetPct: pct, fetchedAt: T0 });
    await n.observe("claude", PERSONAL, sonnet(95));
    clock.now += 10 * 60_000;
    await n.observe("claude", PERSONAL, sonnet(88));
    expect(said).toEqual([]);
    clock.now += 10 * 60_000;
    await n.observe("claude", PERSONAL, sonnet(3));
    expect(bodies(said)).toEqual(["Sonnet 7-day window available again"]);
  });
});

/** One `cswap auto --once --json` run, as cswap-auto-loop.mjs's summarise
 *  leaves it: the account left at `used`%, by the policy's threshold. */
function switched({ used = 93, threshold = 90, windows = { "2": { "5h": used, "7d": 40 } } as unknown } = {}) {
  return {
    ok: true, event: "switch", switched: true, reason: null, detail: null,
    from: { number: 2, email: "personal@x.com" }, to: { number: 3, email: "work@x.com" },
    active: { number: 2, email: "personal@x.com" }, threshold,
    headroom: { "2": 100 - used, "3": 70 }, windows,
  };
}
const ROSTER = {
  "2": { email: "personal@x.com", organizationUuid: "org-1" },
  "3": { email: "work@x.com", organizationUuid: "org-2", alias: "work" },
};
const nothing = (reason = "below-threshold") => ({ ok: true, event: "no-switch", switched: false, reason, threshold: 90 });

describe("a switch the deck's auto-switch made", () => {
  it("is said once, with where it went and why", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.tick(switched(), ROSTER);
    expect(said).toEqual([{
      title: "Claude auto-switch — ccdeck",
      body: "Switched to work · personal@x.com reached 90%",
      meta: { who: "Claude auto-switch", chime: null, silent: true },
    }]);
  });

  it("carries the crossing, so the threshold notice for it is never sent", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.tick(nothing(), null);
    await n.observe("claude", PERSONAL, claude(93));
    expect(said, "the crossing went out before the tick could carry it").toEqual([]);
    expect(n.held()).toHaveLength(1);
    await n.tick(switched(), ROSTER);
    expect(bodies(said)).toEqual(["Switched to work · personal@x.com reached 90%"]);
    // The account comes back later in the same window: still nothing new.
    await n.observe("claude", PERSONAL, claude(94));
    expect(said).toHaveLength(1);
  });

  it("writes down a crossing only the tick saw, so the account does not say it later", async () => {
    const { n, said, clock } = harness();
    n.autoSwitch(true);
    await n.tick(switched({ used: 96 }), ROSTER);
    clock.now += 20 * 60_000;
    await n.observe("claude", PERSONAL, claude(97));
    expect(bodies(said)).toEqual(["Switched to work · personal@x.com reached 90%"]);
    expect(n.held(), "the crossing the swap carried is waiting to be said again").toEqual([]);
    // The next window is a new one: its reset is news, and so is its own 90%
    // once the tick after it says it switched nothing.
    clock.now = T0 + 2 * H * 1000 + 60_000;
    await n.observe("claude", PERSONAL, claude(91, { reset5h: T0 / 1000 + 7 * H }));
    await n.tick(nothing("no-candidates"), null);
    expect(bodies(said).slice(1)).toEqual([
      "5-hour window available again",
      "5-hour usage reached 90% · resets in 4h 59m",
    ]);
  });

  it("lets a held notice go when the tick switched nothing", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.observe("claude", PERSONAL, claude(93));
    expect(said).toEqual([]);
    await n.tick(nothing("no-candidates"), null);
    expect(bodies(said)).toEqual(["5-hour usage reached 90% · resets in 2h"]);
  });

  it("keeps holding through a cooldown, which says a switch is still coming", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.observe("claude", PERSONAL, claude(93));
    await n.tick(nothing("cooldown"), null);
    expect(said).toEqual([]);
    await n.tick(switched(), ROSTER);
    expect(bodies(said)).toEqual(["Switched to work · personal@x.com reached 90%"]);
  });

  it("lets a held notice go when no tick answers in time", async () => {
    const { n, said, clock, fireTimers } = harness();
    n.autoSwitch(true);
    await n.observe("claude", PERSONAL, claude(93));
    clock.now += HOLD_MS;
    fireTimers();
    expect(bodies(said)).toEqual(["5-hour usage reached 90% · resets in 1h 54m"]);
  });

  it("lets a held notice go when the loop is switched off", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.observe("claude", PERSONAL, claude(93));
    n.autoSwitch(false);
    expect(said).toHaveLength(1);
  });

  it("holds nothing below the threshold the policy runs at", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.tick(nothing(), null);
    await n.tick({ ...nothing(), threshold: 95 }, null);
    await n.observe("claude", PERSONAL, claude(92));
    expect(said).toHaveLength(1);
  });

  it("never holds Codex, which the auto-switch does not move", async () => {
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.observe("codex", { key: "acc|a@x.com", name: "a@x.com" }, codexWindows({
      ok: true, windows: [{ id: "weekly", label: "7-day window", pct: 90, windowSec: 7 * 24 * H, resetAt: T0 / 1000 + 3 * H }],
    }));
    expect(bodies(said)).toEqual(["7-day usage reached 90% · resets in 3h"]);
  });

  it("is not said for a switch somebody made: the account changes and nothing says so", async () => {
    // A press on Switch goes through cswap-admin and never through a tick, so
    // all the notifier sees of it is that the live account is another one.
    const { n, said } = harness();
    n.autoSwitch(true);
    await n.observe("claude", PERSONAL, claude(40));
    await n.observe("claude", WORK, claude(10));
    expect(said).toEqual([]);
  });
});

describe("the three switches", () => {
  it("each works alone: the threshold off does not silence the swap", async () => {
    const { n, said } = harness({ settings: { swap: true, quota: false, reset: false } });
    n.autoSwitch(true);
    await n.observe("claude", PERSONAL, claude(93));
    await n.tick(switched(), ROSTER);
    expect(bodies(said)).toEqual(["Switched to work · personal@x.com reached 90%"]);
  });

  it("with the swap off, the crossing that caused a switch is still said as a threshold", async () => {
    const { n, said } = harness({ settings: { swap: false, quota: true, reset: false } });
    n.autoSwitch(true);
    await n.observe("claude", PERSONAL, claude(93));
    await n.tick(switched(), ROSTER);
    expect(bodies(said)).toEqual(["5-hour usage reached 90% · resets in 2h"]);
  });

  it("with the swap off, a crossing only the tick saw is said from the tick", async () => {
    const { n, said } = harness({ settings: { swap: false, quota: true, reset: false } });
    n.autoSwitch(true);
    await n.tick(switched({ used: 100 }), ROSTER);
    expect(bodies(said)).toEqual(["5-hour usage reached 100%"]);
    expect(said[0].meta.who).toBe("Claude · personal@x.com");
  });

  it("with the swap off, nothing is said about a switch", async () => {
    const { n, said } = harness({ settings: { swap: false, quota: false, reset: true } });
    n.autoSwitch(true);
    await n.tick(switched(), ROSTER);
    expect(said).toEqual([]);
  });

  it("with the threshold off, a crossing is written down and not said when it is turned on", async () => {
    const settings = { swap: true, quota: false, reset: false };
    const { n, said } = harness({ settings });
    await n.observe("claude", PERSONAL, claude(93));
    settings.quota = true;
    await n.observe("claude", PERSONAL, claude(94));
    expect(said).toEqual([]);
    await n.observe("claude", PERSONAL, claude(100));
    expect(bodies(said)).toEqual(["5-hour usage reached 100% · resets in 2h"]);
  });

  it("with the reset off, a high window resetting says nothing", async () => {
    const { n, said, clock } = harness({ settings: { swap: true, quota: true, reset: false } });
    await n.observe("claude", PERSONAL, claude(94));
    clock.now = T0 + 2 * H * 1000 + 60_000;
    await n.observe("claude", PERSONAL, claude(2, { reset5h: T0 / 1000 + 7 * H }));
    expect(bodies(said)).toEqual(["5-hour usage reached 90% · resets in 2h"]);
  });
});

describe("a notification that cannot be raised", () => {
  it("costs neither the poll nor the tick, thrown or rejected", async () => {
    for (const notify of [
      () => { throw new Error("no notification daemon"); },
      () => Promise.reject(new Error("osascript missing")),
    ]) {
      const { n, errors } = harness({ notify });
      n.autoSwitch(true);
      await expect(n.observe("claude", PERSONAL, claude(95))).resolves.toBeUndefined();
      await expect(n.tick(switched(), ROSTER)).resolves.toBeUndefined();
      await new Promise(r => setTimeout(r, 0));
      expect(errors.length, "the failure was swallowed without a word").toBeGreaterThan(0);
      // And the record was still written: it is not said again next poll.
      expect(n.records().windows[`claude|${PERSONAL.key}|five_hour`].said).toEqual([90]);
    }
  });

  it("nor does a disk that will not take the records", async () => {
    const said: string[] = [];
    const n = createAccountNotifier({
      notify: (_t: string, b: string) => { said.push(b); },
      settings: () => ALL_ON,
      now: () => T0,
      load: async () => { throw new Error("EACCES"); },
      save: async () => { throw new Error("ENOSPC"); },
      onError: () => {},
    });
    await n.observe("claude", PERSONAL, claude(91));
    await n.settled();
    expect(said).toEqual(["5-hour usage reached 90% · resets in 2h"]);
  });
});

describe("what a swap says about why", () => {
  it("names the threshold only when the account it left had reached it", () => {
    expect(swapNotice({ toName: "work", fromName: "me", used: 93, threshold: 90 }).body).toBe("Switched to work · me reached 90%");
    expect(swapNotice({ toName: "work", fromName: "me", used: 100, threshold: 90 }).body).toBe("Switched to work · me reached 100%");
    expect(swapNotice({ toName: "work", fromName: "me", used: 88.5, threshold: 87.5 }).body).toBe("Switched to work · me reached 87.5%");
    // Consume-first moves below the threshold, failover moves on an unknown
    // reading: neither is a threshold being reached.
    expect(swapNotice({ toName: "work", fromName: "me", used: 40, threshold: 90 }).body).toBe("Switched to work from me");
    expect(swapNotice({ toName: "work", fromName: "me", used: null, threshold: 90 }).body).toBe("Switched to work from me");
    expect(swapNotice({ toName: "work", fromName: null, used: null, threshold: null }).body).toBe("Switched to work");
  });

  it("reads the account's usage from the tick's own poll, in both shapes", () => {
    expect(usedBefore({ headroom: { "2": 6, "3": 70 } }, 2)).toBe(94);
    expect(usedBefore({ headroom: 4, active: { number: "2" } }, 2)).toBe(96);
    expect(usedBefore({ headroom: 4, active: { number: "5" } }, 2)).toBeNull();
    expect(usedBefore({ headroom: { "2": null } }, 2)).toBeNull();
    expect(usedBefore({}, 2)).toBeNull();
  });

  it("names each side as the deck does: the alias, else the address", () => {
    expect(accountOfRef({ number: 3, email: "work@x.com" }, ROSTER)).toEqual({ number: 3, key: "work@x.com@@org-2", name: "work" });
    expect(accountOfRef({ number: 2, email: "personal@x.com" }, ROSTER)?.name).toBe("personal@x.com");
    // A slot the store now gives to somebody else is not that account's key.
    expect(accountOfRef({ number: 3, email: "old@x.com" }, ROSTER)).toEqual({ number: 3, key: null, name: "old@x.com" });
    expect(accountOfRef({ number: 9, email: "" }, null)).toEqual({ number: 9, key: null, name: "account 9" });
  });
});

describe("the windows each provider reports", () => {
  it("leaves out a stale Claude reading, and a 5-hour entry that copies the 7-day one", () => {
    expect(claudeWindows({ ok: true, stale: true, session5hPct: 99, fetchedAt: T0 })).toEqual([]);
    expect(claudeWindows({ ok: false, reason: "waiting" })).toEqual([]);
    const copied = claudeWindows({ ok: true, session5hPct: 50, session5hResetAt: 100, week7dPct: 50, week7dResetAt: 100 });
    expect(copied.map(w => w.id)).toEqual(["seven_day"]);
  });

  it("takes every Codex lane, the extra limit families included", () => {
    const w = codexWindows({
      ok: true,
      windows: [
        { id: "session", label: "5-hour window", pct: 12, windowSec: 18000, resetAt: 1000 },
        { id: "weekly", label: "7-day window", pct: 101, windowSec: 604800, resetAt: 2000 },
      ],
      extraWindows: [{ id: "codex-spark-weekly", label: "Codex Spark · 7-day window", pct: 90, windowSec: 604800, resetAt: null }],
    });
    expect(w).toEqual([
      { id: "session", name: "5-hour", pct: 12, epoch: 1000, windowSec: 18000 },
      { id: "weekly", name: "7-day", pct: 101, epoch: 2000, windowSec: 604800 },
      { id: "codex-spark-weekly", name: "Codex Spark · 7-day", pct: 90, epoch: null, windowSec: 604800 },
    ]);
    expect(codexWindows({ ok: true, stale: true, windows: [{ id: "x", pct: 99 }] })).toEqual([]);
  });

  it("says each of them reached its level, once", async () => {
    const { n, said } = harness();
    const codex = (session: number, weekly: number, spark: number) => codexWindows({
      ok: true,
      windows: [
        { id: "session", label: "5-hour window", pct: session, windowSec: 18000, resetAt: T0 / 1000 + H },
        { id: "weekly", label: "7-day window", pct: weekly, windowSec: 604800, resetAt: T0 / 1000 + 40 * H },
      ],
      extraWindows: [{ id: "codex-spark-weekly", label: "Codex Spark · 7-day window", pct: spark, windowSec: 604800, resetAt: T0 / 1000 + 40 * H }],
    });
    const me = { key: codexAccountKey("acc-1", "a@x.com")!, name: "a@x.com" };
    await n.observe("codex", me, codex(91, 50, 10));
    await n.observe("codex", me, codex(92, 104, 95));
    await n.observe("codex", me, codex(92, 104, 95));
    expect(bodies(said)).toEqual([
      "5-hour usage reached 90% · resets in 1h",
      "7-day usage reached 100% · resets in 1d 16h",
      "Codex Spark · 7-day usage reached 90% · resets in 1d 16h",
    ]);
  });

  it("keys a Codex account on its workspace as well as its address", () => {
    expect(codexAccountKey("acc-1", "A@x.com")).toBe("acc-1|a@x.com");
    expect(codexAccountKey("acc-2", "a@x.com")).not.toBe(codexAccountKey("acc-1", "a@x.com"));
    expect(codexAccountKey(null, null)).toBeNull();
    expect(claudeAccountKey("a@x.com", "")).toBeNull();
  });
});

describe("the small rules", () => {
  it("relates a reading to its record", () => {
    const rec = { epoch: 10_000, windowSec: 18000, peak: 95, said: [90], seenAt: T0 };
    expect(relate(undefined, { epoch: 10_000, pct: 1 })).toBe("new");
    expect(relate(rec, { epoch: 10_300, pct: 96 })).toBe("same");
    expect(relate(rec, { epoch: 30_000, pct: 1 })).toBe("newer");
    expect(relate(rec, { epoch: 1_000, pct: 99 })).toBe("older");
  });

  it("prints how long until a reset", () => {
    const now = T0;
    expect(inDuration(now / 1000 + 30, now)).toBe("under a minute");
    expect(inDuration(now / 1000 + 45 * 60, now)).toBe("45m");
    expect(inDuration(now / 1000 + 2 * H + 14 * 60, now)).toBe("2h 14m");
    expect(inDuration(now / 1000 + 3 * H, now)).toBe("3h");
    expect(inDuration(now / 1000 + 76 * H, now)).toBe("3d 4h");
  });
});
