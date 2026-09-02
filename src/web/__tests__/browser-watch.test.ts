// The composition layer, which is where the four readers stop being separately
// correct and start being one answer.
//
// Everything asserted here is something no single reader could get wrong on its
// own: which tabs are the deck's, when a read is worth paying for, what an
// unreadable hosts file is allowed to claim, and what the topbar badge counts.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  browserWatchSnapshot,
  deckOwnOrigins,
  fetchBrowserWatch,
  invalidateBrowserWatchCache,
  mayForceRead,
} from "../../server/browser-watch.mjs";
import { unseenEpisodes, SEEN_KEY } from "../components/BrowserWatchModal";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const src = (rel: string) => readFileSync(at(rel), "utf8");

const PROFILE = {
  browser: "brave", name: "Brave", profile: "Default",
  dir: "/p", historyPath: "/p/History", securePrefsPath: "/p/Secure Preferences",
  hasClaudeExt: true,
};

/** A snapshot driven entirely from literals: no disk, no browser, no clock.
 *
 *  THE STORE STUBS ARE PART OF THE HARNESS, NOT OF THE CASES THAT HAPPEN TO
 *  NEED THEM. Left to the real ones, a snapshot here read the developer's own
 *  settings, ran the real deck election, elected itself, and wrote this file's
 *  fixture — `gitlab.example.com/-/jobs` — into
 *  ~/.claude/agent-dag/browser-watch/state.json, where it then showed up in a
 *  running deck's panel as an episode that had never happened. It also made the
 *  suite's behaviour depend on whether the developer's watch was switched on.
 *  Sealed here so no case can reach the real config directory by omission. */
function harness({ rows = [] as any[], mtimes = [1] as (number | null)[], profiles = [PROFILE] } = {}) {
  const calls: string[] = [];
  const wrote: unknown[] = [];
  let tick = 0;
  const deps = {
    readStore: async () => ({
      settings: { v: 1, enabled: true, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
      episodes: [],
      migrated: false,
    }),
    writeStore: async (state: unknown) => { wrote.push(state); },
    appendLog: async () => {},
    react: async () => [],
    discoverProfiles: () => profiles,
    statSync: () => {
      const m = mtimes[Math.min(tick, mtimes.length - 1)];
      if (m === null) throw new Error("ENOENT");
      return { mtimeMs: m };
    },
    readVisitsSince: async (path: string) => {
      calls.push(path);
      return { rows, watermark: "0", degraded: false, reason: null };
    },
    readFileSync: () => { throw new Error("ENOENT"); },
  };
  return { deps, calls, wrote, advance: () => { tick++; } };
}

beforeEach(() => invalidateBrowserWatchCache());

describe("which tabs are the deck's own", () => {
  it("covers both ports the real profile caught it opening", () => {
    // Measured, not hypothetical: 41 visits to 127.0.0.1:4317 and 34 to
    // 127.0.0.1:4399 carried FROM_API, because `open` is an API call and the
    // deck takes a random port in 4318-4400 when 4317 is held. Excluding only
    // this process's port would have left the other one reporting as an
    // intruder on a machine that has been running decks for a month.
    const origins = deckOwnOrigins();
    expect(origins).toContain("http://127.0.0.1:4317");
    expect(origins).toContain("http://127.0.0.1:4399");
    expect(origins).toContain("http://127.0.0.1:4400");
  });

  it("stops at the range the deck documents, so a dev server is still reported", () => {
    // The cost of the whole-range shortcut, pinned. A user's own server on 3000
    // or 44440 is exactly the kind of program-driven navigation this panel is
    // for, and swallowing every loopback port to save bookkeeping would have
    // hidden it.
    const origins = deckOwnOrigins();
    expect(origins).not.toContain("http://127.0.0.1:3000");
    expect(origins).not.toContain("http://127.0.0.1:44440");
    expect(origins).not.toContain("http://127.0.0.1:4316");
    expect(origins).toHaveLength(4400 - 4317 + 1);
  });
});

describe("paying for a read only when there is something to read", () => {
  it("reads once for an mtime that has not moved", async () => {
    // The whole reason a panel can poll this. A History file the browser has
    // not written to cannot have new visits in it, so the second look costs a
    // stat and nothing else — which is the state a machine sits in for an
    // entire weekend, and the state in which this feature matters most.
    const h = harness();
    await browserWatchSnapshot({ deps: h.deps });
    await browserWatchSnapshot({ deps: h.deps });
    expect(h.calls).toEqual(["/p/History"]);
  });

  it("reads again as soon as the browser has written", async () => {
    // The other half, and the one that makes the case above safe rather than
    // merely cheap: a cache nothing invalidates is a panel that stops updating.
    const h = harness({ mtimes: [1, 2] });
    await browserWatchSnapshot({ deps: h.deps });
    h.advance();
    await browserWatchSnapshot({ deps: h.deps });
    expect(h.calls).toEqual(["/p/History", "/p/History"]);
  });

  it("does not read a profile whose history file is not there", async () => {
    // Five of the eight roots on a real machine are browsers the user does not
    // have. Reporting them as degraded costs nothing; trying to copy them costs
    // an exception per poll per browser.
    const h = harness({ mtimes: [null] });
    const snap = await browserWatchSnapshot({ deps: h.deps });
    expect(h.calls).toEqual([]);
    expect(snap.profiles[0].reason).toBe("no-history-file");
    expect(snap.degraded).toBe(true);
  });
});

describe("what a forced read is allowed to spend", () => {
  it("refuses a second force inside the floor", async () => {
    // `?refresh=1` drops the cache and copies every profile's database, and a
    // GET can be sent by any page the user has open — see the census in
    // codex-usage-forced-read-guard.test.ts. Without this the loop is unbounded
    // disk traffic on their machine from a tab they are not looking at.
    const h = harness();
    expect(mayForceRead(), "nothing has been forced yet").toBe(true);
    await fetchBrowserWatch({ force: true, deps: h.deps });
    expect(mayForceRead(), "a force one millisecond later is refused").toBe(false);
    expect(mayForceRead(Date.now() + 60_001), "and allowed again past the floor").toBe(true);
  });

  it("does not re-read for a force the floor turned down", async () => {
    // The floor is only worth having if the refusal reaches the cost. A refused
    // force that still cleared the cache would be the loop this exists to stop,
    // one indirection further along.
    const h = harness();
    await fetchBrowserWatch({ force: true, deps: h.deps });
    await fetchBrowserWatch({ force: true, deps: h.deps });
    expect(h.calls).toEqual(["/p/History"]);
  });

  it("hands a concurrent caller the read already running", async () => {
    // The floor bounds how often a NEW read starts; this bounds how many run at
    // once. Ten requests arriving before the first finishes would otherwise be
    // ten concurrent copies of one database, every one of them let through
    // because none had completed to move the floor's clock.
    const h = harness();
    const [a, b] = await Promise.all([
      fetchBrowserWatch({ deps: h.deps }),
      fetchBrowserWatch({ deps: h.deps }),
    ]);
    expect(a).toBe(b);
    expect(h.calls).toEqual(["/p/History"]);
  });
});

describe("what the badge counts", () => {
  it("counts episodes that began after the reader last looked", () => {
    const eps = [
      { host: "a", startMs: 100, endMs: 200, count: 1, urls: [] },
      { host: "b", startMs: 300, endMs: 400, count: 1, urls: [] },
    ];
    expect(unseenEpisodes(eps, 0)).toHaveLength(2);
    expect(unseenEpisodes(eps, 200).map(e => e.host)).toEqual(["b"]);
    expect(unseenEpisodes(eps, 400)).toHaveLength(0);
  });

  it("keys on the start, so a growing episode does not flip back to unread", () => {
    // An episode is still being added to while the program is working. Keyed on
    // `endMs`, every new page in a run the reader has already seen would light
    // the badge again — and a badge that returns without anything new happening
    // is one people learn to ignore, which costs it the day it is right.
    const before = [{ host: "a", startMs: 100, endMs: 200, count: 1, urls: [] }];
    const after = [{ host: "a", startMs: 100, endMs: 9_000, count: 9, urls: [] }];
    expect(unseenEpisodes(before, 500)).toHaveLength(0);
    expect(unseenEpisodes(after, 500)).toHaveLength(0);
  });

  it("stores the reading position under the namespace the rename left behind", () => {
    // display-name.test.ts sweeps for this, but the value matters here too: the
    // key is a reading position, so a changed key silently re-lights the badge
    // for everything. It changed once already, in review.
    expect(SEEN_KEY).toMatch(/^agent-dag\./);
  });
});

describe("how App.tsx wires it up", () => {
  const app = src("../App.tsx");

  it("feeds the badge from its own poll, not from opening the dialog", () => {
    // A badge that appears only once you have already looked is not a badge.
    expect(app).toMatch(/fetch\("\/api\/browser-watch"\)/);
    expect(app).toMatch(/setInterval\(pull, 5 \* 60_000\)/);
  });

  it("marks the episodes read on the way out of the dialog", () => {
    expect(app).toMatch(/localStorage\.setItem\(SEEN_KEY, String\(ms\)\)/);
  });

  it("says whether the watch is armed, in the shape and not only the hue", () => {
    // The topbar is where a person finds out without opening anything, and at
    // 13px a hue change does not carry it — ambient.ts measured the same amber
    // and grey at 1.01:1 under protanopia. So the two states are a pupil and a
    // slash, which differ as silhouettes at any size, and the colour only
    // agrees with them.
    expect(app).toMatch(/watchOn \|\| watchUnseen > 0/);
    expect(app, "the armed icon needs its filled pupil").toMatch(/<circle cx="7" cy="7" r="1\.8" fill="currentColor"/);
    expect(app, "the resting icon needs its slash").toMatch(/<line x1="2\.4" y1="11\.6" x2="11\.6" y2="2\.4"/);
    // And in words, for anyone who reads the button rather than sees it.
    expect(app).toMatch(/Browser watch, \$\{watchOn \? "watching" : "not watching"\}/);
  });

  it("learns the armed state from the poll it already runs", () => {
    // Not from opening the dialog: the whole point is that the topbar answers
    // the question before anything is opened.
    expect(app).toMatch(/setWatchOn\(j\.settings\?\.enabled === true\)/);
  });

  it("gates the canvas shortcuts while it is up, like every other dialog", () => {
    // A click on the dialog's prose drops focus to <body>, and from there a
    // stray "c" would reach Clear behind it.
    expect(app).toMatch(/\|\| browserWatchOpen \|\| keyHelpOpen/);
  });
});

describe("erasing what an older rule left behind", () => {
  it("writes the file back rather than only hiding the rows", async () => {
    // "Nothing from before the watch is kept" is a claim about the DISK, not
    // only about the screen. readStore refuses to write it away itself — a read
    // with a side effect is a trap for the next caller — so it reports and the
    // snapshot performs.
    const server = src("../../server/browser-watch.mjs");
    expect(server).toMatch(/if \(store\.migrated\) \{/);
    expect(server).toMatch(/episodes: \[\] \}, undefined, deps\)/);
    const store = src("../../server/browser-watch-store.mjs");
    expect(store, "readStore must not write").not.toMatch(/export async function readStore[\s\S]{0,900}writeFile/);
  });
});

describe("the floor the watch reads from", () => {
  it("is the deck's start, not the moment the panel was first opened", async () => {
    // This module is imported lazily, on the first request to the panel. Taking
    // `Date.now()` at load therefore meant "when somebody first opened Browser
    // Watch" — so a deck that had been running an hour lost that hour while the
    // panel claimed to cover it. Found by driving a real navigation and finding
    // it invisible: the floor was two seconds newer than the visit.
    const server = src("../../server/browser-watch.mjs");
    expect(server).toMatch(/Date\.now\(\) - Math\.round\(process\.uptime\(\) \* 1000\)/);
  });

  it("reports that floor, so the panel can say since when", async () => {
    const h = harness();
    const snap = await browserWatchSnapshot({ deps: h.deps });
    expect(typeof snap.coverage.startedMs).toBe("number");
    // Not in the future, and not the epoch: it is a real moment this process
    // can name.
    expect(snap.coverage.startedMs).toBeLessThanOrEqual(Date.now());
    expect(snap.coverage.startedMs).toBeGreaterThan(Date.now() - 86_400_000);
  });
});

describe("one machine, one store, usually more than one deck", () => {
  /** One program navigation in silence — enough that there IS something to
   *  record, which is what makes the two cases below able to fail. */
  const FROM_API = 0x08000000;
  const finding = (atMs: number) => ({
    url: "https://gitlab.example.com/-/jobs", timeMs: atMs, transition: FROM_API,
  });

  const armed = (extra: Record<string, unknown>) => ({
    ...harness({ rows: [finding(Date.now() - 5_000)] }).deps,
    react: async () => ["notified"],
    ...extra,
  });

  it("records and reacts from a single deck", async () => {
    // Both decks read the same Chrome history and find the same new episode, so
    // without a rule each writes a line and fires a notification: one event,
    // told twice. Verified rather than assumed — two decks were live on this
    // machine when this was written, so it is the ordinary case.
    let wrote = 0;
    await browserWatchSnapshot({ deps: armed({
      isReactingDeck: () => false,
      writeStore: async () => { wrote += 1; },
    }) });
    expect(wrote, "the deck that is not elected wrote anyway").toBe(0);

    // And the elected one does write, so the case cannot pass by finding
    // nothing to record.
    let wroteWinner = 0;
    await browserWatchSnapshot({ deps: armed({
      isReactingDeck: () => true,
      writeStore: async () => { wroteWinner += 1; },
    }) });
    expect(wroteWinner, "the elected deck recorded nothing").toBeGreaterThan(0);
  });

  it("never reacts twice for one event", async () => {
    // The consequence that reaches the user: two notifications for one episode,
    // and two lines in the log they inspect later.
    let reacted = 0;
    const count = { react: async () => { reacted += 1; return ["notified"]; } };
    await browserWatchSnapshot({ deps: armed({ isReactingDeck: () => false, ...count }) });
    expect(reacted).toBe(0);
    await browserWatchSnapshot({ deps: armed({ isReactingDeck: () => true, ...count }) });
    expect(reacted).toBe(1);
  });

  it("still SHOWS everything on the deck that is not recording", async () => {
    // A second panel that went blank would be a worse bug than the one this
    // prevents. Reading the store is free; only the writing is exclusive.
    const snap = await browserWatchSnapshot({ deps: armed({ isReactingDeck: () => false }) });
    expect(snap.ok).toBe(true);
    expect(snap.episodes.length, "the unelected deck shows nothing").toBeGreaterThan(0);
  });

  it("assumes it is alone when it cannot see the other decks", async () => {
    // A deck that cannot read the discovery directory must not fall silent —
    // for the common case of one deck, "alone" is the right answer anyway, and
    // the failure mode of the opposite choice is a watch that never reports.
    const server = src("../../server/browser-watch.mjs");
    expect(server).toMatch(/catch \{ return true; \}\s+\/\/ cannot look/);
  });

  it("claims nothing on disk to decide it", () => {
    // The shell tool this descends from lost its lock on SIGHUP and then
    // refused to watch anything ever again. This reads and compares; there is
    // no claim to strand.
    const server = src("../../server/browser-watch.mjs");
    const fn = server.slice(server.indexOf("async function isReactingDeck"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toMatch(/writeFile|mkdir|open\(|rename/);
    expect(body).toMatch(/process\.kill\(d\.pid, 0\)/);
  });
});

describe("a log a person can read", () => {
  it("writes nothing for a poll that found the file unchanged", async () => {
    // The Log view polls every ten seconds while it is open, and one line per
    // profile per poll is twelve lines a minute of nothing — which buried the
    // one line saying a visit had been read. The view answering "is this
    // working" answered it by making its own answer unfindable.
    const server = src("../../server/browser-watch.mjs");
    expect(server).not.toMatch(/unchanged, nothing to re-read/);
    expect(server).toMatch(/else if \(read\.cached\) \{ \/\* silent \*\/ \}/);
  });

  it("proves it is alive with a number, not with a row", () => {
    // This used to be a five-minute heartbeat line. It proved the watch was
    // running by writing into the feed it was reporting on — and the feed is
    // bounded at 200, so on a machine somebody browses, bookkeeping does not
    // merely clutter it, it evicts the findings the panel exists to show.
    // A count and a timestamp say the same thing and cost no rows.
    const server = src("../../server/browser-watch.mjs");
    expect(server, "the heartbeat row is back").not.toMatch(/still watching \$\{quiet\}/);
    expect(server).toMatch(/checkedMs: _checkedMs,/);
    expect(server).toMatch(/checks: _checks,/);
  });

  it("stamps the check when the poll FINISHED, not when it began", () => {
    // The difference shows on the first look, which copies every database and
    // can take a second — a stamp taken at the start would claim the deck had
    // just finished looking while it was still looking.
    const server = src("../../server/browser-watch.mjs");
    const assign = server.indexOf("_checkedMs = now;");
    const survey = server.indexOf("const browsers = await surveyBrowsers");
    expect(assign, "_checkedMs is never assigned").toBeGreaterThan(0);
    expect(assign, "the stamp is taken before the work it claims to have finished")
      .toBeLessThan(survey);
    expect(server.slice(0, assign)).toContain("const episodes = enabled ? kept : live;");
  });
});

describe("a history file that has not moved", () => {
  const FROM_API = 0x08000000;
  const finding = (atMs: number) => ({
    url: "https://gitlab.example.com/-/jobs", timeMs: atMs, transition: FROM_API,
  });

  /** Two polls against one profile: the first reads the file, the second finds
   *  its mtime unchanged and is served from the cache. */
  const twoPolls = async (enabled: boolean) => {
    const h = harness({ rows: [finding(Date.now() - 5_000)], mtimes: [1, 1] });
    const deps = {
      ...h.deps,
      readStore: async () => ({
        settings: { v: 1, enabled, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
        episodes: [],
        migrated: false,
      }),
      isReactingDeck: () => false,
    };
    const first = await browserWatchSnapshot({ deps });
    h.advance();
    const second = await browserWatchSnapshot({ deps });
    return { first, second, reads: h.calls.length };
  };

  it("is served from the cache, so the second poll costs nothing", async () => {
    // The premise the rest of this rests on. Without it the case below would
    // pass by re-reading rather than by remembering.
    const { reads } = await twoPolls(false);
    expect(reads, "the unchanged file was read twice").toBe(1);
  });

  it("still reports what it found, with the watch off", async () => {
    // THE BUG THIS PINS. "Unchanged since you last looked" was being read as
    // "empty", so a cached poll produced no findings at all. With the watch ON
    // the archive in the store hid it — the episodes were still on screen,
    // carried by a different code path. With it OFF there is no archive, and
    // the list emptied itself one poll after opening the panel, while the
    // switch's own tooltip promised the opposite: "the list is still read live
    // from the browser's own history".
    const { first, second } = await twoPolls(false);
    expect(first.episodes.length, "nothing was found on the first read").toBe(1);
    expect(second.episodes.length, "a cached poll erased the live list").toBe(1);
  });

  it("still knows when a person last browsed", async () => {
    // The same erasure, with a second consequence: the bar reads lastHumanMs to
    // say "you are browsing · counts in 14m". A cached poll that forgot it
    // would drop the countdown and claim the gate was already open — the panel
    // saying a program page would be reported when it would not.
    const human = Date.now() - 30_000;
    const h = harness({
      rows: [finding(Date.now() - 5_000), { url: "https://example.com", timeMs: human, transition: 0 }],
      mtimes: [1, 1],
    });
    const deps = {
      ...h.deps,
      readStore: async () => ({
        settings: { v: 1, enabled: false, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
        episodes: [],
        migrated: false,
      }),
      isReactingDeck: () => false,
    };
    const first = await browserWatchSnapshot({ deps });
    h.advance();
    const second = await browserWatchSnapshot({ deps });
    expect(first.coverage.lastHumanMs).toBe(human);
    expect(second.coverage.lastHumanMs, "a cached poll forgot the last person").toBe(human);
  });
});

describe("what the test suite is allowed to touch", () => {
  it("reaches no real config directory, whatever this machine's watch is set to", async () => {
    // THE REGRESSION THIS STOPS. The harness used to stub the profile discovery
    // and the history read but not the store, so a snapshot here read the
    // developer's own settings, ran the real deck election, elected itself, and
    // wrote this file's fixture host into
    // ~/.claude/agent-dag/browser-watch/state.json. It then appeared in a
    // running deck's panel as an episode that never happened, with a badge
    // counting it.
    //
    // Asserted against the store module's own path rather than a guess, so a
    // future change to where the store lives cannot quietly re-open the hole.
    const { storePath, logPath } = await import("../../server/browser-watch-store.mjs");
    const stamp = (p: string) => {
      try { return statSync(p).mtimeMs; } catch { return null; }
    };
    const before = [stamp(storePath()), stamp(logPath())];

    const FROM_API = 0x08000000;
    const h = harness({
      rows: [{ url: "https://nowhere.invalid/x", timeMs: Date.now() - 5_000, transition: FROM_API }],
    });
    // Elected on purpose: the deck that IS recording is the one that would
    // write, so this is the case that could fail rather than the one that
    // cannot.
    await browserWatchSnapshot({ deps: { ...h.deps, isReactingDeck: () => true } });

    expect(h.wrote.length, "the elected deck wrote nothing, so this proves nothing").toBeGreaterThan(0);
    expect([stamp(storePath()), stamp(logPath())], "a test wrote to the real store").toEqual(before);
  });
});
