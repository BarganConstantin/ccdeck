// How a new install arrived, on its first "install" report: ccdeck.dev's
// one-line install on macOS (curl) or Windows (irm), a downloaded installer,
// npx or npm (depth-facts.mjs installVia, reports.mjs).
//
// The one-line installs say so in a file: their script writes one word,
// `install-via`, in a fixed place just before it opens the app. What these
// pin: the five words and nothing else, the channel's answer, the mark's place
// on each platform (never moved by CCDECK_HOME or CLAUDE_CONFIG_DIR), that a
// mark counts only while it is one of the two words and at most a week old,
// that it is deleted once the install report is settled or at once when this
// install has reported before, that a mark which will not read or will not go
// never costs a report anything, and that the update report is as it was.
//
// Every file here lives in a temp folder handed in as the home: no test reads
// or deletes a mark in a real home, and the API is a recorder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect, vi } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { INSTALL_MARK_FRESH_MS, INSTALL_VIAS, installMarkFile, installMarkPath, installVia } from "../../server/depth-facts.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-04T10:00:00Z");

type Mark = { read: () => Promise<unknown>; remove: () => Promise<void> };

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

/** A home of its own, with the macOS mark written in it `age` ms before NOW. */
function macHome(content: string | null, age = HOUR) {
  const home = mkdtempSync(join(tmpdir(), "install-via-"));
  homes.push(home);
  const path = join(home, "Library", "Application Support", "ccdeck", "install-via");
  if (content !== null) {
    mkdirSync(join(home, "Library", "Application Support", "ccdeck"), { recursive: true });
    writeFileSync(path, content);
    const at = new Date(NOW.getTime() - age);
    utimesSync(path, at, at);
  }
  return { home, path, mark: installMarkFile({ platform: "darwin", env: {}, home }) as Mark };
}

/** A reporter on a fixed clock and a prefs store in memory, with the API recorded. */
function harness({ channel = "desktop", npx = false } = {}) {
  let prefs = normalise({});
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let answer: "ok" | "offline" | "refused" = "ok";
  const fetchImpl = async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : {} });
    if (answer === "offline") throw new Error("offline");
    if (answer === "refused") {
      return { ok: false, status: 422, headers: { get: (k: string) => (k === "content-type" ? "application/problem+json" : null) } };
    }
    return { ok: true, status: 202 };
  };
  const make = (version: string, installMark: Mark | null) => createReporter({
    fetchImpl, now: () => NOW, prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
    facts: { version, os: channel === "desktop" ? "darwin" : "linux", arch: "arm64", channel, runtime: "node-22.18.0" },
    usage: createUsageDay({ now: () => NOW }), setup: () => ({}), setupKnown: () => Promise.resolve(),
    firstRun: () => true, npx, installMark,
  });
  return {
    make, calls, prefs: () => prefs,
    answer: (a: typeof answer) => { answer = a; },
    events: (kind: string) => calls.filter(c => c.url.endsWith("/v1/app/events") && c.body.kind === kind).map(c => c.body),
  };
}

describe("the ways an install arrives", () => {
  it("are five words, and the API keeps the same ones", () => {
    expect(INSTALL_VIAS).toEqual(["curl", "irm", "download", "npx", "npm"]);
    expect(INSTALL_MARK_FRESH_MS).toBe(7 * DAY);
  });

  it("are npx or npm for an npm install, and nothing for a source checkout", () => {
    expect(installVia({ channel: "npm", npx: true, now: NOW })).toBe("npx");
    expect(installVia({ channel: "npm", npx: false, now: NOW })).toBe("npm");
    // A mark is the desktop app's: it says nothing about an npm install.
    expect(installVia({ channel: "npm", mark: { content: "curl", mtimeMs: NOW.getTime() }, now: NOW })).toBe("npm");
    expect(installVia({ channel: "checkout", mark: { content: "curl", mtimeMs: NOW.getTime() }, now: NOW })).toBeUndefined();
    expect(installVia({ channel: "elsewhere", now: NOW })).toBeUndefined();
  });

  it("are the one-line install's word for the desktop app while its mark is fresh", () => {
    const fresh = NOW.getTime() - HOUR;
    expect(installVia({ channel: "desktop", mark: { content: "curl", mtimeMs: fresh }, now: NOW })).toBe("curl");
    expect(installVia({ channel: "desktop", mark: { content: "irm", mtimeMs: fresh }, now: NOW })).toBe("irm");
    // Trimmed: a newline after the word, or a byte-order mark before it, is still the word.
    expect(installVia({ channel: "desktop", mark: { content: " irm\r\n", mtimeMs: fresh }, now: NOW })).toBe("irm");
    expect(installVia({ channel: "desktop", mark: { content: "\uFEFFcurl\n", mtimeMs: fresh }, now: NOW })).toBe("curl");
    // A week to the millisecond still counts.
    expect(installVia({ channel: "desktop", mark: { content: "curl", mtimeMs: NOW.getTime() - 7 * DAY }, now: NOW })).toBe("curl");
  });

  it("are a download for the desktop app with a stale, junk or missing mark", () => {
    expect(installVia({ channel: "desktop", mark: { content: "curl", mtimeMs: NOW.getTime() - 8 * DAY }, now: NOW })).toBe("download");
    expect(installVia({ channel: "desktop", mark: { content: "irm", mtimeMs: NOW.getTime() - 7 * DAY - 1 }, now: NOW })).toBe("download");
    for (const junk of ["", "wget", "CURL", "curl irm", "brew", "curl\nirm", "download", "npx"]) {
      expect(installVia({ channel: "desktop", mark: { content: junk, mtimeMs: NOW.getTime() }, now: NOW }), junk).toBe("download");
    }
    expect(installVia({ channel: "desktop", mark: null, now: NOW })).toBe("download");
    expect(installVia({ channel: "desktop", now: NOW })).toBe("download");
    // A mark whose age cannot be told is not trusted.
    expect(installVia({ channel: "desktop", mark: { content: "curl" }, now: NOW })).toBe("download");
    expect(installVia({ channel: "desktop", mark: { content: 7, mtimeMs: NOW.getTime() }, now: NOW })).toBe("download");
  });
});

describe("where the mark is", () => {
  it("is ccdeck's folder under Application Support on macOS, whatever the deck's home is", () => {
    const want = "/Users/a/Library/Application Support/ccdeck/install-via";
    expect(installMarkPath("darwin", {}, "/Users/a")).toBe(want);
    // Fixed: the scripts cannot know where somebody pointed the deck.
    expect(installMarkPath("darwin", { CCDECK_HOME: "/elsewhere", CLAUDE_CONFIG_DIR: "/other" }, "/Users/a")).toBe(want);
  });

  it("is ccdeck's folder under %LOCALAPPDATA% on Windows, joined the Windows way from any machine", () => {
    expect(installMarkPath("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a"))
      .toBe("C:\\Users\\a\\AppData\\Local\\ccdeck\\install-via");
    // Not under the deck's Data folder, and not moved by CCDECK_HOME.
    expect(installMarkPath("win32", { LOCALAPPDATA: "D:\\L", CCDECK_HOME: "E:\\deck" }, "C:\\Users\\a")).toBe("D:\\L\\ccdeck\\install-via");
    // An environment with no LOCALAPPDATA: the folder it points at on every Windows since Vista.
    expect(installMarkPath("win32", {}, "C:\\Users\\a")).toBe("C:\\Users\\a\\AppData\\Local\\ccdeck\\install-via");
  });

  it("is nowhere on Linux or anything else", () => {
    expect(installMarkPath("linux", {}, "/home/a")).toBeNull();
    expect(installMarkPath("freebsd", {}, "/home/a")).toBeNull();
  });
});

describe("the mark, read and taken away", () => {
  it("reads the word and the file's age, and says nothing for a mark that is not there", async () => {
    const { mark, path } = macHome("curl", 3 * DAY);
    const read = await mark.read() as { content: string; mtimeMs: number };
    expect(read.content).toBe("curl");
    expect(Math.abs(read.mtimeMs - (NOW.getTime() - 3 * DAY))).toBeLessThan(1000);
    expect(installVia({ channel: "desktop", mark: read, now: NOW })).toBe("curl");

    await mark.remove();
    expect(existsSync(path)).toBe(false);
    expect(await mark.read()).toBeNull();
    // Removing a mark that is gone is not an error.
    await expect(mark.remove()).resolves.toBeUndefined();
  });

  it("says download for a mark eight days old, or one that is no word at all", async () => {
    const stale = macHome("irm", 8 * DAY);
    expect(installVia({ channel: "desktop", mark: await stale.mark.read(), now: NOW })).toBe("download");
    const big = macHome("curl".repeat(100));
    expect(await big.mark.read()).toBeNull();
    const junk = macHome("hello");
    expect(installVia({ channel: "desktop", mark: await junk.mark.read(), now: NOW })).toBe("download");
  });

  it("is never read on Linux, where the desktop app is always a download", async () => {
    // The same file, where macOS would look for it, in a home read as Linux's.
    const { home, path } = macHome("curl");
    const linux = installMarkFile({ platform: "linux", env: {}, home });
    expect(await linux.read()).toBeNull();
    expect(installVia({ channel: "desktop", mark: await linux.read(), now: NOW })).toBe("download");
    await linux.remove();
    expect(existsSync(path)).toBe(true);
  });

  it("goes through the file system it is handed, and never throws when that fails", async () => {
    const seen: string[] = [];
    const broken = {
      stat: async (p: string) => { seen.push(p); throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      readFile: async () => { throw new Error("unreached"); },
      unlink: async (p: string) => { seen.push(p); throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    };
    const mark = installMarkFile({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\Users\\a", fs: broken });
    expect(await mark.read()).toBeNull();
    await expect(mark.remove()).resolves.toBeUndefined();
    expect(seen).toEqual(["C:\\L\\ccdeck\\install-via", "C:\\L\\ccdeck\\install-via"]);
  });
});

describe("the install report", () => {
  it("says the one-line install the mark names, then deletes the mark", async () => {
    const { mark, path } = macHome("curl");
    const h = harness();
    await h.make("3.82.0", mark).checkIn();

    const [install] = h.events("install");
    expect(install).toMatchObject({ kind: "install", channel: "desktop", via: "curl" });
    expect(existsSync(path)).toBe(false);
    expect(h.prefs().report.lastVersion).toBe("3.82.0");
  });

  it("says irm for the Windows one", async () => {
    const files = new Map([["C:\\L\\ccdeck\\install-via", "irm"]]);
    const fs = {
      stat: async (p: string) => {
        if (!files.has(p)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { size: files.get(p)!.length, mtimeMs: NOW.getTime() - HOUR };
      },
      readFile: async (p: string) => files.get(p)!,
      unlink: async (p: string) => { files.delete(p); },
    };
    const h = harness();
    await h.make("3.82.0", installMarkFile({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\Users\\a", fs })).checkIn();
    expect(h.events("install")[0]).toMatchObject({ via: "irm" });
    expect(files.size).toBe(0);
  });

  it("says download for a desktop install with no mark, or a stale one", async () => {
    const none = harness();
    await none.make("3.82.0", macHome(null).mark).checkIn();
    expect(none.events("install")[0]).toMatchObject({ via: "download" });

    const { mark, path } = macHome("curl", 8 * DAY);
    const stale = harness();
    await stale.make("3.82.0", mark).checkIn();
    expect(stale.events("install")[0]).toMatchObject({ via: "download" });
    // Read and settled: gone, stale or not.
    expect(existsSync(path)).toBe(false);
  });

  it("keeps the mark while the install cannot get out, and says it on the next try", async () => {
    const { mark, path } = macHome("curl");
    const h = harness();
    const r = h.make("3.82.0", mark);
    h.answer("offline");
    await r.checkIn();
    expect(existsSync(path)).toBe(true);
    expect(h.prefs().report.lastVersion).toBe("");

    h.answer("ok");
    await r.checkIn();
    const installs = h.events("install");
    expect(installs).toHaveLength(2);
    expect(installs[1]).toMatchObject({ via: "curl" });
    expect(existsSync(path)).toBe(false);
  });

  it("deletes the mark when the API refuses the install for good, as it does when it takes it", async () => {
    const { mark, path } = macHome("irm");
    const h = harness();
    h.answer("refused");
    await h.make("3.82.0", mark).checkIn();
    expect(h.events("install")[0]).toMatchObject({ via: "irm" });
    expect(existsSync(path)).toBe(false);
  });

  it("deletes a mark beside an install that already reported, and sends no second install", async () => {
    const h = harness();
    await h.make("3.81.0", null).checkIn();
    expect(h.events("install")).toHaveLength(1);
    expect(h.events("install")[0]).toMatchObject({ via: "download" });

    // A one-line install run again over it, the same version or a newer one.
    const same = macHome("curl");
    await h.make("3.81.0", same.mark).checkIn();
    expect(existsSync(same.path)).toBe(false);

    const newer = macHome("curl");
    await h.make("3.82.0", newer.mark).checkIn();
    expect(existsSync(newer.path)).toBe(false);
    expect(h.events("install")).toHaveLength(1);
  });

  it("goes out whole when the mark will not read or will not go", async () => {
    const throwing: Mark = {
      read: async () => { throw new Error("unreadable"); },
      remove: async () => { throw new Error("read-only folder"); },
    };
    const h = harness();
    const r = h.make("3.82.0", throwing);
    await expect(r.checkIn()).resolves.toBeUndefined();
    expect(h.events("install")[0]).toMatchObject({ via: "download" });
    expect(h.events("active")).toHaveLength(1);
    expect(h.prefs().report.lastVersion).toBe("3.82.0");

    // A real mark in a folder whose delete fails: said, kept, and nothing thrown.
    const { home, path } = macHome("curl");
    const failing = installMarkFile({
      platform: "darwin", env: {}, home,
      fs: { ...(await import("node:fs/promises")), unlink: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } },
    });
    const h2 = harness();
    await expect(h2.make("3.82.0", failing).checkIn()).resolves.toBeUndefined();
    expect(h2.events("install")[0]).toMatchObject({ via: "curl" });
    expect(existsSync(path)).toBe(true);
  });

  it("is npx or npm for an npm deck, which never reads or deletes a mark", async () => {
    const mark = { read: vi.fn(async () => ({ content: "curl", mtimeMs: NOW.getTime() })), remove: vi.fn(async () => {}) };

    const npx = harness({ channel: "npm", npx: true });
    await npx.make("3.82.0", mark).checkIn();
    expect(npx.events("install")[0]).toMatchObject({ via: "npx" });

    const npm = harness({ channel: "npm" });
    await npm.make("3.82.0", mark).checkIn();
    await npm.make("3.83.0", mark).checkIn();
    expect(npm.events("install")[0]).toMatchObject({ via: "npm" });

    expect(mark.read).not.toHaveBeenCalled();
    expect(mark.remove).not.toHaveBeenCalled();
  });

  it("says nothing of how a source checkout arrived", async () => {
    const h = harness({ channel: "checkout" });
    await h.make("3.82.0", null).checkIn();
    expect(h.events("install")[0]).not.toHaveProperty("via");
  });

  it("leaves the update report as it was", async () => {
    const h = harness();
    await h.make("3.81.0", null).checkIn();
    const { installId } = h.prefs().report;
    await h.make("3.82.0", macHome("curl").mark).checkIn();
    // toEqual: the whole of what the update says, the mark nowhere in it.
    expect(h.events("update")).toEqual([{
      installId, kind: "update", fromVersion: "3.81.0", version: "3.82.0", os: "darwin", arch: "arm64",
      channel: "desktop", runtime: "node-22.18.0", via: "desktop-updater",
    }]);
  });

  it("reads the real mark only in the deck's own reporter", () => {
    const src = readFileSync(new URL("../../server/reports.mjs", import.meta.url), "utf8");
    expect(src).toContain("installMark = null,");
    expect(src).toContain("installMark: installMarkFile(),");
  });
});
