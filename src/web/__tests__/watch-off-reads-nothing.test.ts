// A switch that says off while the deck keeps copying the browser's history.
//
// `browserWatchSnapshot` computed its live findings unconditionally: it
// discovered every Chromium profile, COPIED each History database into a temp
// file, queried it, and deleted the copy. `enabled` gated only what was kept and
// what was reacted to. The panel's badge polls that route every five minutes
// from the moment the page loads, so a deck nobody had switched on copied the
// user's complete browsing history every five minutes, undocumented.
//
// Two callers still read live, and both are the user's own doing: a watch that
// is ON, because recording in the background is the feature; and the panel
// itself, because that is somebody looking.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — .mjs server module, no types
const { browserWatchSnapshot, invalidateBrowserWatchCache } = await import("../../server/browser-watch.mjs");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const PROFILE = {
  browser: "brave", name: "Brave", profile: "Default",
  dir: "/p", historyPath: "/p/History", securePrefsPath: "/p/Secure Preferences",
  hasClaudeExt: true,
};

/** A snapshot driven from literals, with every disk read recorded. */
function harness(enabled: boolean) {
  const reads: string[] = [];
  const stats: string[] = [];
  return {
    reads, stats,
    deps: {
      readStore: async () => ({
        settings: { v: 1, enabled, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
        episodes: [], dismissed: [], migrated: false,
      }),
      writeStore: async () => {},
      updateStore: async () => {},
      appendLog: async () => {},
      react: async () => [],
      discoverProfiles: () => { stats.push("discover"); return [PROFILE]; },
      statSync: () => ({ mtimeMs: 1 }),
      readVisitsSince: async (path: string) => {
        reads.push(path);
        return { rows: [], watermark: "0", degraded: false, reason: null };
      },
      readFileSync: () => { throw new Error("ENOENT"); },
    },
  };
}

describe("the badge's poll, with the watch off", () => {
  it("reads no browser at all", async () => {
    invalidateBrowserWatchCache();
    const h = harness(false);
    const snap = await browserWatchSnapshot({ readBrowsers: false, deps: h.deps });
    expect(h.reads, "a History database was copied for a poll that asked not to look").toEqual([]);
    expect(h.stats, "the profiles were discovered anyway").toEqual([]);
    expect(snap.ok).toBe(true);
    expect(snap.coverage.why).toMatch(/watch is off/);
  });

  it("still answers with the archive and the settings, so the panel can draw", async () => {
    invalidateBrowserWatchCache();
    const h = harness(false);
    const snap = await browserWatchSnapshot({ readBrowsers: false, deps: h.deps });
    expect(snap.settings.enabled).toBe(false);
    expect(Array.isArray(snap.episodes)).toBe(true);
    expect(Array.isArray(snap.reactions)).toBe(true);
    expect(snap.degraded).toBe(false);
  });
});

describe("when it does read", () => {
  it("reads for a watch that is on, whatever the poll asked for", async () => {
    // Recording in the background IS the feature. A `live=0` poll must not
    // switch it off by the back door.
    invalidateBrowserWatchCache();
    const h = harness(true);
    await browserWatchSnapshot({ readBrowsers: false, deps: h.deps });
    expect(h.reads).toEqual(["/p/History"]);
  });

  it("reads when the panel is the caller, watch off or not", async () => {
    invalidateBrowserWatchCache();
    const h = harness(false);
    await browserWatchSnapshot({ deps: h.deps });          // no readBrowsers: the default is the panel
    expect(h.reads).toEqual(["/p/History"]);
  });
});

describe("who asks for what", () => {
  it("the badge poll sends live=0 and the panel does not", () => {
    const app = read("../App.tsx");
    const modal = read("../components/BrowserWatchModal.tsx");
    expect(app).toContain('fetch("/api/browser-watch?live=0")');
    expect(modal).toContain('fetch(`/api/browser-watch${refresh ? "?refresh=1" : ""}`)');
  });

  it("a forced read overrides it, because that is the ↻ being pressed", () => {
    const server = read("../../server/index.mjs");
    expect(server).toContain('const readBrowsers = force || url.searchParams.get("live") !== "0";');
  });
});
