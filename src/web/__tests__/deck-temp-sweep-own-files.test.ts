// The boot's temp-file sweep deleted files the deck never made.
//
// CCDECK_HOME is "a portable install … or anybody who simply wants it
// elsewhere", and the deck uses that folder as it is, with no subfolder of its
// own. The boot hands it to sweepTempFiles, which unlinked every top-level file
// ending in `.tmp` or `.migrating` older than an hour, whoever wrote it — a
// user's own `report.tmp` on a USB stick's root, an editor's or a downloader's
// staging file — silently. Reproduced before the fix:
//
//     <CCDECK_HOME>/report.tmp, two hours old  -> deleted at the next boot
//
// Now the sweep matches only the names the deck's own writers use.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { sweepTempFiles, TEMP_STALE_MS } = await import("../../server/deck-home.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-temp-sweep-"));
afterAll(() => rmTempDir(DIR));

/** A file in DIR, last written two sweep-ages ago. */
function old(name: string) {
  const path = join(DIR, name);
  writeFileSync(path, "x");
  const at = new Date(Date.now() - 2 * TEMP_STALE_MS);
  utimesSync(path, at, at);
  return path;
}

describe("the boot's temp-file sweep, in a folder the deck shares", () => {
  it("removes the deck's own leftovers and nothing anybody else made", async () => {
    const ours = [
      old("prefs.json.agent-dag-4242-0.tmp"),
      old("settings.json.agent-dag-17-3.tmp"),
      old("state.json.4242.7.tmp"),
      old("prefs.json.4242.migrating"),
      old("events.jsonl.4242.migrating"),
      old("events.jsonl.1.4242.migrating"),
    ];
    const theirs = [
      old("report.tmp"),
      old("download.part.tmp"),
      old("notes.migrating"),
      old("photo.jpg.1.tmp"),
    ];
    const removed = await sweepTempFiles({ dirs: [DIR], fs: fsp });
    for (const p of theirs) expect(existsSync(p), `${p} was deleted`).toBe(true);
    for (const p of ours) expect(existsSync(p), `${p} was left`).toBe(false);
    expect(removed).toBe(ours.length);
  });
});
