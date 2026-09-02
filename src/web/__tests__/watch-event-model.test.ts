// What LIVE ACTIVITY is allowed to contain, and what a row means.
//
// THE FEED WAS ITS OWN BOOKKEEPING. Two things filled it that are not events:
// a heartbeat written every five minutes to prove the deck was alive, and a
// per-read line reporting `read.rows.length` — which is the RUNNING TOTAL since
// the deck started, so "2 visits", "4 visits", "7 visits" were not three events
// of those sizes but one number growing, rendered as a log.
//
// Both are fixed here, and the long-session case is the one that made it
// urgent: the buffer is bounded at 200, so on a machine somebody actually
// browses, bookkeeping does not merely clutter the feed — it evicts the
// findings the panel exists to show.
import { describe, it, expect, beforeEach } from "vitest";
import { browserWatchSnapshot, invalidateBrowserWatchCache } from "../../server/browser-watch.mjs";

const PROFILE = {
  browser: "brave", name: "Brave", profile: "Default",
  dir: "/p", historyPath: "/p/History", securePrefsPath: "/p/Secure Preferences",
  hasClaudeExt: true,
};
const FROM_API = 0x08000000;
const visit = (atMs: number, api = false) =>
  ({ url: "https://example.invalid/x", timeMs: atMs, transition: api ? FROM_API : 0 });

/** A deck driven poll by poll: `script[i]` is the rows the history holds at
 *  poll i, and `mtimes[i]` whether the file looks touched. */
function session(script: { mtime: number; rows: unknown[] }[]) {
  let i = 0;
  const deps = {
    discoverProfiles: () => [PROFILE],
    statSync: () => ({ mtimeMs: script[Math.min(i, script.length - 1)].mtime }),
    readVisitsSince: async () => ({
      rows: script[Math.min(i, script.length - 1)].rows,
      watermark: "0", degraded: false, reason: null,
    }),
    readFileSync: () => { throw new Error("ENOENT"); },
    readStore: async () => ({
      settings: { v: 1, enabled: true, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
      episodes: [], migrated: false,
    }),
    writeStore: async () => {},
    appendLog: async () => {},
    react: async () => [],
    isReactingDeck: () => false,
  };
  return { deps, step: () => { i += 1; } };
}

beforeEach(() => invalidateBrowserWatchCache());

describe("what earns a row in the activity feed", () => {
  it("says nothing for a check that found the file unchanged", async () => {
    // The heartbeat this replaces wrote a line every five minutes to say the
    // deck was alive. Liveness is `checkedMs` now, which costs no rows.
    const s = session([
      { mtime: 1, rows: [visit(Date.now() - 60_000)] },
      { mtime: 1, rows: [visit(Date.now() - 60_000)] },
      { mtime: 1, rows: [visit(Date.now() - 60_000)] },
    ]);
    const first = await browserWatchSnapshot({ deps: s.deps });
    const rowsAfterFirst = first.log.length;
    s.step(); await browserWatchSnapshot({ deps: s.deps });
    s.step(); const third = await browserWatchSnapshot({ deps: s.deps });
    expect(third.log.length, "an unchanged file wrote rows").toBe(rowsAfterFirst);
  });

  it("says nothing for a file that moved but gained no entries", async () => {
    // Chrome touches this file for reasons of its own. An mtime that moved is
    // not proof anything happened; only a row count that grew is.
    const rows = [visit(Date.now() - 60_000)];
    const s = session([{ mtime: 1, rows }, { mtime: 2, rows }, { mtime: 3, rows }]);
    const first = await browserWatchSnapshot({ deps: s.deps });
    s.step(); await browserWatchSnapshot({ deps: s.deps });
    s.step(); const third = await browserWatchSnapshot({ deps: s.deps });
    expect(third.log.length, "a touched-but-unchanged file wrote rows").toBe(first.log.length);
  });

  it("reports what was ADDED, not the running total", async () => {
    // The defect this pins reads as a working log: three rows saying 2, 5 and
    // 9, which look like three events of those sizes and are one number
    // growing. Only the deltas are facts about what happened.
    const t = Date.now() - 60_000;
    const s = session([
      { mtime: 1, rows: [visit(t), visit(t + 1)] },
      { mtime: 2, rows: [visit(t), visit(t + 1), visit(t + 2), visit(t + 3), visit(t + 4)] },
    ]);
    await browserWatchSnapshot({ deps: s.deps });
    s.step();
    const second = await browserWatchSnapshot({ deps: s.deps });
    const values = second.log.filter((l: any) => l.parts).map((l: any) => l.parts.value);
    expect(values[0], "the newest row should be the delta, not the total").toBe("+3 entries");
    expect(values[1]).toBe("+2 entries");
  });

  it("keeps a read that failed, because that is not nothing happening", async () => {
    const s = {
      deps: {
        discoverProfiles: () => [PROFILE],
        statSync: () => ({ mtimeMs: 1 }),
        readVisitsSince: async () => ({ rows: [], watermark: "0", degraded: true, reason: "database is locked" }),
        readFileSync: () => { throw new Error("ENOENT"); },
        readStore: async () => ({
          settings: { v: 1, enabled: true, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
          episodes: [], migrated: false,
        }),
        writeStore: async () => {}, appendLog: async () => {}, react: async () => [],
        isReactingDeck: () => false,
      },
    };
    const snap = await browserWatchSnapshot({ deps: s.deps });
    expect(snap.log.some((l: any) => l.level === "warn" && /locked/.test(l.text))).toBe(true);
  });
});

describe("two hours of watching, three things worth seeing", () => {
  it("leaves the feed holding the three, not a hundred and twenty checks", async () => {
    // THE CASE THAT MADE THIS URGENT. The buffer is bounded at 200: with a row
    // per poll, a long session does not merely clutter the feed, it evicts the
    // findings the panel exists to show. 120 polls, 3 of which add entries.
    const t = Date.now() - 60_000;
    const script: { mtime: number; rows: unknown[] }[] = [];
    let rows: unknown[] = [];
    for (let i = 0; i < 120; i++) {
      if (i === 20 || i === 60 || i === 100) rows = [...rows, visit(t + i)];
      // The mtime only moves on the polls that changed something, which is
      // what a real history file does.
      // mtime from 1, never 0: a zero stamp is indistinguishable from "no
      // file" to the reader, and the profile would come back degraded.
      script.push({ mtime: rows.length + 1, rows: [...rows] });
    }
    const s = session(script);
    // The log is a ring buffer for the life of the process and the cache reset
    // deliberately does not clear it — a reader's own actions must survive a
    // refresh. So this measures what THIS session added.
    const before = (await browserWatchSnapshot({ deps: s.deps })).log.length;
    let snap: any;
    for (let i = 0; i < 120; i++) {
      snap = await browserWatchSnapshot({ deps: s.deps });
      s.step();
    }
    const added = snap.log.length - before;
    expect(added, "a row per poll is back").toBe(3);
    expect(snap.log.filter((l: any) => /nothing new|still watching/.test(l.text)).length,
      "the heartbeat is back").toBe(0);
    // And liveness survived without any of them.
    expect(snap.coverage.checks).toBeGreaterThanOrEqual(120);
    expect(snap.coverage.checkedMs).toBeGreaterThan(0);
  });

  it("times liveness from the deck's own poll, not the browser's file", async () => {
    // `lastWrittenMs` is the History file's mtime — when the BROWSER last
    // wrote. On an idle machine it climbs past an hour while the watch keeps
    // checking every ten seconds, and a panel reading it says the watch has
    // stopped when it has not.
    const s = session([{ mtime: 1, rows: [visit(Date.now() - 3 * 3600_000)] }]);
    const snap = await browserWatchSnapshot({ deps: s.deps, now: 1_000_000 });
    expect(snap.coverage.checkedMs).toBe(1_000_000);
    expect(snap.coverage.checkedMs).not.toBe(snap.profiles[0].lastWrittenMs);
  });
});
