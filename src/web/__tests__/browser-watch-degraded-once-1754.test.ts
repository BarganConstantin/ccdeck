// A Browser Watch profile that stays unreadable wrote the same warning into
// Live Activity on every poll (#1754) — every ten seconds with the panel open —
// and the feed keeps 200 lines, so within about half an hour it held nothing
// else: the reader's own setting changes and the find lines were pushed out.
// No SQLite reader, a profile folder with no History file, a copy that keeps
// failing: each is a state that lasts, and a state is one line when it starts,
// not one per look.
//
// Every dependency that could reach the machine is stubbed: no browser profile,
// hosts file, store or process list is read.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { browserWatchSnapshot, invalidateBrowserWatchCache, noteWatchSetting } from "../../server/browser-watch.mjs";
import { guardThisMachine } from "./browser-watch-guard";

// The survey is stubbed below; the guard is what fails the file if a case ever
// reaches past the stubs to this machine (#1847): see browser-watch-guard.ts.
vi.mock("node:child_process", async (real) =>
  (await import("./browser-watch-guard")).trappedChildProcess(await real()));
guardThisMachine();

let seq = 0;
/** One profile, read through `readVisitsSince`, whose History file has the
 *  mtime `stamp` answers — null for "there is no History file". */
function deck(readVisitsSince: (...a: unknown[]) => Promise<unknown>, stamp: () => number | null = () => 1) {
  const profile = {
    browser: "brave", name: "Brave", profile: `Stuck${++seq}`,
    dir: "/p", historyPath: `/p/History-stuck-${seq}`, securePrefsPath: "/p/Secure Preferences",
    hasClaudeExt: false,
  };
  let reads = 0;
  const deps = {
    readStore: async () => ({
      settings: { v: 1, enabled: false, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
      episodes: [], dismissed: [], migrated: false,
    }),
    writeStore: async () => {},
    appendLog: async () => {},
    react: async () => [],
    isReactingDeck: () => false,
    logSize: async () => 0,
    browserSurvey: async () => [],
    hostsPath: () => "/nonexistent/hosts",
    readFile: async () => { throw new Error("ENOENT"); },
    discoverProfiles: () => [profile],
    statSync: () => {
      const m = stamp();
      if (m === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: m };
    },
    readVisitsSince: async (...a: unknown[]) => { reads += 1; return readVisitsSince(...a); },
  };
  return {
    where: `${profile.name}/${profile.profile}`,
    reads: () => reads,
    poll: () => browserWatchSnapshot({ deps, platform: "linux" }),
  };
}

const noReader = async () => ({
  rows: [], watermark: "0", total: null, degraded: true,
  reason: "no-sqlite-reader: node:sqlite needs Node 22.5+ and no sqlite3 was found on PATH",
});

beforeEach(() => invalidateBrowserWatchCache());

describe("a profile that stays unreadable", () => {
  it("says so once, not once per poll", async () => {
    const d = deck(noReader);
    let snap: any;
    for (let i = 0; i < 10; i++) snap = await d.poll();
    expect(d.reads(), "the mtime cache stopped answering, so this is not the case in the issue").toBe(1);
    const warns = snap.log.filter((l: any) => l.level === "warn" && l.text.startsWith(`${d.where} `));
    expect(warns, "the same warning, once per poll").toHaveLength(1);
  });

  it("leaves the reader's own lines in the feed after two hundred polls of a profile with no History file", async () => {
    noteWatchSetting("watch on (#1754)");
    const d = deck(noReader, () => null);
    let snap: any;
    for (let i = 0; i < 201; i++) snap = await d.poll();
    expect(snap.log.some((l: any) => l.level === "act" && l.text === "watch on (#1754)"),
      "the setting change was pushed out by copies of one warning").toBe(true);
    expect(snap.log.filter((l: any) => l.text.startsWith(`${d.where} `))).toHaveLength(1);
  });

  it("says so again when the reason changes, and again after it has been read in between", async () => {
    // The other half: one line per change of state, so the feed still shows
    // a profile going from one failure to another, or failing again after it
    // recovered.
    let mtime = 1;
    let answer: () => Promise<unknown> = noReader;
    const d = deck(() => answer(), () => mtime);
    await d.poll();
    answer = async () => ({ rows: [], watermark: "0", total: null, degraded: true, reason: "copy-failed: EACCES" });
    mtime += 1;
    await d.poll();
    answer = async () => ({ rows: [], watermark: "0", total: 0, degraded: false, reason: null });
    mtime += 1;
    await d.poll();
    answer = async () => ({ rows: [], watermark: "0", total: null, degraded: true, reason: "copy-failed: EACCES" });
    mtime += 1;
    const snap: any = await d.poll();
    const warns = snap.log.filter((l: any) => l.level === "warn" && l.text.startsWith(`${d.where} `));
    expect(warns.map((l: any) => l.text.slice(d.where.length + 3))).toEqual([
      "copy-failed: EACCES",
      "copy-failed: EACCES",
      "no-sqlite-reader: node:sqlite needs Node 22.5+ and no sqlite3 was found on PATH",
    ]);
  });
});
