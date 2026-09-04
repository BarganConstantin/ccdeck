// Three writers, one file, and nothing between them.
//
// The poll's snapshot, the settings route and the dismiss route all wrote this
// store, each with a whole state it had read earlier, through a temp file named
// after the PID — which distinguishes decks and not the calls inside one. Two
// defects came out of that:
//
//   * the shared temp name. Measured with a full 500-episode archive (~2.5 MB,
//     past the 512 KiB writeFile chunk): eight concurrent runs left state.json
//     unparseable in six of them and failed one call with ENOENT. `readStore`
//     swallows a corrupt file, so the next poll reported an empty archive and
//     no dismissals — total loss of the one file this feature exists to keep.
//   * the stale whole-state write. A snapshot takes ~400ms (a 21 MB History
//     copy plus the sqlite read) and wrote back the `dismissed` it had read at
//     the start, so a dismissal made while it ran came back ten seconds later.
//
// Real files in a real temp directory: this is a test about what two writes do
// to one path, and a mocked fs has no such thing.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — .mjs server module, no types
const store = await import("../../server/browser-watch-store.mjs");
const { readStore, writeStore, updateStore, storePath } = store;

const HOME = mkdtempSync(join(tmpdir(), "ccdeck-watch-store-"));
afterAll(() => rmTempDir(HOME));

const episodes = (n: number, host = "example.test") =>
  Array.from({ length: n }, (_, i) => ({
    host, browser: "brave", count: 3, startMs: 1_700_000_000_000 + i * 1000,
    endMs: 1_700_000_000_500 + i * 1000, urls: [],
  }));

const settings = { v: 1, enabled: true, reaction: "notify", quietMinutes: 15, gapMinutes: 15 };

/** The key shape `episodeKey` produces, and the only shape readStore keeps: a
 *  host and a start, separated by NUL. A dismissal spelled any other way is
 *  dropped on read, which is what a naive fixture here discovers. */
const KEPT = `kept.test\u0000${1_700_000_000_000}`;
const DISMISSAL = `example.test\u0000${1_700_000_000_000}`;

describe("two writes landing at once", () => {
  it("leaves a file that still parses", async () => {
    // Eight whole-state writes of a large archive, started together. Before the
    // fix this left an unparseable state.json most of the time.
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      writeStore({ settings, episodes: episodes(200, `h${i}.test`), dismissed: [`h${i}.test\u0000${1_700_000_000_000}`] }, HOME)));

    const raw = readFileSync(storePath(HOME), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const back = await readStore(HOME);
    expect(back.episodes.length).toBe(200);
    expect(back.dismissed.length).toBe(1);
  }, 30_000);

  it("leaves no temp file behind, and never shared one", async () => {
    // The rename is what removes it; a leftover .tmp means a write lost its
    // file to another writer's rename.
    const leftovers = readdirSync(join(HOME, "agent-dag", "browser-watch")).filter(f => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    // And the name carries a per-call counter, not only the pid.
    const src = readFileSync(new URL("../../server/browser-watch-store.mjs", import.meta.url), "utf8");
    expect(src).toContain("${storePath(home)}.${process.pid}.${++_writeSeq}.tmp");
  });
});

describe("a caller that owns one field", () => {
  it("keeps the fields it did not set, as they are on disk at the time of the write", async () => {
    await writeStore({ settings, episodes: episodes(3), dismissed: [KEPT] }, HOME);

    // The snapshot's shape: it owns the archive and nothing else.
    await updateStore(cur => ({ ...cur, episodes: episodes(5) }), HOME);

    const back = await readStore(HOME);
    expect(back.episodes).toHaveLength(5);
    expect(back.dismissed).toEqual([KEPT]);
    expect(back.settings.reaction).toBe("notify");
  });

  it("does not revert a dismissal made while a slow write was in flight", async () => {
    // The measured defect, as a sequence: a slow snapshot starts, a dismissal
    // lands, and the snapshot must not write back the archive-era `dismissed`.
    await writeStore({ settings, episodes: episodes(2), dismissed: [] }, HOME);

    let releaseSlow: () => void;
    const slowStarted = new Promise<void>(r => { releaseSlow = r; });
    const slow = updateStore(async cur => {
      releaseSlow!();
      await new Promise(r => setTimeout(r, 120));   // the History copy and sqlite read
      return { ...cur, episodes: episodes(9) };
    }, HOME);

    await slowStarted;
    const dismissal = updateStore(cur => ({ ...cur, dismissed: [...cur.dismissed, DISMISSAL] }), HOME);

    await Promise.all([slow, dismissal]);
    const back = await readStore(HOME);
    expect(back.episodes).toHaveLength(9);
    expect(back.dismissed, "the dismissal was reverted by the slower writer").toContain(DISMISSAL);
  }, 30_000);

  it("survives a mutation that throws without wedging the queue", async () => {
    // The queue is one promise chain; a rejection that took it down would stop
    // every later write on this deck for the life of the process.
    await expect(updateStore(() => { throw new Error("boom"); }, HOME)).rejects.toThrow("boom");
    await writeStore({ settings, episodes: episodes(1), dismissed: [] }, HOME);
    expect((await readStore(HOME)).episodes).toHaveLength(1);
  });
});

describe("what a corrupt file still does", () => {
  it("reads as empty rather than throwing, which is why the writes above matter", async () => {
    writeFileSync(storePath(HOME), "{not json");
    const back = await readStore(HOME);
    expect(back.episodes).toEqual([]);
    // And a write puts it back in order.
    await writeStore({ settings, episodes: episodes(2), dismissed: [] }, HOME);
    expect((await readStore(HOME)).episodes).toHaveLength(2);
  });
});
