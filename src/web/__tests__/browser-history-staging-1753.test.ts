// Every Browser Watch read copies the whole History database into a folder of
// its own under the staging root, and deletes it afterwards. Two ways out left
// the copy there for good (#1753): a delete that failed — Windows holding the
// new file a little longer than `discard` retries — and a deck that exited in
// the middle of a read. Nothing ever looked at the staging root again: each
// read makes a fresh `mkdtemp` folder, and the boot sweep neither recurses nor
// matches these names. So full, unencrypted copies of somebody's browsing
// history, 21 MB each here, built up in their config tree.
//
// The History file here is a few bytes in a temp directory, and the SQLite
// reader is a stand-in: no browser profile is opened.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import * as history from "../../server/browser-history.mjs";

const { readVisitsSince, stagingRoot } = history;

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmTempDir(dir); });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-1753-"));
  made.push(dir);
  const profile = join(dir, "profile");
  mkdirSync(profile);
  const historyPath = join(profile, "History");
  writeFileSync(historyPath, "not a real database — the reader below never opens it");
  return { dir, historyPath, copies: join(dir, "staging") };
}

/** A node:sqlite with no rows, so a read gets as far as its cleanup and no
 *  further. */
const noRows = async () => ({
  DatabaseSync: class {
    prepare() { return { all: () => [], get: () => ({ n: "0" }) }; }
    close() {}
  },
});

describe("a copy of the History database left in the staging folder", () => {
  it("is removed by the next read after a delete that failed", async () => {
    const s = sandbox();
    const held = async () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); };
    const first = await readVisitsSince(s.historyPath, "0", {
      copyDir: s.copies, backend: { kind: "node-sqlite" }, deps: { importSqlite: noRows, rm: held },
    });
    expect(first.degraded).toBe(false);
    expect(readdirSync(s.copies), "the failed delete left nothing, so this proves nothing").toHaveLength(1);

    for (let i = 0; i < 10; i++) {
      await readVisitsSince(s.historyPath, "0", {
        copyDir: s.copies, backend: { kind: "node-sqlite" }, deps: { importSqlite: noRows },
      });
    }
    expect(readdirSync(s.copies), "a copy nothing will ever delete").toEqual([]);
  });

  it("is removed at boot when a deck that is gone left it a week ago, and a read in flight is not", async () => {
    const s = sandbox();
    const home = join(s.dir, "claude");
    const root = stagingRoot(home);
    const old = join(root, "history-AbC123");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "history-4242-7-deadbeef.sqlite"), "a week-old copy");
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    utimesSync(join(old, "history-4242-7-deadbeef.sqlite"), weekAgo, weekAgo);
    utimesSync(old, weekAgo, weekAgo);
    // A sibling deck sharing the root, mid-read: its folder is seconds old.
    const busy = join(root, "history-Zz9Yy8");
    mkdirSync(busy);
    writeFileSync(join(busy, "history-5151-1-cafef00d.sqlite"), "being read right now");

    const { sweepStaging } = history as unknown as { sweepStaging?: (dir: string) => Promise<number> };
    expect(typeof sweepStaging, "nothing sweeps the staging folder").toBe("function");
    await sweepStaging!(root);
    expect(existsSync(old), "the week-old copy survived the boot sweep").toBe(false);
    expect(existsSync(busy), "a read still in progress lost its copy").toBe(true);
  });

  it("is swept by the boot that bin/deck.js runs, on the staging root itself", () => {
    // The sweep above is only a fix if boot calls it on the folder reads use.
    // Read from the source because the boot block is the top level of a script
    // and cannot be called.
    const deck = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
    expect(deck).toMatch(/await sweepStaging\(stagingRoot\(\)\)/);
  });
});
