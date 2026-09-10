// The deck's own files leave another application's configuration directory,
// and the whole risk of that is one file: prefs.json holds this deck's private
// key, every paired machine has pinned it, and losing it is not a setting that
// comes back — it is fifty colleagues pressing accept again.
//
// So this file is mostly about what the move REFUSES to do. It never deletes,
// it never overwrites, it never half-writes, and it never stops the deck from
// starting when it cannot do its job at all.
//
// No DOM, no real filesystem: the paths are pure functions of platform,
// environment and home, and the mover takes its fs as a parameter — which is
// what lets the Windows answers be checked from a Mac, the way
// claude-cli-candidates.test.ts checks its own.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MOVED, TEMP_STALE_MS, deckDataDir, deckLogDir, legacyDeckDir,
  migrateDeckFiles, sweepTempFiles,
} from "../../server/deck-home.mjs";

const HOME = "/home/u";

/** An in-memory filesystem with the four calls the mover makes, plus the two
 *  the sweep makes. Faults are injected by path so the failure paths are real
 *  rather than described. */
function fakeFs(files: Record<string, { body?: string; mode?: number; mtimeMs?: number }> = {}) {
  const store = new Map(Object.entries(files).map(([k, v]) => [k, { body: "", mode: 0o644, mtimeMs: 0, ...v }]));
  const dirs = new Set<string>();
  const fail = new Set<string>();
  return {
    store, dirs, fail,
    async stat(p: string) {
      const f = store.get(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return { mtimeMs: f.mtimeMs };
    },
    async mkdir(p: string) { dirs.add(p); },
    async copyFile(src: string, dst: string) {
      if (fail.has(src) || fail.has(dst)) throw new Error(`EACCES ${dst}`);
      const f = store.get(src);
      if (!f) throw new Error(`ENOENT ${src}`);
      store.set(dst, { ...f });
    },
    async chmod(p: string, mode: number) {
      const f = store.get(p);
      if (f) f.mode = mode;
    },
    async rename(src: string, dst: string) {
      if (fail.has(dst)) throw new Error(`EXDEV ${dst}`);
      const f = store.get(src);
      if (!f) throw new Error(`ENOENT ${src}`);
      store.delete(src);
      store.set(dst, f);
    },
    async readdir(p: string) {
      if (!store.size && !dirs.has(p)) throw new Error(`ENOENT ${p}`);
      const prefix = `${p}/`;
      const out = [...store.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
      if (!out.length && !dirs.has(p)) throw new Error(`ENOENT ${p}`);
      return out;
    },
    async unlink(p: string) {
      if (fail.has(p)) throw new Error(`EPERM ${p}`);
      store.delete(p);
    },
  };
}

describe("where this platform keeps application data", () => {
  it("uses each platform's own answer rather than XDG everywhere", () => {
    // env-paths' rule, and the one a tool gets wrong by reading half the page:
    // XDG is a Linux specification. A deck that puts ~/.config on a Mac is a
    // deck that ignored the platform it is running on.
    expect(deckDataDir("darwin", {}, HOME)).toBe(`${HOME}/Library/Application Support/ccdeck`);
    expect(deckDataDir("linux", {}, HOME)).toBe(`${HOME}/.local/share/ccdeck`);
    expect(deckDataDir("win32", {}, HOME)).toBe(`${HOME}/AppData/Local/ccdeck/Data`);
  });

  it("puts a log where logs go, which is not where preferences go", () => {
    // On Linux that is the STATE directory: XDG separates what a user would
    // miss from what the program can rebuild, and an event log that rotates at
    // 50 MB is the second one.
    expect(deckLogDir("darwin", {}, HOME)).toBe(`${HOME}/Library/Logs/ccdeck`);
    expect(deckLogDir("linux", {}, HOME)).toBe(`${HOME}/.local/state/ccdeck`);
    expect(deckLogDir("win32", {}, HOME)).toBe(`${HOME}/AppData/Local/ccdeck/Log`);
    // And they are never the same directory, or the log would be sitting in the
    // data directory again under a different name.
    for (const p of ["darwin", "linux", "win32"]) {
      expect(deckDataDir(p, {}, HOME), p).not.toBe(deckLogDir(p, {}, HOME));
    }
  });

  it("reads the variables each platform actually sets", () => {
    expect(deckDataDir("linux", { XDG_DATA_HOME: "/xdg/data" }, HOME)).toBe("/xdg/data/ccdeck");
    expect(deckLogDir("linux", { XDG_STATE_HOME: "/xdg/state" }, HOME)).toBe("/xdg/state/ccdeck");
    expect(deckDataDir("win32", { LOCALAPPDATA: "D:\\App" }, HOME)).toBe("D:\\App/ccdeck/Data");
    // The Windows fallback is not decoration: a service account or a stripped
    // environment reaches this with the variable unset, and a deck that throws
    // there is a deck that will not start.
    expect(deckDataDir("win32", { LOCALAPPDATA: "  " }, HOME)).toBe(`${HOME}/AppData/Local/ccdeck/Data`);
  });

  it("leaves a Claude profile exactly where it was", () => {
    // THE ONE GROUP THIS MUST NOT MOVE. Somebody who set CLAUDE_CONFIG_DIR asked
    // for a second Claude profile and has had a second deck along with it —
    // separate key, separate pairings, separate share list. Moving them to one
    // machine-wide deck would collapse two profiles into one on upgrade, which
    // is the silent change this whole file exists to avoid.
    const env = { CLAUDE_CONFIG_DIR: "/work/claude" };
    expect(deckDataDir("darwin", env, HOME)).toBe("/work/claude/agent-dag");
    expect(deckLogDir("darwin", env, HOME)).toBe("/work/claude/agent-dag");
    expect(legacyDeckDir(env, HOME)).toBe("/work/claude/agent-dag");
    // Which also means the migration below has nothing to do for them: source
    // and destination are one path.
    expect(deckDataDir("darwin", env, HOME)).toBe(legacyDeckDir(env, HOME));
  });

  it("takes one variable over every rule, for a portable install", () => {
    const env = { CCDECK_HOME: "/portable/deck", CLAUDE_CONFIG_DIR: "/work/claude", XDG_DATA_HOME: "/xdg" };
    expect(deckDataDir("linux", env, HOME)).toBe("/portable/deck");
    expect(deckLogDir("linux", env, HOME)).toBe("/portable/deck");
  });

  it("moves the deck's own state and nothing Claude Code reads", () => {
    // `hook.js` stays because Claude Code reads it out of ~/.claude/agent-dag,
    // and the per-pid port files stay because a deck of the PREVIOUS version
    // lists that directory to find this one — move them and two versions
    // running side by side stop seeing each other.
    expect(MOVED.map(f => f.name)).toEqual(["prefs.json", "events.jsonl", "events.jsonl.1"]);
    expect(MOVED.map(f => f.name)).not.toContain("hook.js");
    // And the one file with a private key in it keeps the mode that is the only
    // thing between it and every other account on a shared machine.
    expect(MOVED.find(f => f.name === "prefs.json")?.mode).toBe(0o600);
  });
});

describe("a move nobody can be hurt by", () => {
  const from = "/old/agent-dag";
  const data = "/new/data";
  const log = "/new/log";

  it("copies the key across and leaves the original where it was", async () => {
    // LEFT, not moved: somebody who downgrades to the version before this finds
    // exactly what they had. It costs four kilobytes and buys a change that
    // cannot lose anybody their pairings.
    const fs = fakeFs({ [`${from}/prefs.json`]: { body: '{"lan":{"secret":"k"}}' } });
    const out = await migrateDeckFiles({ from, data, log, fs, rename: fs.rename });
    expect(out.moved).toEqual(["prefs.json"]);
    expect(fs.store.get(`${data}/prefs.json`)?.body).toBe('{"lan":{"secret":"k"}}');
    expect(fs.store.has(`${from}/prefs.json`)).toBe(true);
    expect(fs.store.get(`${data}/prefs.json`)?.mode).toBe(0o600);
  });

  it("never overwrites something already there", async () => {
    // What makes this safe to run at every boot, and what stops a stale copy in
    // the old directory from landing on live state a week later.
    const fs = fakeFs({
      [`${from}/prefs.json`]: { body: "OLD" },
      [`${data}/prefs.json`]: { body: "LIVE" },
    });
    const out = await migrateDeckFiles({ from, data, log, fs, rename: fs.rename });
    expect(out.moved).toEqual([]);
    expect(fs.store.get(`${data}/prefs.json`)?.body).toBe("LIVE");
  });

  it("does nothing at all on the second start, and on a fresh install", async () => {
    const fs = fakeFs({ [`${from}/prefs.json`]: { body: "x" } });
    expect((await migrateDeckFiles({ from, data, log, fs, rename: fs.rename })).moved).toEqual(["prefs.json"]);
    expect((await migrateDeckFiles({ from, data, log, fs, rename: fs.rename })).moved).toEqual([]);
    // Nothing to move is not a failure; it is what every new machine looks like.
    const clean = fakeFs({});
    expect(await migrateDeckFiles({ from, data, log, fs: clean, rename: clean.rename })).toEqual({ moved: [], failed: [] });
  });

  it("sends the log to the log directory and the preferences to the data one", async () => {
    const fs = fakeFs({
      [`${from}/prefs.json`]: { body: "p" },
      [`${from}/events.jsonl`]: { body: "e" },
      [`${from}/events.jsonl.1`]: { body: "e1" },
    });
    await migrateDeckFiles({ from, data, log, fs, rename: fs.rename });
    expect(fs.store.has(`${data}/prefs.json`)).toBe(true);
    expect(fs.store.has(`${log}/events.jsonl`)).toBe(true);
    expect(fs.store.has(`${log}/events.jsonl.1`)).toBe(true);
    expect(fs.store.has(`${log}/prefs.json`)).toBe(false);
  });

  it("lands on a temp name and renames, so a killed copy is never a half key", async () => {
    // A copy interrupted half way is a truncated prefs.json, and a truncated
    // prefs.json is a deck with no key — which is the whole thing this is
    // trying not to do.
    const fs = fakeFs({ [`${from}/prefs.json`]: { body: "k" } });
    const seen: string[] = [];
    const wrapped = { ...fs, copyFile: async (s: string, d: string) => { seen.push(d); return fs.copyFile(s, d); } };
    await migrateDeckFiles({ from, data, log, fs: wrapped, rename: fs.rename });
    expect(seen[0]).not.toBe(`${data}/prefs.json`);
    expect(seen[0].startsWith(`${data}/prefs.json.`)).toBe(true);
    // And nothing is left under the temp name once it has been renamed.
    expect([...fs.store.keys()].some(k => k.includes(".migrating"))).toBe(false);
  });

  it("renames with the Windows ladder rather than with a bare rename", async () => {
    // #786: MoveFileExW refuses while any other process holds the destination
    // open — a scanner, the indexer, a backup agent. Losing THIS rename to one
    // of those is a deck with no identity.
    const src = readFileSync(
      fileURLToPath(new URL("../../server/deck-home.mjs", import.meta.url)), "utf8",
    );
    expect(src).toMatch(/rename = renameWithRetry/);
    expect(src).not.toMatch(/await fs\.rename\(/);
  });

  it("reports a failure and keeps going, because a start is not optional", async () => {
    // A read-only home, a full disk, a permission the installer never had —
    // none of those is a reason for the deck not to come up. The old paths are
    // still there and the worst case is a deck that keeps using them.
    const fs = fakeFs({
      [`${from}/prefs.json`]: { body: "p" },
      [`${from}/events.jsonl`]: { body: "e" },
    });
    fs.fail.add(`${from}/prefs.json`);
    const errors: string[] = [];
    const out = await migrateDeckFiles({ from, data, log, fs, rename: fs.rename, onError: n => errors.push(n) });
    expect(out.failed).toEqual(["prefs.json"]);
    expect(out.moved).toEqual(["events.jsonl"]);
    expect(errors).toEqual(["prefs.json"]);
  });

  it("is a no-op when the old directory IS the new one", async () => {
    // The CLAUDE_CONFIG_DIR case, where nothing moves and copying a file onto
    // itself would be the only way to break it.
    const fs = fakeFs({ [`${from}/prefs.json`]: { body: "p" } });
    const out = await migrateDeckFiles({ from, data: from, log: from, fs, rename: fs.rename });
    expect(out).toEqual({ moved: [], failed: [] });
    expect(fs.store.get(`${from}/prefs.json`)?.body).toBe("p");
  });
});

describe("the litter an atomic write leaves behind", () => {
  const dir = "/old/agent-dag";
  const NOW = 1_700_000_000_000;

  it("removes a temp file nothing can still be writing", async () => {
    // Ninety-seven were found in one directory, the oldest six days old. Nothing
    // has ever swept them, because the code that makes them is not running any
    // more when they are made — so the sweep belongs at START, where a process
    // that is alive can clean up after the ones that are not.
    const fs = fakeFs({
      [`${dir}/prefs.json.111.tmp`]: { mtimeMs: NOW - TEMP_STALE_MS - 1 },
      [`${dir}/4317.json.agent-dag-4317-0.tmp`]: { mtimeMs: NOW - 6 * 24 * 3600_000 },
      [`${dir}/prefs.json`]: { mtimeMs: NOW },
    });
    expect(await sweepTempFiles({ dirs: [dir], fs, now: NOW })).toBe(2);
    expect(fs.store.has(`${dir}/prefs.json`)).toBe(true);
  });

  it("leaves alone a temp file another deck may be writing right now", async () => {
    // It goes by AGE, which is a fact about the file, rather than by pid, which
    // would be a guess about a process. Deleting a live one turns an atomic
    // write into a lost one.
    const fs = fakeFs({ [`${dir}/prefs.json.222.tmp`]: { mtimeMs: NOW - 5_000 } });
    expect(await sweepTempFiles({ dirs: [dir], fs, now: NOW })).toBe(0);
    expect(fs.store.has(`${dir}/prefs.json.222.tmp`)).toBe(true);
  });

  it("shrugs at a directory that is not there and a file it may not delete", async () => {
    const fs = fakeFs({ [`${dir}/x.tmp`]: { mtimeMs: 0 } });
    fs.fail.add(`${dir}/x.tmp`);
    const errors: string[] = [];
    expect(await sweepTempFiles({ dirs: [dir, "/nowhere"], fs, now: NOW, onError: p => errors.push(p) })).toBe(0);
    expect(errors).toEqual([`${dir}/x.tmp`]);
  });
});
