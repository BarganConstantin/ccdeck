// The git view's reads are cached per worktree and recomputed only once
// something marks the worktree stale — no polling — with a short age limit
// for changes no agent made. These change real repositories behind the cache's
// back and check what it answers.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const HOME = tempDir("ccdeck-git-cache-home-");
const KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
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

  it("can be told the session's own worktree when the folder it names is spelled differently", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    await repoOf(dir);
    expect(markStale("/nowhere/near", [dir])).toEqual([dir]);
  });
});
