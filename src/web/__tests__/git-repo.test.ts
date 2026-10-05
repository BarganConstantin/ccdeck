// Which repository a session's folder is in, and where its HEAD points — read
// from real repositories in every shape the git view has to name: a plain
// checkout, a subfolder, a detached HEAD, a linked worktree, a repository with
// no commits, a folder that is not a repository, one that has gone, and a
// machine with no git at all.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, emptyRepo, repoWith, sh, tempDir, write } from "./git-fixture";

const HOME = tempDir("ccdeck-git-repo-home-");
const KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "PATH"] as const;
const prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

// @ts-expect-error — plain .mjs server module, no types
const { resolveRepo, readUpstream } = await import("../../server/git-repo.mjs");

const made: string[] = [HOME];
const track = (dir: string) => { made.push(dir); return dir; };
afterAll(() => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  for (const dir of made) rmTempDir(dir);
});

describe("resolveRepo", () => {
  it("names a plain checkout, its git directory and the branch HEAD is on", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const sha = sh(dir, ["rev-parse", "HEAD"]).trim();
    const r = await resolveRepo(dir);
    expect(r).toMatchObject({
      state: "repo", topLevel: dir, gitDir: join(dir, ".git"), commonDir: join(dir, ".git"),
      linkedWorktree: false, name: basename(dir), mainName: basename(dir), folderName: basename(dir), nameDiffers: false,
      empty: false,
      head: { branch: "main", detached: false, sha, short: sha.slice(0, 7), unborn: false },
    });
  });

  it("finds the top level from a subfolder, and says the folder's name is not the repository's", async () => {
    const dir = track(repoWith({ "pkg/web/a.txt": "one\n" }));
    const r = await resolveRepo(join(dir, "pkg", "web"));
    expect(r).toMatchObject({ state: "repo", topLevel: dir, name: basename(dir), folderName: "web", nameDiffers: true });
  });

  it("names a detached HEAD by its short SHA and no branch", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const sha = commitAll(dir, "second");
    sh(dir, ["checkout", "-q", "--detach", "HEAD"]);
    const r = await resolveRepo(dir);
    expect(r.head).toEqual({ branch: null, detached: true, sha, short: sha.slice(0, 7), unborn: false });
  });

  it("knows a linked worktree from the checkout it shares a repository with", async () => {
    const main = track(repoWith({ "a.txt": "one\n" }));
    const wt = join(track(tempDir("ccdeck-git-wt-")), "feature-x");
    sh(main, ["worktree", "add", "-q", "-b", "feature/x", wt]);
    const r = await resolveRepo(wt);
    expect(r).toMatchObject({
      state: "repo", topLevel: wt, commonDir: join(main, ".git"), linkedWorktree: true,
      name: "feature-x", mainName: basename(main), head: { branch: "feature/x", detached: false },
    });
    expect(r.gitDir.startsWith(join(main, ".git", "worktrees"))).toBe(true);
    // And the main checkout still reads as itself.
    expect((await resolveRepo(main)).head.branch).toBe("main");
  });

  it("calls a repository with no commits empty, with HEAD on a branch that has none yet", async () => {
    const dir = track(emptyRepo());
    const r = await resolveRepo(dir);
    expect(r).toMatchObject({ state: "repo", empty: true, head: { branch: "main", detached: false, sha: null, short: null, unborn: true } });
  });

  it("does not call a repository empty because the branch checked out has no commits", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    sh(dir, ["checkout", "-q", "--orphan", "fresh"]);
    const r = await resolveRepo(dir);
    expect(r).toMatchObject({ state: "repo", empty: false, head: { branch: "fresh", unborn: true } });
  });

  it("answers not-a-repo for a folder outside any repository", async () => {
    const dir = track(tempDir("ccdeck-git-plain-"));
    expect(await resolveRepo(dir)).toEqual({ state: "not-a-repo" });
  });

  it("answers gone for a folder that no longer exists, without asking git", async () => {
    const dir = track(tempDir("ccdeck-git-gone-"));
    expect(await resolveRepo(join(dir, "deleted"))).toEqual({ state: "gone" });
    expect(await resolveRepo("")).toEqual({ state: "gone" });
  });

  it("answers no-git when git is not on PATH", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const bin = join(track(tempDir("ccdeck-git-nopath-")), "bin");
    mkdirSync(bin);
    process.env.PATH = bin;
    try {
      expect(await resolveRepo(dir)).toEqual({ state: "no-git" });
    } finally {
      process.env.PATH = prev.PATH;
    }
  });
});

describe("readUpstream", () => {
  it("counts ahead and behind against the upstream from local refs only", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    sh(dir, ["branch", "base"]);
    sh(dir, ["branch", "--set-upstream-to=base", "main"]);
    expect(await readUpstream(dir, "main")).toEqual({ name: "base", ahead: 0, behind: 0, gone: false });
    write(dir, { "b.txt": "two\n" });
    commitAll(dir, "ahead one");
    sh(dir, ["checkout", "-q", "base"]);
    write(dir, { "c.txt": "three\n" });
    commitAll(dir, "behind one");
    commitAll(dir, "behind two");
    sh(dir, ["checkout", "-q", "main"]);
    expect(await readUpstream(dir, "main")).toEqual({ name: "base", ahead: 1, behind: 2, gone: false });
  });

  it("says an upstream that was deleted is gone, and a branch without one has none", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    sh(dir, ["branch", "base"]);
    sh(dir, ["branch", "--set-upstream-to=base", "main"]);
    sh(dir, ["branch", "-q", "-D", "base"]);
    expect(await readUpstream(dir, "main")).toMatchObject({ name: "base", gone: true });
    sh(dir, ["branch", "--unset-upstream", "main"]);
    expect(await readUpstream(dir, "main")).toBeNull();
    expect(await readUpstream(dir, null)).toBeNull();
  });
});
