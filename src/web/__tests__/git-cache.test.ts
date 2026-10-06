// The git view's reads are cached per worktree and recomputed only once
// something marks the worktree stale — no polling — with a short age limit
// for changes no agent made. These change real repositories behind the cache's
// back and check what it answers.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const HOME = tempDir("ccdeck-git-cache-home-");
const KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "PATH", "CCDECK_TEST_GIT_HOLD"] as const;
const prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

// @ts-expect-error — plain .mjs server module, no types
const state = await import("../../server/git-state.mjs");
const { repoOf, repoTopOf, statusOf, logOf, markStale, staleCount, clearGitState, setGitClock, MAX_AGE_MS } = state;

const made: string[] = [HOME];
const track = (d: string) => { made.push(d); return d; };
afterEach(() => { clearGitState(); setGitClock(null); });
afterAll(() => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  for (const d of made) rmTempDir(d);
});

const paths = (s: any) => s.entries.map((e: any) => `${e.area}:${e.path}`);

describe("the repository of a folder", () => {
  it("is read once and kept until a mark, whatever happens behind it", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    expect((await repoOf(dir)).head.branch).toBe("main");
    sh(dir, ["checkout", "-q", "-b", "elsewhere"]);
    expect((await repoOf(dir)).head.branch).toBe("main");
    expect(markStale(dir)).toEqual([dir]);
    const after = await repoOf(dir);
    expect(after.head.branch).toBe("elsewhere");
    expect(after.stale).toBe(1);
  });

  it("is read again past the age limit, for a change no agent made", async () => {
    let t = 1_000_000;
    setGitClock(() => t);
    const dir = track(repoWith({ "a.txt": "one\n" }));
    expect((await repoOf(dir)).head.branch).toBe("main");
    sh(dir, ["checkout", "-q", "-b", "by-hand"]);
    t += MAX_AGE_MS - 1;
    expect((await repoOf(dir)).head.branch).toBe("main");
    t += 2;
    expect((await repoOf(dir)).head.branch).toBe("by-hand");
  });

  it("notices a folder becoming a repository once something marks it", async () => {
    const dir = track(tempDir("ccdeck-git-cache-plain-"));
    expect((await repoOf(dir)).state).toBe("not-a-repo");
    sh(dir, ["init", "-q", "-b", "main"]);
    expect((await repoOf(dir)).state).toBe("not-a-repo");
    markStale(dir);
    expect((await repoOf(dir)).state).toBe("repo");
  });

  it("answers the commit recorder's question in its own shape", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    expect(await repoTopOf(join(dir))).toEqual({ top: dir, commonDir: join(dir, ".git") });
    expect(await repoTopOf(track(tempDir("ccdeck-git-cache-none-")))).toBeNull();
  });

  it("shares one read between askers that arrive together", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const [a, b] = await Promise.all([repoOf(dir), repoOf(dir)]);
    expect(a).toEqual(b);
  });
});

describe("status and history", () => {
  it("are kept until a mark from a folder inside the worktree", async () => {
    const dir = track(repoWith({ "src/a.txt": "one\n" }));
    const repo = await repoOf(dir);
    expect(paths(await statusOf(repo))).toEqual([]);
    write(dir, { "src/a.txt": "two\n" });
    expect(paths(await statusOf(repo))).toEqual([]);
    // A folder outside the repository marks nothing.
    markStale(track(tempDir("ccdeck-git-cache-other-")));
    expect(paths(await statusOf(repo))).toEqual([]);
    expect(markStale(join(dir, "src"))).toEqual([dir]);
    expect(paths(await statusOf(repo))).toEqual(["unstaged:src/a.txt"]);
  });

  it("marks every worktree of one repository together, since history is shared", async () => {
    const main = track(repoWith({ "a.txt": "one\n" }));
    const wt = join(track(tempDir("ccdeck-git-cache-wt-")), "side");
    sh(main, ["worktree", "add", "-q", "-b", "side", wt]);
    const [r1, r2] = [await repoOf(main), await repoOf(wt)];
    expect((await logOf(r2)).commits).toHaveLength(1);
    write(main, { "a.txt": "two\n" });
    sh(main, ["commit", "-q", "-am", "second"]);
    expect((await logOf(r2)).commits).toHaveLength(1);
    expect(markStale(main).sort()).toEqual([main, wt].sort());
    expect((await logOf(r2)).commits).toHaveLength(2);
    expect(staleCount(main)).toBe(1);
    expect(staleCount(wt)).toBe(1);
    expect((await repoOf(wt)).stale).toBe(1);
    expect(r1.topLevel).toBe(main);
  });

  it("does not keep a read that began before a mark", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const repo = await repoOf(dir);
    const early = statusOf(repo);
    markStale(dir);
    write(dir, { "late.txt": "x\n" });
    await early;
    expect(paths(await statusOf(repo))).toContain("untracked:late.txt");
  });

  // A git on PATH that, while CCDECK_TEST_GIT_HOLD names a folder, holds the
  // answer of a `sub` it ran: it leaves `ran` there and answers once `release`
  // appears. A shell script, so not on Windows.
  const holdingGit = (sub: string) => {
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = track(tempDir("ccdeck-git-cache-bin-"));
    const hold = track(tempDir("ccdeck-git-cache-hold-"));
    writeFileSync(join(bin, "git"), [
      "#!/bin/sh",
      `out=$(mktemp); err=$(mktemp); '${real}' "$@" >"$out" 2>"$err"; code=$?`,
      `case " $* " in *" ${sub} "*) if [ -n "$CCDECK_TEST_GIT_HOLD" ]; then touch "$CCDECK_TEST_GIT_HOLD/ran"; i=0; while [ ! -e "$CCDECK_TEST_GIT_HOLD/release" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; fi;; esac`,
      'cat "$out"; cat "$err" >&2; rm -f "$out" "$err"; exit $code',
    ].join("\n") + "\n");
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${prev.PATH}`;
    process.env.CCDECK_TEST_GIT_HOLD = hold;
    return {
      ran: async () => {
        for (let i = 0; i < 200 && !existsSync(join(hold, "ran")); i++) await new Promise(r => setTimeout(r, 25));
        return existsSync(join(hold, "ran"));
      },
      release: () => writeFileSync(join(hold, "release"), ""),
      restore: () => { process.env.PATH = prev.PATH; delete process.env.CCDECK_TEST_GIT_HOLD; },
    };
  };

  it.skipIf(process.platform === "win32")("never hands a repository read still running from before a mark to an asker after it", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const held = holdingGit("symbolic-ref");
    try {
      const early = repoOf(dir);
      expect(await held.ran()).toBe(true);
      sh(dir, ["checkout", "-q", "-b", "moved"]);
      markStale(dir);
      const late = repoOf(dir);
      held.release();
      expect((await early).head.branch).toBe("main");
      expect((await late).head.branch).toBe("moved");
      expect((await repoOf(dir)).head.branch).toBe("moved");
    } finally {
      held.restore();
    }
  });

  it.skipIf(process.platform === "win32")("never hands a read still running from before a mark to an asker after it", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const repo = await repoOf(dir);
    const held = holdingGit("status");
    try {
      const early = statusOf(repo);
      expect(await held.ran()).toBe(true);
      // The agent writes a file and its call marks the worktree, while the
      // read before it is still answering.
      write(dir, { "late.txt": "x\n" });
      markStale(dir);
      const late = statusOf(repo);
      held.release();
      expect(paths(await early)).toEqual([]);
      expect(paths(await late)).toContain("untracked:late.txt");
      expect(paths(await statusOf(repo))).toContain("untracked:late.txt");
    } finally {
      held.restore();
    }
  });

  it("re-reads only the working tree after an edit, which cannot move a branch", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const wt = join(track(tempDir("ccdeck-git-cache-editwt-")), "side");
    sh(dir, ["worktree", "add", "-q", "-b", "side", wt]);
    const repo = await repoOf(dir);
    await repoOf(wt);
    expect((await logOf(repo)).commits).toHaveLength(1);
    expect(paths(await statusOf(repo))).toEqual([]);
    // Behind the cache's back: a commit, and then an edit.
    write(dir, { "a.txt": "two\n" });
    sh(dir, ["commit", "-q", "-am", "second"]);
    write(dir, { "b.txt": "new\n" });
    expect(markStale(join(dir, "b.txt"), [], { tree: true })).toEqual([dir]);
    expect(staleCount(dir)).toBe(1);
    expect(staleCount(wt)).toBe(0);
    expect(paths(await statusOf(repo))).toEqual(["untracked:b.txt"]);
    expect((await logOf(repo)).commits).toHaveLength(1);
    expect((await repoOf(dir)).head.sha).toBe(repo.head.sha);
    // A command's mark reaches all of it.
    markStale(dir);
    expect((await logOf(repo)).commits).toHaveLength(2);
    expect(staleCount(wt)).toBe(1);
  });

  it("can be told the session's own worktree when the folder it names is spelled differently", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    await repoOf(dir);
    expect(markStale("/nowhere/near", [dir])).toEqual([dir]);
  });
});
