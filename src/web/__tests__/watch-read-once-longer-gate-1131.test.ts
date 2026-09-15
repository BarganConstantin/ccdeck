// Browser Watch counted one read twice when a Refresh overlapped a poll, and a
// quiet gate lengthened between reads brought back findings it should hide
// (#1131). Both came in with #1117, which made each read start where the last
// one finished and hold a window of visits instead of every row.
//
// ONE READ, COUNTED ONCE. A forced Refresh chained after the read in flight but
// was not stored as the read in flight, so an ordinary poll landing during it
// started a read of its own. Both took the same floor, since neither had
// finished to move it, and both folded the same rows in: five program pages
// reported as seven, and a read later eight against six. The first case drives
// that order and checks the numbers. The next two take the two guards one at a
// time: the poll has to wait for the Refresh, and a snapshot overtaken by
// another read of the same profile has to be dropped, which is the guard that
// holds for a caller that never goes through the in-flight slot at all.
//
// A LONGER GATE, THE SAME EVIDENCE. The window was pruned with the gate in force
// at each read, so once the gate was lengthened the person's visit that should
// silence a program page was already gone: the next poll reported two pages
// that `classify` over the same rows under the new gate reports none of. Each
// case compares against that whole-history classify, and one of them checks the
// other half, so none can pass by reporting nothing.
//
// Synthetic rows through floored-reader.ts, as in #1117's suite, and every
// dependency that could reach the machine is stubbed: no browser profile, hosts
// file or process list is read.
import { describe, it, expect, beforeEach } from "vitest";
import { flooredReader, type Visit } from "./floored-reader";
import * as watch from "../../server/browser-watch.mjs";
import { classify } from "../../server/agent-activity.mjs";

const { browserWatchSnapshot, fetchBrowserWatch, invalidateBrowserWatchCache } = watch;

const FROM_API = 0x08000000;
const MIN = 60_000;

const page = (atMs: number, n = 0): Visit =>
  ({ url: `https://example.invalid/page-${n}?q=${n}`, timeMs: atMs, transition: 0 });
const driven = (atMs: number, n = 0): Visit =>
  ({ url: `https://gitlab.example.com/-/jobs?page=${n}`, timeMs: atMs, transition: FROM_API });

/** A deck polling one browser whose history this test writes. Each deck is its
 *  own profile, because what a profile has contributed and where its next read
 *  starts survive a cache invalidation on purpose.
 *
 *  `readMs` holds each read open after its copy is taken, which is the window
 *  the two defects below live in: the real reader spends it querying the copy. */
let seq = 0;
function deck({ readMs = 0 } = {}) {
  let history: Visit[] = [];
  let mtime = 1;
  const settings = { v: 1, enabled: false, reaction: "notify", quietMinutes: 15, gapMinutes: 15 };
  const profile = {
    browser: "brave", name: "Brave", profile: `Once${++seq}`,
    dir: "/p", historyPath: `/p/History-once-${seq}`, securePrefsPath: "/p/Secure Preferences",
    hasClaudeExt: false,
  };
  const reader = flooredReader(() => history);
  /** How many reads of this profile were open at once, at most. */
  const reads = { open: 0, most: 0 };
  const waiting: Array<{ n: number; go: () => void }> = [];
  const deps = {
    readStore: async () => ({ settings: { ...settings }, episodes: [], dismissed: [], migrated: false }),
    writeStore: async () => {},
    appendLog: async () => {},
    react: async () => [],
    isReactingDeck: () => false,
    logSize: async () => 0,
    browserSurvey: async () => [],
    hostsPath: () => "/nonexistent/hosts",
    readFile: async () => { throw new Error("ENOENT"); },
    discoverProfiles: () => [profile],
    statSync: () => ({ mtimeMs: mtime }),
    readVisitsSince: async (path: string, since: string) => {
      reads.open += 1;
      reads.most = Math.max(reads.most, reads.open);
      try {
        // The copy: what the history holds at this moment is what this read sees.
        const out = await reader.read(path, since);
        for (const w of waiting.splice(0)) {
          if (reader.calls.length >= w.n) w.go(); else waiting.push(w);
        }
        if (readMs) await new Promise(r => setTimeout(r, readMs));
        return out;
      } finally {
        reads.open -= 1;
      }
    },
  };
  return {
    deps, reader, reads,
    /** The browser writes, and its file's mtime moves with it. */
    browse: (...rows: Visit[]) => { history.push(...rows); mtime += 1; },
    /** Resolves once the nth read has taken its copy, while it is still open. */
    copied: (n: number) => new Promise<void>(go => {
      if (reader.calls.length >= n) go(); else waiting.push({ n, go });
    }),
    /** What the settings route saves when the reader picks a gate. */
    setQuiet: (minutes: number) => { settings.quietMinutes = minutes; },
  };
}

beforeEach(() => invalidateBrowserWatchCache());

describe("one read, counted once", () => {
  it("counts five program pages as five when a Refresh lands during a poll and the next poll during the Refresh", async () => {
    const t = Date.now() - 3 * 3600_000;
    const d = deck({ readMs: 30 });
    d.browse(driven(t, 1), driven(t + 5 * MIN, 2), driven(t + 10 * MIN, 3));
    const poll = fetchBrowserWatch({ deps: d.deps });
    const press = fetchBrowserWatch({ force: true, deps: d.deps });
    // The browser writes two more while the poll is still reading.
    await d.copied(1);
    d.browse(driven(t + 15 * MIN, 4), driven(t + 20 * MIN, 5));
    await poll;
    const next = fetchBrowserWatch({ deps: d.deps });
    await Promise.all([press, next]);

    const snap = await fetchBrowserWatch({ deps: d.deps });
    expect(snap.profiles[0].programVisits, "one read's rows were folded in twice").toBe(5);
    expect(snap.profiles[0].findings).toBe(5);
    // And the copies do not wash out: on main the read after this said 8 of 6.
    d.browse(driven(t + 60 * MIN, 6));
    const after = await fetchBrowserWatch({ deps: d.deps });
    expect(after.profiles[0].programVisits).toBe(6);
    expect(after.profiles[0].findings).toBe(6);
  });

  it("has a poll that lands during a forced Refresh wait for it instead of reading beside it", async () => {
    const t = Date.now() - 3 * 3600_000;
    const d = deck({ readMs: 30 });
    d.browse(driven(t, 1));
    const poll = fetchBrowserWatch({ deps: d.deps });
    const press = fetchBrowserWatch({ force: true, deps: d.deps });
    await d.copied(1);
    d.browse(driven(t + 5 * MIN, 2));
    await poll;
    const next = fetchBrowserWatch({ deps: d.deps });
    expect(await next, "the poll started a read of its own").toBe(await press);
    expect(d.reads.most, "two reads of one profile ran at once").toBe(1);
    expect(d.reader.calls, "the poll, the Refresh, and nothing else").toHaveLength(2);
  });

  it("drops a snapshot another read overtook, and loses no visit only it had seen", async () => {
    // Straight to the exported snapshot, past the in-flight slot, which is the
    // one guard the case above tests. The first of two snapshots copies the
    // history, the browser writes one more, and the second copies it with the
    // page the first never saw — both from the same floor. The first finishes
    // first and moves the floor, so the second holds three rows of which two
    // are already counted.
    const t = Date.now() - 3 * 3600_000;
    const d = deck({ readMs: 30 });
    d.browse(driven(t, 1), driven(t + 5 * MIN, 2), driven(t + 10 * MIN, 3));
    await browserWatchSnapshot({ deps: d.deps });
    d.browse(driven(t + 15 * MIN, 4), driven(t + 20 * MIN, 5));
    const first = browserWatchSnapshot({ deps: d.deps });
    await d.copied(2);
    d.browse(driven(t + 25 * MIN, 6));
    const second = browserWatchSnapshot({ deps: d.deps });
    await Promise.all([first, second]);
    expect(d.reader.floors[2], "the two reads did not share a floor, so this proves nothing").toBe(d.reader.floors[1]);
    expect(d.reader.asked.slice(1), "the second copy did not hold the extra page").toEqual([2, 3]);

    const snap = await browserWatchSnapshot({ deps: d.deps });
    expect(snap.profiles[0].programVisits, "the overlapping read was absorbed").toBe(6);
    expect(snap.profiles[0].findings).toBe(6);
    expect(snap.profiles[0].visits).toBe(6);
  });
});

describe("a quiet gate lengthened between reads", () => {
  it("hides what the longer gate hides when the next read brings a page", async () => {
    // The issue's own measurement: a person at t, a program page forty minutes
    // later, reported under fifteen minutes. The reader picks sixty, and one
    // more program page arrives.
    const t = Date.now() - 3 * 3600_000;
    const d = deck();
    const before = [page(t, 1), driven(t + 40 * MIN, 1)];
    d.browse(...before);
    const first = await browserWatchSnapshot({ deps: d.deps });
    expect(first.profiles[0].findings, "fifteen minutes should report the page forty after the person").toBe(1);
    d.setQuiet(60);
    invalidateBrowserWatchCache();   // what the settings route does next
    const after = [driven(t + 50 * MIN, 2)];
    d.browse(...after);
    const snap = await browserWatchSnapshot({ deps: d.deps });
    expect(classify([...before, ...after], { quietMs: 60 * MIN }), "the fixture no longer says what this case is about").toEqual([]);
    expect(snap.profiles[0].findings, "the person's visit was pruned under the old gate").toBe(0);
    expect(snap.episodes).toEqual([]);
  });

  it("applies the longer gate on the next poll, before anybody browses again", async () => {
    // With nothing new to read, the read after the settings change returned no
    // rows and the verdicts it would have re-judged were left as they were.
    const t = Date.now() - 3 * 3600_000;
    const d = deck();
    d.browse(page(t, 1), driven(t + 40 * MIN, 1));
    await browserWatchSnapshot({ deps: d.deps });
    d.setQuiet(60);
    invalidateBrowserWatchCache();
    const snap = await browserWatchSnapshot({ deps: d.deps });
    expect(snap.profiles[0].findings, "the page the new gate hides is still listed").toBe(0);
  });

  it("finds the person's visit for a gate longer than any the panel offers", async () => {
    // The panel's longest is an hour, and `normalise` accepts up to a day from a
    // hand edit or `?quiet=`. Pruning for the panel's hour would pass the case
    // above and fail this one: the person is ninety minutes before the page.
    const t = Date.now() - 5 * 3600_000;
    const d = deck();
    const before = [page(t, 1), driven(t + 90 * MIN, 1)];
    d.browse(...before);
    await browserWatchSnapshot({ deps: d.deps });
    d.setQuiet(120);
    invalidateBrowserWatchCache();
    const after = [driven(t + 100 * MIN, 2)];
    d.browse(...after);
    const snap = await browserWatchSnapshot({ deps: d.deps });
    expect(classify([...before, ...after], { quietMs: 120 * MIN })).toEqual([]);
    expect(snap.profiles[0].findings).toBe(0);
  });

  it("still reports a page nobody was near under the longer gate", async () => {
    // The other half, without which the cases above pass by reporting nothing.
    const t = Date.now() - 5 * 3600_000;
    const d = deck();
    const before = [page(t, 1), driven(t + 40 * MIN, 1)];
    d.browse(...before);
    await browserWatchSnapshot({ deps: d.deps });
    d.setQuiet(60);
    invalidateBrowserWatchCache();
    const after = [driven(t + 200 * MIN, 2)];
    d.browse(...after);
    const snap = await browserWatchSnapshot({ deps: d.deps });
    const whole = classify([...before, ...after], { quietMs: 60 * MIN });
    expect(whole.map(f => f.url)).toEqual([after[0].url]);
    expect(snap.profiles[0].findings).toBe(1);
    expect(snap.episodes.flatMap((e: any) => e.urls.map((u: any) => u.url))).toEqual([after[0].url]);
  });

  it("and a shortened gate reports on the next poll what it no longer hides", async () => {
    // Re-judging is not only for a longer gate: under an hour the page twenty
    // minutes after the person is hidden, and under fifteen minutes it is not.
    const t = Date.now() - 3 * 3600_000;
    const d = deck();
    d.setQuiet(60);
    const rows = [page(t, 1), driven(t + 20 * MIN, 1)];
    d.browse(...rows);
    expect((await browserWatchSnapshot({ deps: d.deps })).profiles[0].findings).toBe(0);
    d.setQuiet(15);
    invalidateBrowserWatchCache();
    const snap = await browserWatchSnapshot({ deps: d.deps });
    expect(classify(rows, { quietMs: 15 * MIN })).toHaveLength(1);
    expect(snap.profiles[0].findings).toBe(1);
  });
});

describe("what is held between polls", () => {
  it("is one gate of browsing and the time of one visit, not two gates of addresses", () => {
    // Asserted on the accumulator itself, because a snapshot cannot see it and
    // the visits it drops are exactly the ones that could never decide a
    // verdict: nothing a poll returns would change if they were kept.
    const { absorb, nothingSeen } = watch as unknown as {
      absorb?: (seen: any, rows: Visit[], opts: any) => void;
      nothingSeen?: () => any;
    };
    expect(typeof absorb, "absorb is not exported, so what it holds cannot be checked").toBe("function");
    const quietMs = 15 * MIN;
    const seen = nothingSeen!();
    // A day at about forty pages an hour, a program page every half hour, read
    // every ten minutes.
    const t0 = Date.now() - 30 * 3600_000;
    let n = 0;
    for (let tick = 0; tick < 6 * 24; tick++) {
      const at = t0 + tick * 10 * MIN;
      const rows = Array.from({ length: 7 }, (_u, i) => page(at + i * 85_000, n++));
      if (tick % 3 === 0) rows.push(driven(at + 30_000, n++));
      absorb!(seen, rows, { quietMs, classifyOpts: { quietMs, exclude: [] }, browser: "brave" });
    }
    const past = seen.window.filter((r: Visit) => r.timeMs <= seen.settledTo);
    expect(past, "visits a verdict can no longer need are still held").toHaveLength(1);
    expect(past[0].url, "the one kept for the gate kept its address").toBe("");
    const recent = seen.window.filter((r: Visit) => r.timeMs > seen.settledTo);
    expect(seen.newest - Math.min(...recent.map((r: Visit) => r.timeMs))).toBeLessThanOrEqual(quietMs);
  });
});
