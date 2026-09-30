// NO BROWSER WATCH TEST MAY RUN A PROGRAM OR LOOK AT THIS MACHINE (#1825, #1847).
//
// A snapshot ends in the browser survey — a `dig` for the relay name, a `pgrep`
// per browser, an `lsof` per running one, and the profile folders, their lock
// files and /proc behind them — and the survey falls back to the real
// child_process and the real home for anything its deps leave out. #1825 sealed
// browser-watch.test.ts against that with the guard below; the election and
// relay-guard files, among others, went on surveying the developer's own
// browsers. So the guard lives here now, every file that imports
// browser-watch.mjs installs it, and browser-watch-guard-1847.test.ts fails one
// that does not.
//
// TWO HALVES, AND THE FIRST IS A LINE IN THE FILE ITSELF. vitest hoists a
// `vi.mock` to the top of the file that declares it, ahead of that file's
// imports; declared in here, it would register only once this module had
// loaded, and whether that came before browser-watch.mjs would be down to
// import order. So each file declares the mock, and this module supplies what
// it returns — every way of starting a process, replaced by one that writes the
// call down and throws:
//
//   vi.mock("node:child_process", async (real) =>
//     (await import("./browser-watch-guard")).trappedChildProcess(await real()));
//
// `guardThisMachine()` is the other half: HOME and every config directory a
// default path is built from point into a temp dir for the rest of the file,
// and a case that reached the real child_process fails when it ends.
//
// The survey still runs, all of it — against the machine linux-browser-fixture.ts
// holds in memory, whose `deps` a harness spreads into what it hands the
// snapshot, or with `browserSurvey` stubbed where the survey is not the subject.
import { afterAll, afterEach, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

/** Every way node:child_process starts a process. */
export const STARTERS = ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"] as const;

/** What the traps were asked to start since the last look. The traps write
 *  here, reached through the file's mock; the guard reads it after each case. */
const spawned: string[] = [];

/** And empties it. */
export const takeSpawned = (): string[] => spawned.splice(0);

/** node:child_process with every way of starting a process replaced by one
 *  that writes the call down and throws. For the file's own `vi.mock`. */
export function trappedChildProcess<T extends object>(real: T): T {
  const trap = (name: string) => (...args: unknown[]) => {
    spawned.push(`${name}(${JSON.stringify(args[0])}, ${JSON.stringify(args[1])})`);
    throw new Error(`a Browser Watch test ran a real ${name}`);
  };
  const traps = Object.fromEntries(STARTERS.map(n => [n, trap(n)]));
  return { ...real, ...traps, default: { ...real, ...traps } };
}

/**
 * Points the home and config directories into a temp dir for the rest of the
 * file, and fails any case after which the trap holds a call. Called at the top
 * of the file, so whatever the file imports or reads after it sees the temp
 * home too.
 *
 * `configDir` is for a file that keeps records of its own in CLAUDE_CONFIG_DIR
 * — the election's registry — and must not have it moved from under it.
 */
export function guardThisMachine({ configDir }: { configDir?: string } = {}): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "ccdeck-watch-guard-"));
  // Every name a default path on the three platforms is built from.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("LOCALAPPDATA", join(home, "AppData", "Local"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir ?? join(home, ".claude"));
  afterEach(() => {
    expect(takeSpawned(), "a case reached the real child_process").toEqual([]);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmTempDir(home);
  });
  return { home };
}
