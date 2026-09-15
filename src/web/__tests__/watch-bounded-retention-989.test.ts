// Browser Watch read and held every URL since the deck booted, and wrote a
// plaintext log of every address that nothing ever trimmed (#989).
//
// THE READ. `STARTED_MS` was the floor of every read, so the window never moved:
// a deck up for a week asked for a week of browsing on every poll where the
// browser had written — constantly, while anybody uses it — and the mtime cache
// held the whole answer, the reader's own browsing included, until the process
// ended. `readVisitsSince` returns a watermark built for exactly this, and
// nothing read it. The floor now advances to it and the cache keeps no rows.
//
// THE LOG. `appendLog` wrote one line per address to `watch.log` and nothing
// rotated it, while every other store in that module has a cap. It now rolls to
// `watch.log.1` at 2 MiB, and the panel names its size beside its path.
//
// TWO THINGS AN ADVANCING FLOOR BREAKS, AND THE CASES BELOW HOLD THEM DOWN.
//
// A cleared history. The rows a read returned were the running total, and a fall
// in it was how the watch noticed somebody clearing the browsing history — the
// one action that destroys its evidence. A read that returns only what is new
// answers a clear with no rows, exactly as it answers a quiet minute. The running
// total is now a count taken from the same copy, and the cases here drive a
// clear followed by no browsing at all, so nothing but that count can pass them.
//
// The quiet gate. `classify` reports a program navigation only when no human
// visit falls within `quietMs` of it on either side, so one read's rows on their
// own are not enough to judge it: the person's visits may have arrived in the
// read before, or arrive in the read after.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { flooredReader, type Visit } from "./floored-reader";
import { browserWatchSnapshot, invalidateBrowserWatchCache } from "../../server/browser-watch.mjs";
import { msToChromeTime } from "../../server/browser-history.mjs";
import { appendLog, logPath, logSize, rolledLogPath } from "../../server/browser-watch-store.mjs";
import { logBytesLabel } from "../components/BrowserWatchModal";

const FROM_API = 0x08000000;
const PROFILE = {
  browser: "brave", name: "Brave", profile: "Default",
  dir: "/p", historyPath: "/p/History", securePrefsPath: "/p/Secure Preferences",
  hasClaudeExt: true,
};

const page = (atMs: number, n = 0): Visit =>
  ({ url: `https://example.invalid/page-${n}?q=${n}`, timeMs: atMs, transition: 0 });
const driven = (atMs: number, n = 0): Visit =>
  ({ url: `https://gitlab.example.com/-/jobs?page=${n}`, timeMs: atMs, transition: FROM_API });

const MIN = 60_000;

/** A deck polling one browser whose history this test writes. Each deck is its
 *  own profile, because what a profile has contributed and where its next read
 *  starts survive a cache invalidation on purpose. */
let seq = 0;
const baseDeps = () => ({
  readFileSync: () => { throw new Error("ENOENT"); },
  readStore: async () => ({
    settings: { v: 1, enabled: true, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
    episodes: [], dismissed: [], migrated: false,
  }),
  writeStore: async () => {},
  appendLog: async () => {},
  react: async () => [],
  isReactingDeck: () => false,
  logSize: async () => 0,
});
function deck() {
  let history: Visit[] = [];
  let mtime = 1;
  const profile = { ...PROFILE, profile: `Bound${seq++}`, historyPath: `/p/History-bound-${seq}` };
  const reader = flooredReader(() => history);
  const deps = {
    ...baseDeps(),
    discoverProfiles: () => [profile],
    statSync: () => ({ mtimeMs: mtime }),
    readVisitsSince: reader.read,
  };
  return {
    deps, reader, profile,
    /** The browser writes, and its file's mtime moves with it. */
    browse: (...rows: Visit[]) => { history.push(...rows); mtime += 1; },
    /** Somebody presses Clear browsing data. The file moves; the rows are gone. */
    clear: () => { history = []; mtime += 1; },
    poll: () => browserWatchSnapshot({ deps }),
  };
}

beforeEach(() => invalidateBrowserWatchCache());

/** The feed rows about THIS case's profile. The feed is a ring buffer for the
 *  life of the process and a cache reset does not clear it, so every case here
 *  can see every other case's rows. */
const mine = (snap: any, profile: string) =>
  snap.log.filter((l: any) => l.parts && l.parts.profile === profile);
const shrinkRow = (snap: any, profile: string) =>
  mine(snap, profile).find((l: any) => /shrank/.test(l.text));

describe("the window a poll asks for", () => {
  it("stays the size of what arrived, however long the deck has been up", async () => {
    // Four hours of browsing at forty pages an hour, one poll an hour. From a
    // fixed floor the reads returned 40, 80, 120 and 160 rows, the last of them
    // three hours it had already read.
    const t = Date.now() - 8 * 3600_000;
    const d = deck();
    for (let hour = 0; hour < 4; hour++) {
      d.browse(...Array.from({ length: 40 }, (_u, i) => page(t + hour * 3600_000 + i * 1000, hour * 40 + i)));
      await d.poll();
    }
    expect(d.reader.asked, "the read grows with uptime again").toEqual([40, 40, 40, 40]);
    // And nothing was lost to make it so.
    const snap = await d.poll();
    expect(snap.profiles[0].visits).toBe(160);
  });

  it("starts each read where the last one finished", async () => {
    // Asserted on the floor itself, because a reader that ignored its argument
    // would pass the case above by accident.
    const t = Date.now() - 3600_000;
    const d = deck();
    d.browse(page(t, 1), page(t + 1000, 2));
    await d.poll();
    d.browse(page(t + 2000, 3));
    await d.poll();
    expect(d.reader.floors).toHaveLength(2);
    expect(d.reader.floors[1], "the second read began at the deck's start again").toBe(msToChromeTime(t + 1000));
  });

  it("does not move the floor past a read that failed", async () => {
    // A locked database costs one poll, not the navigations made during it: a
    // degraded read hands its floor back, and the same window is asked again.
    const t = Date.now() - 3600_000;
    const profile = { ...PROFILE, profile: `Bound${seq++}`, historyPath: `/p/History-locked-${seq}` };
    const floors: string[] = [];
    let locked = true;
    const deps = {
      ...baseDeps(),
      discoverProfiles: () => [profile],
      statSync: () => ({ mtimeMs: locked ? 1 : 2 }),
      readVisitsSince: async (_p: string, since: string) => {
        floors.push(since);
        if (locked) return { rows: [], watermark: since, total: null, degraded: true, reason: "database is locked" };
        return { rows: [page(t, 1)], watermark: msToChromeTime(t), total: 1, degraded: false, reason: null };
      },
    };
    await browserWatchSnapshot({ deps });
    locked = false;
    const snap = await browserWatchSnapshot({ deps });
    expect(floors[1], "a failed read moved the floor").toBe(floors[0]);
    expect(snap.profiles[0].visits).toBe(1);
  });

  it("keeps no visits in the mtime cache, and no floor in its key", () => {
    // The cache entry held `read.rows` — every visit since the deck booted, the
    // reader's own included — for the life of the process. Asserted at the
    // source because a snapshot cannot see the module's cache.
    const server = readFileSync(new URL("../../server/browser-watch.mjs", import.meta.url), "utf8");
    expect(server, "the rows are in the cache entry again").not.toMatch(/const value = \{ rows: read\.rows/);
    expect(server).toMatch(/const value = \{ degraded: read\.degraded, reason: read\.reason, stamp \};/);
    // Keyed on the floor as well, the entry would miss on the very next poll,
    // the floor having just moved, and re-copy the database to learn nothing.
    expect(server).toMatch(/if \(hit && hit\.stamp === stamp\) return/);
    expect(server, "the floor is back in the cache key").not.toMatch(/hit\.since === sinceChromeTime/);
  });
});

describe("a browsing history that was cleared", () => {
  it("is still reported when the read after it returns nothing at all", async () => {
    const t = Date.now() - 3600_000;
    const d = deck();
    d.browse(page(t, 1), page(t + 1000, 2), page(t + 2000, 3));
    await d.poll();
    d.clear();
    const after = await d.poll();
    expect(d.reader.asked[1], "the read returned rows, so this proves nothing about the count").toBe(0);
    const shrink = shrinkRow(after, d.profile.profile);
    expect(shrink, "a cleared history was reported as a quiet minute").toBeTruthy();
    expect(shrink.level).toBe("warn");
    expect(shrink.parts.value).toBe("-3 entries");
    expect(after.profiles[0].visits, "the overview still counts what was cleared").toBe(0);
  });

  it("reports the fall exactly, not the size of the read", async () => {
    // Nine visits, then a clear that leaves five of them. The read above the
    // floor returns nothing — the five are older than it — and the count says
    // four went.
    const t = Date.now() - 3600_000;
    const d = deck();
    const nine = Array.from({ length: 9 }, (_u, i) => page(t + i * 1000, i));
    d.browse(...nine);
    await d.poll();
    d.clear();
    d.browse(...nine.slice(0, 5));
    const after = await d.poll();
    expect(shrinkRow(after, d.profile.profile).parts.value).toBe("-4 entries");
  });

  it("says nothing when no count could be read", async () => {
    // "Could not count" and "every visit was deleted" must never be the same
    // answer: read as a clear, a sqlite3 that printed the count some other way
    // would accuse its owner on every poll.
    const t = Date.now() - 3600_000;
    const profile = { ...PROFILE, profile: `Bound${seq++}`, historyPath: `/p/History-nocount-${seq}` };
    let stage = 0;
    const answers = [
      { rows: [page(t, 1), page(t + 1000, 2)], total: 2 },
      { rows: [], total: null },
      { rows: [], total: 2 },
    ];
    const deps = {
      ...baseDeps(),
      discoverProfiles: () => [profile],
      statSync: () => ({ mtimeMs: stage + 1 }),
      readVisitsSince: async (_p: string, since: string) => {
        const a = answers[Math.min(stage, answers.length - 1)];
        stage += 1;
        return { rows: a.rows, watermark: since, total: a.total, degraded: false, reason: null };
      },
    };
    await browserWatchSnapshot({ deps });
    expect(shrinkRow(await browserWatchSnapshot({ deps }), profile.profile)).toBeUndefined();
    expect(shrinkRow(await browserWatchSnapshot({ deps }), profile.profile)).toBeUndefined();
  });
});

describe("the quiet gate across reads that no longer overlap", () => {
  it("stays silent about a program page the person browsed next to, a read later", async () => {
    const t = Date.now() - 3600_000;
    const d = deck();
    d.browse(driven(t, 1));
    await d.poll();
    d.browse(page(t + 2 * MIN, 2));
    const after = await d.poll();
    expect(after.episodes, "a program page beside the person's own browsing was flagged").toHaveLength(0);
  });

  it("stays silent about a program page opened just after the person, a read later", async () => {
    // The person's visit arrived in the read before, and without it the gate
    // sees a program page in an empty room.
    const t = Date.now() - 3600_000;
    const d = deck();
    d.browse(page(t, 1));
    await d.poll();
    d.browse(driven(t + 2 * MIN, 2));
    const after = await d.poll();
    expect(after.episodes, "the person's visit from the last read was not in the gate").toHaveLength(0);
  });

  it("still reports the same page when the person comes back after the gate", async () => {
    // The other half, without which the two above pass by reporting nothing.
    const t = Date.now() - 3600_000;
    const d = deck();
    d.browse(driven(t, 1));
    await d.poll();
    d.browse(page(t + 20 * MIN, 2));
    const after = await d.poll();
    expect(after.episodes.map((e: any) => e.host)).toEqual(["gitlab.example.com"]);
  });

  it("keeps a finding once no later visit can change it, after its evidence is dropped", async () => {
    const t = Date.now() - 3 * 3600_000;
    const d = deck();
    d.browse(driven(t, 1));
    await d.poll();
    for (let i = 1; i <= 4; i++) {
      d.browse(page(t + 30 * MIN + i * MIN, i));
      await d.poll();
    }
    const after = await d.poll();
    expect(after.episodes.map((e: any) => e.host), "a settled finding was lost").toEqual(["gitlab.example.com"]);
    expect(after.profiles[0].visits).toBe(5);
  });
});

describe("what watch.log is allowed to grow to", () => {
  const withHome = async (fn: (home: string) => Promise<void>) => {
    const home = mkdtempSync(join(tmpdir(), "bw-989-log-"));
    try { await fn(home); } finally { rmTempDir(home); }
  };

  /** An episode of twenty addresses with query strings and fragments. */
  const run = (i: number) => ({
    host: "gitlab.example.com",
    browser: "brave",
    startMs: Date.UTC(2026, 7, 24, 17, 0, 0) + i * MIN,
    endMs: Date.UTC(2026, 7, 24, 17, 0, 30) + i * MIN,
    count: 20,
    urls: Array.from({ length: 20 }, (_u, j) => ({
      url: `https://gitlab.example.com/run-${i}/page-${j}?token=abcdefghijklmnop&scope=all#section`,
      timeMs: Date.UTC(2026, 7, 24, 17, 0, 0) + i * MIN + j * 1000,
    })),
  });

  /** The first episode, then as many as it takes to pass the 2 MiB cap once —
   *  derived from the real block size, so a change to the log's shape moves the
   *  count rather than quietly writing too little to reach the cap. Returns the
   *  first append's bytes. */
  const fillPastTheCap = async (home: string) => {
    await appendLog([run(0)], home);
    const first = readFileSync(logPath(home), "utf8");
    const need = Math.ceil((2 * 1024 * 1024) / first.length) + 40;
    for (let i = 1; i < need; i++) await appendLog([run(i)], home);
    return first;
  };

  it("rolls over instead of growing for the life of the install", async () => {
    await withHome(async home => {
      await fillPastTheCap(home);
      expect(existsSync(rolledLogPath(home)), "nothing was rolled, so nothing is bounded").toBe(true);
      expect(statSync(logPath(home)).size).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(statSync(rolledLogPath(home)).size).toBeLessThanOrEqual(2 * 1024 * 1024);
      // Two generations and no more.
      expect(readdirSync(join(home, "agent-dag", "browser-watch")).sort()).toEqual(["watch.log", "watch.log.1"]);
    });
  });

  it("moves whole files, so no episode is split and no line is edited", async () => {
    // The live file opens on a summary line, the rolled one ends on an address,
    // and the first bytes ever written are still the first bytes of the
    // generation they went into.
    await withHome(async home => {
      const first = await fillPastTheCap(home);
      const live = readFileSync(logPath(home), "utf8").split("\n").filter(Boolean);
      expect(live[0], "the live log opens on an orphaned address").not.toMatch(/^ /);
      const rolled = readFileSync(rolledLogPath(home), "utf8");
      expect(rolled.startsWith(first), "the rolled generation was rewritten, not moved").toBe(true);
      expect(rolled.split("\n").filter(Boolean).pop()).toMatch(/^ {4}/);
    });
  });

  it("writes the new lines even when the roll could not be done", async () => {
    // A full disk or a Windows handle on `watch.log.1` is a reason to write a
    // larger file than intended, never a reason to write nothing.
    await withHome(async home => {
      await fillPastTheCap(home);
      const before = statSync(logPath(home)).size;
      await appendLog([run(9999)], home, {
        rename: async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
      } as never);
      expect(statSync(logPath(home)).size).toBeGreaterThan(before);
      expect(readFileSync(logPath(home), "utf8")).toContain("run-9999/page-0");
    });
  });

  it("reports its size beside its path", async () => {
    await withHome(async home => {
      expect(await logSize(home)).toBe(0);
      await appendLog([run(1)], home);
      expect(await logSize(home)).toBe(statSync(logPath(home)).size);
    });
    const d = deck();
    const snap = await browserWatchSnapshot({ deps: { ...d.deps, logSize: async () => 4096 } });
    expect(snap.coverage.logBytes, "coverage names the file and not its size").toBe(4096);
  });

  it("never labels a file that holds addresses as zero", () => {
    expect(logBytesLabel(0)).toBe("empty");
    expect(logBytesLabel(1)).toBe("1 B");
    expect(logBytesLabel(1100)).toBe("1 KB");
    expect(logBytesLabel(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
