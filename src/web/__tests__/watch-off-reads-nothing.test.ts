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
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Sandboxed BEFORE the server module is imported: it resolves its config
// directories at import time, and the developer's own watch setting — this one
// is on — would otherwise decide what the case below sees.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-watch-off-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

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

  it("reads the flag in the handler that answers this route", async () => {
    // NOT A GREP FOR THE LINE. The first version of this case asserted the
    // source contained `const readBrowsers = …`, and the line had been inserted
    // into handleQuota — a different handler that also parses `refresh` — so
    // the suite was green while every request to /api/browser-watch answered
    // `500 {"error":"internal error"}` with a ReferenceError behind it. A
    // source assertion cannot tell one handler from another; a request can.
    const { startServer } = await import("../../server/index.mjs") as never;
    const server = await startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
    const { port } = server.address() as { port: number };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/browser-watch?live=0`, {
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(r.status, "the route answered an error").toBe(200);
      const body = await r.json() as { ok: boolean; settings: { enabled: boolean }; coverage?: { why?: string } };
      expect(body.ok).toBe(true);
      // On a sandboxed home the watch is off, so `live=0` must be honoured and
      // the reason said out loud.
      expect(body.settings.enabled).toBe(false);
      expect(body.coverage?.why).toMatch(/watch is off/);
    } finally {
      await new Promise(r => server.close(r));
    }
  }, 30_000);
});
