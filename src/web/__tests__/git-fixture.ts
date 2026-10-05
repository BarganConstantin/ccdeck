// Real repositories for the git-view tests, made in a temp directory with the
// git on PATH.
//
// The commands that BUILD a fixture write freely — that is what a fixture is —
// and they run with no system or global configuration, a fixed identity and a
// fixed clock, so a developer's commit.gpgsign or init.defaultBranch cannot
// change what the tests see. What the deck itself runs goes through
// src/server/git-run.mjs, which the tests are there to hold to account.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = process.platform === "win32" ? "git.exe" : "git";

function fixtureEnv(when = "2026-01-02T03:04:05Z"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!(process.platform === "win32" ? k.toUpperCase() : k).startsWith("GIT_")) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Ada Lovelace",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada Lovelace",
    GIT_COMMITTER_EMAIL: "ada@example.com",
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
    LC_ALL: "C",
  };
}

/** Run git to BUILD a fixture, in `cwd`, and answer its stdout. Throws. */
export function sh(cwd: string, args: string[], input?: string, when?: string): string {
  return execFileSync(GIT, args, { cwd, env: fixtureEnv(when), input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** A fresh directory under the OS temp folder, symlinks resolved. */
export function tempDir(prefix: string): string {
  // The long, on-disk spelling git itself prints (an 8.3 short TEMP on
  // Windows, /private/var on macOS), so paths compare equal to its answers.
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** A new repository on `main` in a fresh temp directory, with no commits. */
export function emptyRepo(prefix = "ccdeck-git-"): string {
  const dir = tempDir(prefix);
  sh(dir, ["init", "-q", "-b", "main", "."]);
  sh(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

/** Write `files` (path → content) under `dir`, making folders as needed. */
export function write(dir: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Stage everything and commit it, answering the new commit's SHA. */
export function commitAll(dir: string, message: string, when?: string): string {
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "--allow-empty", "-m", message], undefined, when);
  return sh(dir, ["rev-parse", "HEAD"]).trim();
}

/** A repository with one commit holding `files`. */
export function repoWith(files: Record<string, string | Buffer>, prefix?: string): string {
  const dir = emptyRepo(prefix);
  write(dir, files);
  commitAll(dir, "first");
  return dir;
}

/**
 * A program the repository's configuration can point git at — an fsmonitor
 * hook, an external diff, a textconv, a clean filter — that leaves `marker`
 * behind when anything starts it, and passes its input through. A shell script
 * on every platform: git runs these through its own shell, and Git for Windows
 * brings one. The file existing afterwards means git ran it.
 */
export function markerProgram(dir: string, name: string, marker: string): string {
  const slash = (p: string) => p.replace(/\\/g, "/");
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ran >> '${slash(marker)}'\ncat\n`);
  chmodSync(path, 0o755);
  return slash(path);
}

/**
 * The names created or changed under `dir` between this call and `stop()`, for
 * the tests that assert no lock file ever appeared while the deck read.
 *
 * Bracketed by two marker files the watcher has to report back, because a
 * watcher reports late: macOS's FSEvents in particular hands over the lock the
 * fixture's own `git add` took a moment before the watch began. Everything
 * before the first marker is the fixture's; everything before the second has
 * arrived. A machine out of file watchers (EMFILE) answers an empty list: the
 * index's own bytes and time, which those tests also compare, remain the proof.
 */
export async function watchNames(dir: string): Promise<{ stop: () => Promise<string[]> }> {
  const seen: string[] = [];
  let w: ReturnType<typeof watch>;
  try {
    w = watch(dir, (_e, name) => { if (name) seen.push(String(name)); });
    w.on("error", () => {});
  } catch {
    return { stop: async () => [] };
  }
  const tag = Math.random().toString(36).slice(2);
  const arrived = async (name: string) => {
    writeFileSync(join(dir, name), "");
    for (let i = 0; i < 300 && !seen.includes(name); i++) await new Promise(r => setTimeout(r, 10));
    return seen.indexOf(name);
  };
  const from = await arrived(`ccdeck-watch-start-${tag}`);
  return {
    stop: async () => {
      const to = await arrived(`ccdeck-watch-end-${tag}`);
      w.close();
      if (from < 0 || to < 0) return [];
      return seen.slice(from + 1, to).filter(n => !n.startsWith("ccdeck-watch-"));
    },
  };
}
