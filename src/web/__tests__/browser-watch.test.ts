// The composition layer, which is where the four readers stop being separately
// correct and start being one answer.
//
// Everything asserted here is something no single reader could get wrong on its
// own: which tabs are the deck's, when a read is worth paying for, what an
// unreadable hosts file is allowed to claim, and what the topbar badge counts.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  browserWatchSnapshot,
  deckOwnOrigins,
  fetchBrowserWatch,
  invalidateBrowserWatchCache,
  mayForceRead,
  relayState,
} from "../../server/browser-watch.mjs";
import { unseenEpisodes, SEEN_KEY } from "../components/BrowserWatchModal";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const src = (rel: string) => readFileSync(at(rel), "utf8");

const PROFILE = {
  browser: "brave", name: "Brave", profile: "Default",
  dir: "/p", historyPath: "/p/History", securePrefsPath: "/p/Secure Preferences",
  hasClaudeExt: true,
};

/** A snapshot driven entirely from literals: no disk, no browser, no clock. */
function harness({ rows = [] as any[], mtimes = [1] as (number | null)[], profiles = [PROFILE] } = {}) {
  const calls: string[] = [];
  let tick = 0;
  const deps = {
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
  return { deps, calls, advance: () => { tick++; } };
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

describe("what an unreadable hosts file is allowed to claim", () => {
  it("says it does not know, rather than saying the relay is open", () => {
    // A red EXPOSED banner on the strength of a failed read would put one on
    // every locked-down machine whose /etc/hosts the deck cannot open. Unknown
    // is a different answer from open and this is where they stay different.
    const state = relayState("darwin", {}, { readFileSync: () => { throw new Error("EACCES"); } });
    expect(state.readable).toBe(false);
    expect(state.blocked).toBeNull();
    expect(state.command).toBeNull();
  });

  it("offers the direction the machine is not already in", () => {
    const open = relayState("darwin", {}, { readFileSync: () => "127.0.0.1 localhost\n" });
    expect(open.blocked).toBe(false);
    expect(open.command!.command).toMatch(/\| sudo tee -a \/etc\/hosts/);

    const shut = relayState("darwin", {}, {
      readFileSync: () => "0.0.0.0 bridge.claudeusercontent.com # ccdeck killswitch\n",
    });
    expect(shut.blocked).toBe(true);
    expect(shut.command!.command).toMatch(/sed/);
  });

  it("never returns a command that runs itself", () => {
    // The rule relay-guard.mjs is built around, restated at the layer that
    // hands the string to a route: what comes back is text for a person to
    // paste. Nothing here executes it and nothing here elevates.
    const state = relayState("darwin", {}, { readFileSync: () => "" });
    expect(state.command!.needsAdmin).toBe(true);
    expect(src("../../server/browser-watch.mjs")).not.toMatch(/child_process|execSync|spawn\(/);
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

  it("gates the canvas shortcuts while it is up, like every other dialog", () => {
    // A click on the dialog's prose drops focus to <body>, and from there a
    // stray "c" would reach Clear behind it.
    expect(app).toMatch(/\|\| browserWatchOpen \|\| keyHelpOpen/);
  });
});
