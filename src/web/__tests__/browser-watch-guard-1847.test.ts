// Two Browser Watch test files still ran the real browser survey on the
// developer's machine — `dig`, `pgrep`, `lsof`, and the profile folders and lock
// files under the real home — after #1825 had sealed a third (#1847). The seal
// is browser-watch-guard.ts now, and this file holds every file to it: the ones
// that import browser-watch.mjs are listed from the directory, not from memory,
// and each has to install both halves.
//
// It installs them itself as well, and the first cases check that they hold —
// so the list below cannot be satisfied by a guard that guards nothing.
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as childProcess from "node:child_process";
import { STARTERS, guardThisMachine, takeSpawned } from "./browser-watch-guard";

vi.mock("node:child_process", async (real) =>
  (await import("./browser-watch-guard")).trappedChildProcess(await real()));
const { home } = guardThisMachine();

const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("the guard", () => {
  it("stops every way of starting a process, and writes each one down", () => {
    for (const name of STARTERS) {
      const start = (childProcess as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
      expect(() => start("pgrep", ["-x", "chrome"]), name).toThrow(`ran a real ${name}`);
    }
    // Taken here, or this case's own afterEach would fail it.
    expect(takeSpawned()).toEqual(STARTERS.map(n => `${n}("pgrep", ["-x","chrome"])`));
  });

  it("points the home and every config directory into a temp dir", () => {
    expect(homedir()).toBe(home);
    for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR"]) {
      const rel = relative(home, String(process.env[name]));
      expect(rel.startsWith("..") || rel.includes(":"), `${name} is ${process.env[name]}`).toBe(false);
    }
  });
});

/** Every test file here that imports browser-watch.mjs, by a static import or
 *  a dynamic one. */
function importers(): string[] {
  const imports = /(?:\bfrom\s*|\bimport\(\s*)["']\.\.\/\.\.\/server\/browser-watch\.mjs["']/;
  return readdirSync(HERE)
    .filter(f => /\.test\.(ts|tsx|mjs)$/.test(f))
    .filter(f => imports.test(readFileSync(join(HERE, f), "utf8")))
    .sort();
}

describe("every file that imports browser-watch.mjs", () => {
  it("is found, including the ones #1825 left out", () => {
    // The two the issue named, and the one #1825 sealed: a pattern that stopped
    // matching would otherwise pass every case below by listing nothing.
    expect(importers()).toEqual(expect.arrayContaining([
      "browser-watch-election-1171.test.ts",
      "relay-guard-wired-799.test.ts",
      "browser-watch.test.ts",
    ]));
  });

  it("installs the guard: the child_process trap and the temp home", () => {
    const trap = /vi\.mock\(\s*"node:child_process",\s*async \((\w+)\) =>\s*\(await import\("\.\/browser-watch-guard"\)\)\.trappedChildProcess\(await \1\(\)\)\s*\)/;
    const home = /^(?:const [^=]+= )?guardThisMachine\(/m;
    const missing = importers().flatMap(f => {
      const text = readFileSync(join(HERE, f), "utf8");
      return [
        ...(trap.test(text) ? [] : [`${f}: no child_process trap`]),
        ...(home.test(text) ? [] : [`${f}: no guardThisMachine()`]),
      ];
    });
    expect(missing).toEqual([]);
  });
});
