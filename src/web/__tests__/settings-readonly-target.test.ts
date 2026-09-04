// A read-only settings.json is a dead end on Windows, and only there.
//
// libuv's rename is one MoveFileExW(MOVEFILE_REPLACE_EXISTING), which refuses
// to replace a destination carrying FILE_ATTRIBUTE_READONLY. POSIX rename(2)
// over a 0444 file succeeds — only the parent directory's write bit decides —
// so this is a platform split, not a permissions bug.
//
// A settings.json picks that attribute up from a OneDrive restore, a copy off a
// network share, or read-only media. EACCES is in renameWithRetry's ladder, so
// the whole ~1.4 seconds was spent before throwing, on every boot, forever.
// Every settings writer goes through writeFileAtomic, so hooks never installed
// and the sound-hook retirement could never repair a stale entry either.
import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-ro-target-"));
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — .mjs server module, no types
const { writeFileAtomic } = await import("../../server/installer.mjs");
const src = readFileSync(fileURLToPath(new URL("../../server/installer.mjs", import.meta.url)), "utf8");

describe("writing over a file the filesystem calls read-only", () => {
  it("replaces it, and leaves it read-only afterwards", async () => {
    // Runs everywhere. On Windows chmod toggles the read-only ATTRIBUTE and
    // this is the case that used to fail; on POSIX it is a 0444 file, where
    // rename always worked and the mode still has to survive.
    const target = join(DIR, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }));
    chmodSync(target, 0o444);

    await writeFileAtomic(target, JSON.stringify({ hooks: { Stop: [] } }, null, 2));

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ hooks: { Stop: [] } });
    // The mode is carried over a rename on every platform — a settings.json the
    // user chmod'ed has to stay that way — and on Windows that is the very
    // attribute this fix clears to get the rename through.
    expect(statSync(target).mode & 0o222, "the write left the file writable").toBe(0);
  });

  it("keeps an ordinary file's mode too", async () => {
    const target = join(DIR, "normal.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o600);
    await writeFileAtomic(target, '{"a":1}');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
    // Windows has one bit here, not nine: chmod toggles FILE_ATTRIBUTE_READONLY
    // and Node reports 0666 or 0444 whatever was asked for. So the assertion is
    // "still writable" there and the exact mode everywhere else — the same
    // split the code's own comment makes.
    if (process.platform === "win32") expect(statSync(target).mode & 0o222).not.toBe(0);
    else expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("clears the attribute only on Windows, and puts it back after the rename", () => {
    // Unconditional on POSIX would be a mode change the user never asked for,
    // between two writes that are supposed to be one atomic replacement.
    const start = src.indexOf("const mode = await stat(target)");
    const win = src.slice(start, src.indexOf("} catch (err) {", start));
    expect(win).toContain('if (process.platform === "win32" && mode !== null) {');
    expect(win).toContain("await chmod(target, 0o666).catch(() => {});");
    expect(win).toContain("await chmod(target, mode).catch(() => {});");
    // And the restore is after the rename, not before it.
    expect(win.indexOf("renameWithRetry(tmp, target)")).toBeLessThan(win.lastIndexOf("chmod(target, mode)"));
  });
});
