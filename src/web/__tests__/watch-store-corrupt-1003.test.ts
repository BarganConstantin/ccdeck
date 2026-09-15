// A truncated state.json was read as an empty archive, and the next poll wrote
// that emptiness over it — on the one file whose whole premise is that the copy
// it duplicates can be erased by somebody else.
//
// #1003. `readStore` caught every failure the same way — one bare `catch`
// marked "absent or corrupt" — which is a defensible answer to a question about
// VALUES and a catastrophic one as the merge base of a write, because
// `updateStore` asked it that question on every single write. So a file that
// merely failed to parse was not just unread: the next writer replaced it, and
// the re-read inside the write queue that exists to PRESERVE what the caller
// does not own preserved nothing.
//
// WHAT WAS OBSERVED, end to end, against a real deck in a sandbox HOME with a
// sandbox Chromium profile — a state.json truncated to half its length, the way
// a machine that died between the write and the rename leaves one:
//
//   A. whole file          GET /api/browser-watch -> episodes:
//                          ["live.example.test x3", "archived.example.test x4"]
//                          on disk: 1224 bytes, 1 dismissal
//   truncate to 612 bytes  (does not parse)
//   B. readStore           {"settings":{…defaults…},"episodes":[],
//                           "dismissed":[],"migrated":false}  — silently
//   C. one poll later      on disk: episodes ["later.example.test x3",
//                          "live.example.test x3"], dismissed: 0
//
// `archived.example.test` is the whole point of the loss. It was in the deck's
// archive and NOT in the browser's history, which is exactly the row this
// feature exists to hold — and the poll that rebuilt the file from what Chrome
// still remembered wrote it out of existence. The dismissal went with it, the
// settings went back to their defaults in the same write, and nothing appeared
// on stderr, in the watch log or in the panel.
//
// Nobody has to press anything for that write: a watch that is ON and a program
// that opens a tab is all it takes, which is precisely the situation the archive
// is for. The settings and dismiss routes reach the same `updateStore` on any
// panel press.
//
// The rule these cases hold down: ENOENT — and only ENOENT — is a fresh start.
// Anything else is a file whose contents cannot be re-derived, so it is moved
// aside and named out loud before anything can write over it, and a write that
// cannot even do that refuses rather than land.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-watch-corrupt-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const store = await import("../../server/browser-watch-store.mjs");
// @ts-expect-error — ditto; the real sweep, run over a real directory below
const { sweepTempFiles, TEMP_STALE_MS } = await import("../../server/deck-home.mjs");

/** A deck home of its own per case, so one case's quarantine is never another's
 *  — and so the read's say-once bookkeeping, which is keyed on the path, cannot
 *  swallow a warning a later case is asserting on. */
let n = 0;
function homeWith(body: string | null): string {
  const home = join(DIR, `deck-${n++}`);
  mkdirSync(join(home, "agent-dag", "browser-watch"), { recursive: true });
  if (body !== null) writeFileSync(store.storePath(home), body, "utf8");
  return home;
}

/** A whole, healthy archive: one episode the deck wrote down, with the URLs that
 *  are the evidence, and one dismissal. Every field here is one a truncation
 *  loses, and none of them can be re-derived — the browser's own copy of this
 *  visit is what an intruder clears. */
const START = 1_700_000_000_000;
const WHOLE = JSON.stringify({
  v: 2,
  settings: { v: 1, enabled: true, reaction: "close-tab", quietMinutes: 42, gapMinutes: 7 },
  episodes: [{
    host: "archived.example.test",
    browser: "chrome",
    startMs: START,
    endMs: START + 120_000,
    count: 4,
    urls: [
      { url: "https://archived.example.test/settings", timeMs: START },
      { url: "https://archived.example.test/jobs?scope=all", timeMs: START + 60_000 },
    ],
    archivedMs: START,
  }],
  // Through `episodeKey`, never spelled here. It owns the separator, the store
  // drops any dismissal that does not carry it, and it is a NUL — which this
  // repo bans from source for the good reason that it is invisible in every
  // diff it appears in. JSON.stringify escapes it on the way to disk.
  dismissed: [store.episodeKey("dismissed.example.test", START)],
}, null, 2) + "\n";

/** The same file with its tail lost. Cut at `dismissed` so everything that makes
 *  the archive worth rescuing — the host, both addresses, the browser it
 *  happened in — is still legible in what is left, exactly as it was in the file
 *  the issue was reported against. */
const TRUNCATED = WHOLE.slice(0, WHOLE.lastIndexOf(`"dismissed"`));

const sidecars = (home: string) =>
  readdirSync(join(home, "agent-dag", "browser-watch")).filter(f => f.includes(".corrupt-"));
const said = () => {
  const lines: string[] = [];
  return { warn: (line: string) => lines.push(line), lines };
};

/** An fs failure shaped the way `node:fs/promises` raises one — `code` and all,
 *  which is the field the read now turns on. A fake that throws a bare Error is
 *  "I could not read this", not "there is nothing here", and a write refuses on
 *  it: every case that means "nothing saved yet" has to say ENOENT. */
const fsError = (code: string) =>
  Object.assign(new Error(`${code}: fake, watch-store-corrupt test`), { code });

describe("a state.json that cannot be parsed", () => {
  it("is kept, rather than replaced by the empty archive on the next write", async () => {
    const home = homeWith(TRUNCATED);
    const log = said();

    await store.updateStore((cur: unknown) => cur, home, { warn: log.warn });

    // The bytes the truncation left are still on disk, unchanged, under a name
    // nothing else writes. Byte-identical rather than merely present: a copy
    // that had been through JSON.parse could not exist, and one written back
    // through `archivable` would have dropped the half-row the cut left.
    const [kept] = sidecars(home);
    expect(kept, "nothing was kept").toBeTruthy();
    const rescued = readFileSync(join(home, "agent-dag", "browser-watch", kept), "utf8");
    expect(rescued).toBe(TRUNCATED);
    // And each of the things the old path destroyed is still recoverable from
    // it by hand, which is the whole reason for keeping it. Named one by one
    // rather than as a byte count, because the byte count is the part nobody
    // would notice going wrong.
    for (const lost of ["archived.example.test", "/jobs?scope=all", "close-tab"]) {
      expect(rescued, lost).toContain(lost);
    }
    // And none of it is in the file the deck went on to write, which is what
    // makes the sidecar the only copy there is.
    expect(readFileSync(store.storePath(home), "utf8")).not.toContain("archived.example.test");
  });

  it("says so on stderr, naming both the file and where it went", async () => {
    // Silence is half the defect: the old path destroyed the one record of what
    // a program did in the browser and printed nothing anywhere, so there was
    // no moment at which anybody could have chosen to rescue it.
    const home = homeWith(TRUNCATED);
    const log = said();

    await store.readStore(home, { warn: log.warn });

    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain(store.storePath(home));
    expect(log.lines[0]).toContain(sidecars(home)[0]);
  });

  it("moves it aside on the READ, before any write can merge over it", async () => {
    // The ordering is the fix. `updateStore` takes its base from this same read,
    // and so does the poll that writes the merged archive — so a read that
    // leaves the damaged file in place has already lost the race however
    // carefully the write behaves afterwards.
    const home = homeWith(TRUNCATED);

    const { store: values, source, quarantined } =
      await store.loadStore(home, { warn: () => {} });

    expect(source).toBe("corrupt");
    expect(quarantined).toBe(join(home, "agent-dag", "browser-watch", sidecars(home)[0]));
    expect(values.episodes).toEqual([]);
    // The name is state.json's plus `.corrupt-<ms>`: it sits beside the file it
    // came from so nobody has to be told where to look, and the stamp is
    // milliseconds rather than an ISO timestamp because a colon cannot be in a
    // filename on Windows — which is one of the platforms this has to work on.
    // The BASENAME is what that rule is about; a Windows path has a colon in it
    // three characters from the start whatever this function does.
    expect(store.quarantinePath(home, 1_700_000_000_000))
      .toBe(`${store.storePath(home)}.corrupt-1700000000000`);
    expect(basename(quarantined)).not.toContain(":");
  });

  it("does not end in .tmp, so the boot sweep cannot carry the rescue away", async () => {
    // The sweep deletes anything ending `.tmp` or `.migrating` that is over an
    // hour old, and this change puts the watch's directory in its list for the
    // first time. A quarantine named like a temp file would be deleted an hour
    // after the damage, by the deck, silently.
    const home = homeWith(TRUNCATED);

    await store.readStore(home, { warn: () => {} });

    const kept = sidecars(home)[0];
    expect(kept.endsWith(".tmp")).toBe(false);
    expect(kept.endsWith(".migrating")).toBe(false);
  });

  it("lets the watch start a fresh archive once those bytes are safe", async () => {
    // Quarantining is not refusing. The deck still has to record what it sees
    // from here on — what it must not do is destroy the old record on the way,
    // and the file it starts is an ordinary one.
    const home = homeWith(TRUNCATED);

    await store.updateStore(
      (cur: { episodes: unknown[] }) => ({
        ...cur,
        episodes: [{ host: "after.example.test", startMs: START, endMs: START + 1, count: 1, urls: [] }],
      }),
      home, { warn: () => {} },
    );

    const back = await store.readStore(home, { warn: () => {} });
    expect(back.episodes.map((e: { host: string }) => e.host)).toEqual(["after.example.test"]);
    expect(JSON.parse(readFileSync(store.storePath(home), "utf8")).v).toBe(2);
  });
});

describe("the three other things a read can find", () => {
  it("treats a file that is simply not there as a fresh archive, silently", async () => {
    // The half that must NOT change. A deck that has never watched anything has
    // no state.json and that is not an event: no warning, no sidecar, an empty
    // archive and the default settings.
    const home = homeWith(null);
    const log = said();

    const { store: values, source, quarantined } = await store.loadStore(home, { warn: log.warn });

    expect(source).toBe("missing");
    expect(quarantined).toBe("");
    expect(values.episodes).toEqual([]);
    expect(values.dismissed).toEqual([]);
    expect(values.settings).toEqual(store.normalise(null));
    expect(log.lines).toEqual([]);
    expect(sidecars(home)).toEqual([]);
  });

  it("reads a file Notepad saved, rather than quarantining it for a BOM", async () => {
    // `Set-Content` and Notepad write UTF-8 with a byte-order mark and
    // JSON.parse throws on it, so a perfectly good hand-edited file looks
    // exactly like a truncated one from here. installer.mjs has stripped it off
    // settings.json since it was written; without the same call, the fix for
    // #1003 would quarantine a file with nothing wrong with it — and this one
    // IS hand-edited: `normalise`'s own doc says a hand edit is one of the three
    // places a file on disk arrives from, which is why it checks every field.
    const home = homeWith("\uFEFF" + WHOLE);
    const log = said();

    const { store: values, source } = await store.loadStore(home, { warn: log.warn });

    expect(source).toBe("file");
    expect(values.episodes.map((e: { host: string }) => e.host)).toEqual(["archived.example.test"]);
    expect(values.settings.reaction).toBe("close-tab");
    expect(sidecars(home)).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it("refuses to write at all over a file it could not read for some other reason", async () => {
    // EACCES, EISDIR, a hardware error: the file is still there, still holding
    // the archive, and still unread. Renaming it aside would be moving bytes
    // nobody has looked at, and writing onto an empty archive would destroy
    // them — so the write throws and the file is left exactly as it was found.
    // Same policy installer.mjs's readSettingsForWrite applies to settings.json.
    const home = homeWith(WHOLE);
    const log = said();

    await expect(store.updateStore((cur: unknown) => cur, home, {
      warn: log.warn,
      readFile: async () => { throw fsError("EACCES"); },
    })).rejects.toMatchObject({ code: "WATCH_STORE_UNREADABLE" });

    expect(readFileSync(store.storePath(home), "utf8")).toBe(WHOLE);
    expect(sidecars(home)).toEqual([]);
    expect(log.lines.join("\n")).toContain("EACCES");
  });

  it("refuses when the damaged file could not be moved aside either", async () => {
    // The quarantine is what makes starting fresh safe, so a quarantine that
    // failed is not a detail: the bytes are still in state.json and a write
    // would still be the thing that destroys them.
    const home = homeWith(TRUNCATED);

    await expect(store.updateStore((cur: unknown) => cur, home, {
      warn: () => {},
      rename: async () => { throw fsError("EPERM"); },
    })).rejects.toMatchObject({ code: "WATCH_STORE_UNREADABLE" });

    expect(readFileSync(store.storePath(home), "utf8")).toBe(TRUNCATED);
    expect(sidecars(home)).toEqual([]);
  });

  it("says the thing it cannot fix once, not once every ten seconds", async () => {
    // This file is read by the panel's poll and by the badge's background one,
    // for as long as the deck is up. The two failures that cannot clear
    // themselves would otherwise put the same line on stderr six times a minute
    // forever, which is how a warning becomes something people filter out.
    const home = homeWith(WHOLE);
    const log = said();
    const deps = { warn: log.warn, readFile: async () => { throw fsError("EACCES"); } };

    for (let i = 0; i < 4; i++) await store.readStore(home, deps);

    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain(store.storePath(home));
  });
});

describe("the temp file the archive is staged through", () => {
  it("is flushed before the rename, not merely written", async () => {
    // A rename orders the DIRECTORY ENTRY and not the bytes, so a machine that
    // loses power just after one comes up with the new name pointing at blocks
    // that were never written — a zero-length state.json, which is the very
    // damage the read above now has to survive. installer.mjs's writeFileAtomic
    // has fsync'd for this reason since it was written.
    //
    // Read off the source because the property cannot be observed from outside:
    // an fsync that never happened looks exactly like one that did until the
    // power goes, and the seam the suite injects (`deps.writeFile`) is the very
    // thing that would be standing in for it.
    const src = readFileSync(
      fileURLToPath(new URL("../../server/browser-watch-store.mjs", import.meta.url)), "utf8");
    expect(src).toMatch(/await fh\.writeFile\(body, encoding\);\s*\n\s*await fh\.sync\(\);/);
    expect(src).toContain("deps.writeFile ?? writeAndSync");
    expect(src, "the un-synced write must not come back")
      .not.toMatch(/const write = deps\.writeFile \?\? writeFile;/);
  });

  it("is not left behind holding the whole archive when the write does not land", async () => {
    // These are the biggest files the deck makes — about 2.5 MB each with a
    // full 500-episode archive — and nothing ever unlinked one. A rename the
    // Windows ladder could not outlast, a full disk, a permission: every one of
    // them left a complete second copy of the archive lying beside it.
    const home = homeWith(null);

    await expect(store.updateStore(
      (cur: { episodes: unknown[] }) => ({
        ...cur,
        episodes: [{ host: "x.test", startMs: START, endMs: START + 1, count: 1, urls: [] }],
      }),
      home, { warn: () => {}, rename: async () => { throw fsError("ENOSPC"); } },
    )).rejects.toBeTruthy();

    expect(readdirSync(join(home, "agent-dag", "browser-watch")).filter(f => f.endsWith(".tmp")))
      .toEqual([]);
  });

  it("is reachable by the boot sweep, which does not recurse", async () => {
    // The other half of the litter, and the half no `finally` can reach: a deck
    // KILLED between the write and the rename. deck-home.mjs:215 records
    // ninety-seven such files found in one directory, the oldest six days old,
    // as the reason the sweep was written — and `browser-watch/` is a
    // SUBDIRECTORY of the one it was handed, so every one of these was outside
    // it. Both halves asserted together, because handing the sweep the right
    // directory is the fix and the non-recursion is why it was needed.
    const home = homeWith(null);
    const dir = join(home, "agent-dag", "browser-watch");
    const stale = `${store.storePath(home)}.999.1.tmp`;
    writeFileSync(stale, "{}", "utf8");
    const now = Date.now() + TEMP_STALE_MS + 1;
    const fs = await import("node:fs/promises");

    expect(await sweepTempFiles({ dirs: [join(home, "agent-dag")], fs, now }),
      "the parent directory reached it, so the sweep was never the problem").toBe(0);
    expect(await sweepTempFiles({ dirs: [store.storeDir(home)], fs, now })).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is what bin/deck.js hands the sweep at boot", () => {
    // The call site, because the block runs once at module top level before the
    // server exists and there is nothing to drive it with. `storeDir` by name
    // rather than a second spelling of the path: two spellings of one directory
    // are two things that can drift, which is the argument this repo makes at
    // every other place a path is shared.
    const deck = readFileSync(
      fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
    expect(deck).toContain("dirs: [legacy, data, log, watchStoreDir()]");
    expect(deck).toMatch(/const \{ storeDir: watchStoreDir \} = await import\(/);
  });
});
