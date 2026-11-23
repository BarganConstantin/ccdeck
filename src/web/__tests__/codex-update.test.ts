// Did Codex just update itself (codex-update.mjs)? The deck's answer to the
// terminal pane, when a Codex it watched exits with status 0: Codex's own
// "Update now" exits 0 as /exit does, and what tells them apart is the codex
// on disk, replaced while the pane was live. The decision is pure and runs on
// fake times here; the lookup runs on fake files; and once on a real link in
// a scratch folder, whose target the system has just written. Nothing here
// looks at this machine's own codex.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { CODEX_UPDATE_WINDOW_MS, LIVE_FOR_MAX_MS, codexBin, codexReplaced, liveForOf, replacedWhileLive } from "../../server/codex-update.mjs";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-update-"));
afterAll(() => rmTempDir(DIR));

const NOW = 1_800_000_000_000;

describe("replacedWhileLive", () => {
  it("says yes for a codex replaced after the pane went live, within the window", () => {
    expect(replacedWhileLive(NOW - 5_000, 60_000, NOW)).toBe(true);
    expect(replacedWhileLive(NOW, 60_000, NOW)).toBe(true);
    expect(replacedWhileLive(NOW - 60_000, 60_000, NOW), "the moment the pane went live counts").toBe(true);
  });

  it("says no for a codex replaced before the pane went live: updated elsewhere, then opened here", () => {
    expect(replacedWhileLive(NOW - 60_001, 60_000, NOW)).toBe(false);
    expect(replacedWhileLive(NOW - 10_000, 9_000, NOW)).toBe(false);
    expect(replacedWhileLive(NOW - 1, 0, NOW), "a pane live for no time saw nothing replaced").toBe(false);
  });

  it("says no for a codex replaced long ago, however long the pane ran", () => {
    expect(replacedWhileLive(NOW - CODEX_UPDATE_WINDOW_MS, 3_600_000, NOW)).toBe(true);
    expect(replacedWhileLive(NOW - CODEX_UPDATE_WINDOW_MS - 1, 3_600_000, NOW)).toBe(false);
    expect(replacedWhileLive(NOW - 30 * 24 * 3_600_000, 3_600_000, NOW)).toBe(false);
    // npm's fixed 1985 times are mtimes; a ctime that old is a file nobody touched.
    expect(replacedWhileLive(499_162_500_000, 60_000, NOW)).toBe(false);
  });

  it("says no for a duration that is not one, or a ctime that is not a time", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60000", null, undefined, {}]) {
      expect(replacedWhileLive(NOW, bad, NOW), String(bad)).toBe(false);
    }
    for (const bad of [undefined, null, Number.NaN, "1"]) expect(replacedWhileLive(bad, 60_000, NOW), String(bad)).toBe(false);
  });
});

describe("liveForOf", () => {
  it("takes a duration in milliseconds, held to a day, and nothing else", () => {
    expect(liveForOf(0)).toBe(0);
    expect(liveForOf(61_234.5)).toBe(61_234.5);
    expect(liveForOf(LIVE_FOR_MAX_MS * 10)).toBe(LIVE_FOR_MAX_MS);
    expect(LIVE_FOR_MAX_MS).toBe(24 * 3_600_000);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined, true]) expect(liveForOf(bad), String(bad)).toBeNull();
  });
});

describe("codexBin", () => {
  const exists = (have: string[]) => (p: string) => have.includes(p);
  it("finds codex on PATH first, then where npm and Homebrew put it", () => {
    const home = "/home/u";
    const local = posix.join(home, ".local", "bin", "codex");
    const env = { PATH: "/a:/b" };
    expect(codexBin({ env, platform: "linux", home, exists: exists(["/b/codex", local, "/usr/local/bin/codex"]) })).toBe("/b/codex");
    expect(codexBin({ env, platform: "linux", home, exists: exists([local, "/opt/homebrew/bin/codex"]) })).toBe(local);
    expect(codexBin({ env, platform: "darwin", home, exists: exists(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) })).toBe("/opt/homebrew/bin/codex");
    expect(codexBin({ env, platform: "darwin", home, exists: exists(["/usr/local/bin/codex"]) })).toBe("/usr/local/bin/codex");
    expect(codexBin({ env, platform: "linux", home, exists: exists([]) })).toBeNull();
    expect(codexBin({ env, platform: "linux", home, exists: () => { throw new Error("EACCES"); } }), "a lookup that throws finds nothing").toBeNull();
  });
});

describe("codexReplaced", () => {
  const fresh = { ctimeMs: NOW - 2_000 };
  const old = { ctimeMs: NOW - 10 * 60_000 };

  it("follows the command to the file it links to, and reads that file's ctime", async () => {
    const realpathFn = vi.fn(async (p: string) => `${p}.real`);
    const statFn = vi.fn(async () => fresh);
    expect(await codexReplaced(60_000, { findBin: () => "/x/bin/codex", realpathFn, statFn, now: () => NOW })).toBe(true);
    expect(realpathFn).toHaveBeenCalledWith("/x/bin/codex");
    expect(statFn).toHaveBeenCalledWith("/x/bin/codex.real");
    expect(await codexReplaced(60_000, { findBin: () => "/x/bin/codex", realpathFn, statFn: async () => old, now: () => NOW })).toBe(false);
  });

  it("says no when there is no codex, a link leads nowhere, or the file cannot be read", async () => {
    const statFn = vi.fn(async () => fresh);
    expect(await codexReplaced(60_000, { findBin: () => null, statFn, now: () => NOW })).toBe(false);
    expect(statFn, "nothing to read").not.toHaveBeenCalled();
    const gone = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(await codexReplaced(60_000, { findBin: () => "/x/codex", realpathFn: async () => { throw gone; }, statFn, now: () => NOW })).toBe(false);
    expect(await codexReplaced(60_000, { findBin: () => "/x/codex", realpathFn: async (p: string) => p, statFn: async () => { throw gone; }, now: () => NOW })).toBe(false);
    expect(await codexReplaced(60_000, { findBin: () => { throw new Error("odd"); }, now: () => NOW })).toBe(false);
  });

  it("reads a real link in a scratch folder: just written is replaced, the same file ten minutes on is not", async () => {
    const lib = join(DIR, "lib", "node_modules", "@openai", "codex", "bin");
    mkdirSync(lib, { recursive: true });
    const target = join(lib, "codex.js");
    writeFileSync(target, "#!/usr/bin/env node\n");
    mkdirSync(join(DIR, "bin"));
    let bin = join(DIR, "bin", "codex");
    // A link as npm makes one; Windows may refuse to make a link without the
    // right, and its npm writes a shim file instead, which is then the file.
    try { symlinkSync(target, bin); } catch { bin = target; }
    expect(await codexReplaced(60_000, { findBin: () => bin })).toBe(true);
    expect(await codexReplaced(60_000, { findBin: () => bin, now: () => Date.now() + 10 * 60_000 })).toBe(false);
    expect(await codexReplaced(60_000, { findBin: () => join(DIR, "bin", "no-codex") })).toBe(false);
  });
});
