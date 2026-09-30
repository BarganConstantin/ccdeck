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
import { describe, it, expect, vi } from "vitest";
import { join, resolve } from "node:path";
import { clientText } from "./client-source";
import { browserWatchSurface } from "./browser-watch-surface";
import { guardThisMachine } from "./browser-watch-guard";
import { linuxMachine } from "./linux-browser-fixture";

// Sandboxed BEFORE the server module is imported: it resolves its config
// directories at import time. The sandbox is the guard's temp home, which keeps
// the browser survey off this machine as well (#1847): see
// browser-watch-guard.ts.
vi.mock("node:child_process", async (real) =>
  (await import("./browser-watch-guard")).trappedChildProcess(await real()));
const { home: DIR } = guardThisMachine();
vi.stubEnv("CODEX_HOME", join(DIR, "codex"));
if (!resolve(String(process.env.CLAUDE_CONFIG_DIR)).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — .mjs server module, no types
const { browserWatchSnapshot, invalidateBrowserWatchCache } = await import("../../server/browser-watch.mjs");

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
      ...linuxMachine().deps,
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
    // The badge's poll lives in use-browser-watch-badge.ts now.
    const app = clientText();
    // The panel's reads live in use-browser-watch.ts, one of the files it is made of.
    const modal = browserWatchSurface();
    expect(app).toContain('fetch("/api/browser-watch?live=0")');
    expect(modal).toContain('fetch(`/api/browser-watch${refresh ? "?refresh=1" : ""}`)');
  });

  // What the route does with it is watch-off-route.test.ts's: that case boots a
  // whole deck, which this file's guard does not allow.
});
