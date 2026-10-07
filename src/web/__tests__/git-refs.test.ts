// The sidebar's read, GET /api/git/refs, on real repositories: every branch
// with its upstream and how far it is from it, a gone upstream, remote-tracking
// branches under a remote whose name holds a slash, annotated and lightweight
// tags, the stash, worktrees locked and missing, a submodule read without
// starting a git inside it — and the caps that keep a repository of thousands
// of refs to one bounded answer. Through the real server: a request names a
// session, never a folder.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, emptyRepo, repoWith, sh, tempDir, watchNames, write } from "./git-fixture";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-git-refs-"));
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");

// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { GUARDED_READS } = await import("../../server/request-gates.mjs");
// @ts-expect-error — plain .mjs server module, no types
const refsMod = await import("../../server/git-refs.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { gitArgv } = await import("../../server/git-run.mjs");
const { readRefs, MAX_REFS, parseStashes, parseWorktrees, parseGitmodules, parseGitlinks, splitRemoteRef, clearRefsCache } = refsMod;

const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };

let server: Server;
let port = 0;
let repo = "";
let origin = "";
let linked = "";
let locked = "";
let gone = "";
let sub = "";
let mainSha = "";
let annotatedTarget = "";

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...headers } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch { /* status is enough */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const event = (payload: Record<string, unknown>) => call("POST", "/api/event", payload);
const setGit = (on: boolean) => call("POST", "/api/prefs", { git: on }, { "x-ccdeck-token": hookToken() });
const read = (path: string) => call("GET", path, undefined, { "x-ccdeck-token": hookToken() });
const refs = (params: Record<string, string>) => read(`/api/git/refs?${new URLSearchParams(params)}`);
const slash = (p: string) => p.replace(/\\/g, "/");

beforeAll(async () => {
  origin = track(tempDir("ccdeck-git-refs-origin-"));
  sh(origin, ["init", "-q", "--bare", "-b", "main", "."]);
  repo = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-refs-repo-"));
  sh(repo, ["remote", "add", "origin", origin]);
  sh(repo, ["push", "-q", "-u", "origin", "main"]);
  // origin/main one ahead of main, and main one of its own: 1 ahead, 1 behind.
  write(repo, { "a.txt": "two\n" });
  commitAll(repo, "pushed then dropped");
  sh(repo, ["push", "-q", "origin", "main"]);
  sh(repo, ["reset", "-q", "--hard", "HEAD~1"]);
  write(repo, { "b.txt": "b\n" });
  mainSha = commitAll(repo, "local only");
  // A branch pushed and then deleted on the remote: its upstream is gone.
  sh(repo, ["checkout", "-q", "-b", "feature/gone"]);
  commitAll(repo, "gone work");
  sh(repo, ["push", "-q", "-u", "origin", "feature/gone"]);
  sh(repo, ["push", "-q", "origin", "--delete", "feature/gone"]);
  sh(repo, ["checkout", "-q", "main"]);
  sh(repo, ["branch", "-q", "feature/deep/one"]);
  sh(repo, ["branch", "-q", "feature/deep/two"]);
  // A remote whose name holds a slash.
  sh(repo, ["remote", "add", "team/eu", origin]);
  sh(repo, ["fetch", "-q", "team/eu"]);
  // Tags: lightweight, annotated, and one in a folder.
  sh(repo, ["tag", "v1.0.0"]);
  sh(repo, ["tag", "-a", "v1.1.0", "-m", "release 1.1"]);
  annotatedTarget = mainSha;
  sh(repo, ["tag", "deploy/staging"]);
  // Tags of what is not a commit: a tree (annotated) and a blob (lightweight).
  sh(repo, ["tag", "-a", "tree-tag", "-m", "a tag of a tree", "main^{tree}"]);
  sh(repo, ["tag", "blob-tag", "main:a.txt"]);
  // Two stashes: one named, one with git's own message.
  write(repo, { "a.txt": "stash me\n" });
  sh(repo, ["stash", "push", "-q", "-m", "tidy the parser"]);
  write(repo, { "a.txt": "stash me too\n" });
  sh(repo, ["stash", "push", "-q"]);
  // Worktrees: one linked, one locked, one whose folder is gone.
  const wts = track(tempDir("ccdeck-git-refs-wts-"));
  linked = join(wts, "agent-wt");
  locked = join(wts, "usb-wt");
  gone = join(wts, "gone-wt");
  sh(repo, ["worktree", "add", "-q", "-b", "agent/x", linked]);
  sh(repo, ["worktree", "add", "-q", "-b", "usb", locked]);
  sh(repo, ["worktree", "lock", "--reason", "on a stick", locked]);
  sh(repo, ["worktree", "add", "-q", "--detach", gone]);
  rmTempDir(gone);
  // A submodule.
  sub = track(repoWith({ "lib.txt": "lib\n" }, "ccdeck-git-refs-sub-"));
  sh(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", slash(sub), "libs/the-lib"]);
  commitAll(repo, "add the lib");
  mainSha = sh(repo, ["rev-parse", "HEAD"]).trim();

  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  await event({ hook_event_name: "SessionStart", session_id: "R-repo", cwd: repo });
  await event({ hook_event_name: "PreToolUse", session_id: "R-repo", cwd: linked, agent_id: "ag-wt", tool_name: "Read" });
  const plain = track(tempDir("ccdeck-git-refs-plain-"));
  await event({ hook_event_name: "SessionStart", session_id: "R-plain", cwd: plain });
});

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  for (const d of made) rmTempDir(d);
  rmTempDir(DIR);
});

describe("who may read", () => {
  it("is a guarded read, refused to a caller that presents nothing", async () => {
    expect(GUARDED_READS.has("/api/git/refs")).toBe(true);
    expect((await call("GET", "/api/git/refs?session=R-repo")).status).toBe(401);
  });

  it("is 400 without a session, 404 for one the deck never heard, and names why there is no repository", async () => {
    expect((await read("/api/git/refs")).status).toBe(400);
    expect((await refs({ session: "never-heard" })).status).toBe(404);
    expect((await refs({ session: "R-plain" })).body).toEqual({ ok: true, state: "not-a-repo", repo: null });
  });

  it("is 409 while git is switched off in Settings", async () => {
    expect((await setGit(false)).body.prefs.git).toBe(false);
    try {
      expect((await refs({ session: "R-repo" })).status).toBe(409);
    } finally {
      expect((await setGit(true)).body.prefs.git).toBe(true);
    }
  });

  it("reads the session's own folder, never a folder from the request", async () => {
    const r = await refs({ session: "R-repo", cwd: "/", folder: "/", path: "/" });
    expect(r.status).toBe(200);
    expect(r.body.repo.topLevel).toBe(repo);
  });
});

describe("the lists", () => {
  it("lists branches with the checked-out one, upstream counts, a gone upstream and the worktree holding each", async () => {
    const { body } = await refs({ session: "R-repo" });
    expect(body.ok).toBe(true);
    const byName = Object.fromEntries(body.branches.map((b: any) => [b.name, b]));
    expect(Object.keys(byName).sort()).toEqual(["agent/x", "feature/deep/one", "feature/deep/two", "feature/gone", "main", "usb"]);
    expect(byName.main).toMatchObject({ sha: mainSha, current: true, upstream: "origin/main", ahead: 2, behind: 1, gone: false, worktree: repo });
    expect(byName["feature/gone"]).toMatchObject({ current: false, upstream: "origin/feature/gone", gone: true, worktree: null });
    expect(byName["feature/deep/one"]).toMatchObject({ upstream: null, ahead: 0, behind: 0, gone: false });
    expect(byName["agent/x"]).toMatchObject({ current: false, worktree: linked });
  });

  it("groups remote-tracking branches by remote, keeping a slash in a remote's name and hiding its HEAD", async () => {
    const { body } = await refs({ session: "R-repo" });
    expect(body.remotes.map((r: any) => r.name)).toEqual(["origin", "team/eu"]);
    expect(body.remotes[0].branches.map((b: any) => b.name)).toEqual(["main"]);
    expect(body.remotes[1].branches.map((b: any) => b.name)).toEqual(["main"]);
    expect(body.remotes[0].branches[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists tags with the commit each names, saying which are annotated", async () => {
    const { body } = await refs({ session: "R-repo" });
    const tags = Object.fromEntries(body.tags.map((t: any) => [t.name, t]));
    expect(Object.keys(tags).sort()).toEqual(["blob-tag", "deploy/staging", "tree-tag", "v1.0.0", "v1.1.0"]);
    expect(tags["v1.1.0"]).toEqual({ name: "v1.1.0", sha: annotatedTarget, annotated: true });
    expect(tags["v1.0.0"]).toEqual({ name: "v1.0.0", sha: annotatedTarget, annotated: false });
  });

  it("says which tags name no commit, so the sidebar never sends one to the history", async () => {
    const { body } = await refs({ session: "R-repo" });
    const tags = Object.fromEntries(body.tags.map((t: any) => [t.name, t]));
    expect(tags["tree-tag"]).toEqual({ name: "tree-tag", sha: sh(repo, ["rev-parse", "tree-tag^{}"]).trim(), annotated: true, target: "tree" });
    expect(tags["blob-tag"]).toEqual({ name: "blob-tag", sha: sh(repo, ["rev-parse", "blob-tag"]).trim(), annotated: false, target: "blob" });
  });

  it("lists the stash newest first, with git's own subject", async () => {
    const { body } = await refs({ session: "R-repo" });
    expect(body.stashes.map((s: any) => s.index)).toEqual([0, 1]);
    expect(body.stashes[0].subject).toMatch(/^WIP on main: /);
    expect(body.stashes[1].subject).toBe("On main: tidy the parser");
    expect(body.stashes[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(body.stashes[0].date))).toBe(false);
  });

  it("lists every worktree: the session's own, a linked one, a locked one and one whose folder is gone", async () => {
    const { body } = await refs({ session: "R-repo" });
    const byName = Object.fromEntries(body.worktrees.map((w: any) => [w.name, w]));
    expect(byName[basename(repo)]).toMatchObject({ path: repo, branch: "main", current: true, locked: false, missing: false });
    expect(byName["agent-wt"]).toMatchObject({ path: linked, branch: "agent/x", current: false, locked: false, missing: false });
    expect(byName["usb-wt"]).toMatchObject({ branch: "usb", locked: true, missing: false });
    expect(byName["gone-wt"]).toMatchObject({ branch: null, prunable: true, missing: true });
    expect(body.unread).toEqual([]);
    expect(body.clipped).toEqual([]);
  });

  it("lists a submodule at the commit the index pins it to", async () => {
    const { body } = await refs({ session: "R-repo" });
    const pinned = sh(sub, ["rev-parse", "HEAD"]).trim();
    expect(body.submodules).toEqual([{ path: "libs/the-lib", name: "libs/the-lib", sha: pinned }]);
  });

  it("answers for a subagent's own worktree: its branch and worktree are the current ones", async () => {
    const { body } = await refs({ session: "R-repo", agent: "ag-wt" });
    expect(body.repo.topLevel).toBe(linked);
    expect(body.branches.find((b: any) => b.current)?.name).toBe("agent/x");
    expect(body.worktrees.find((w: any) => w.current)?.path).toBe(linked);
  });

  it("names the unborn branch of a repository with no commits", async () => {
    const empty = track(emptyRepo("ccdeck-git-refs-empty-"));
    await event({ hook_event_name: "SessionStart", session_id: "R-empty", cwd: empty });
    const { body } = await refs({ session: "R-empty" });
    expect(body.branches).toEqual([{ name: "main", sha: null, current: true, upstream: null, ahead: 0, behind: 0, gone: false, worktree: empty }]);
    expect(body.tags).toEqual([]);
    expect(body.stashes).toEqual([]);
    expect(body.submodules).toEqual([]);
  });
});

describe("read-only", () => {
  it("leaves the index and every ref as they were, and takes no lock", async () => {
    clearRefsCache();
    const index = join(repo, ".git", "index");
    const before = createHash("sha256").update(readFileSync(index)).digest("hex");
    const mtime = statSync(index).mtimeMs;
    const refsBefore = sh(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const watcher = await watchNames(join(repo, ".git"));
    const r = await readRefs({ topLevel: repo, head: { branch: "main", detached: false, sha: mainSha, short: "", unborn: false } });
    const touched = await watcher.stop();
    expect(r.ok).toBe(true);
    expect(touched.filter(n => /\.lock$/.test(n))).toEqual([]);
    expect(createHash("sha256").update(readFileSync(index)).digest("hex")).toBe(before);
    expect(statSync(index).mtimeMs).toBe(mtime);
    expect(sh(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
  });

  it("starts `worktree` only to list, and nothing else that writes", () => {
    expect(gitArgv("worktree", ["list", "--porcelain", "-z"])).toContain("list");
    for (const args of [[], ["add", "x"], ["remove", "x"], ["prune"], ["lock", "x"], ["move", "a", "b"]]) {
      expect(() => gitArgv("worktree", args), args.join(" ")).toThrow(/not a read/);
    }
    for (const sub of ["stash", "submodule"]) expect(() => gitArgv(sub, ["list"]), sub).toThrow(/not a read/);
    expect(gitArgv("ls-files", ["-s"]).join(" ")).toContain("--no-optional-locks");
  });
});

describe("caps", () => {
  it("lists at most MAX_REFS refs and says the list was cut", async () => {
    const many = track(repoWith({ "a.txt": "a\n" }, "ccdeck-git-refs-many-"));
    const head = sh(many, ["rev-parse", "HEAD"]).trim();
    sh(many, ["update-ref", "--stdin"], Array.from({ length: MAX_REFS + 50 }, (_, i) => `create refs/tags/t${String(i).padStart(5, "0")} ${head}\n`).join(""));
    sh(many, ["branch", "-q", "zz-last-branch"]);
    const r = await readRefs({ topLevel: many, head: { branch: "main", detached: false, sha: head, short: "", unborn: false } });
    expect(r.ok).toBe(true);
    // Branches come before tags in git's order, so every branch is listed.
    expect(r.branches.map((b: any) => b.name)).toEqual(["main", "zz-last-branch"]);
    expect(r.branches.length + r.tags.length).toBe(MAX_REFS);
    expect(r.clipped).toEqual(["refs"]);
  });

  it("caps stashes, worktrees and submodules, and says which lists were cut", async () => {
    const r = await readRefs({ topLevel: repo, head: { branch: "main", detached: false, sha: mainSha, short: "", unborn: false } },
      { maxRefs: 3, maxStashes: 1, maxWorktrees: 2, maxSubmodules: 0 });
    expect(r.branches.length + r.tags.length + r.remotes.reduce((n: number, x: any) => n + x.branches.length, 0)).toBe(3);
    expect(r.stashes.length).toBe(1);
    expect(r.worktrees.length).toBe(2);
    expect(r.submodules.length).toBe(0);
    expect(r.clipped.sort()).toEqual(["refs", "stashes", "submodules", "worktrees"]);
  });
});

describe("parsing", () => {
  it("reads git's own output shapes", () => {
    expect(parseStashes("stash@{0}\x1f" + "a".repeat(40) + "\x1fWIP on main: abc x\x1f2026-01-02T03:04:05+00:00\0")).toEqual([
      { index: 0, sha: "a".repeat(40), subject: "WIP on main: abc x", date: "2026-01-02T03:04:05+00:00" },
    ]);
    expect(parseWorktrees(`worktree /r\0HEAD ${"b".repeat(40)}\0branch refs/heads/main\0\0worktree /w\0HEAD ${"c".repeat(40)}\0detached\0locked\0prunable gitdir file points to non-existent location\0\0`)).toEqual([
      { path: "/r", branch: "main", sha: "b".repeat(40), locked: false, prunable: false, bare: false },
      { path: "/w", branch: null, sha: "c".repeat(40), locked: true, prunable: true, bare: false },
    ]);
    expect(parseGitmodules("submodule.libs/a.b.path\nlibs/a\0submodule.libs/a.b.url\n../a\0")).toEqual([{ name: "libs/a.b", path: "libs/a" }]);
    expect([...parseGitlinks(`160000 ${"d".repeat(40)} 0\tlibs/a\x00100644 ${"e".repeat(40)} 0\tREADME\x00`)]).toEqual([["libs/a", "d".repeat(40)]]);
    expect(splitRemoteRef("team/eu/feature/x", ["origin", "team/eu"])).toEqual({ remote: "team/eu", name: "feature/x" });
    expect(splitRemoteRef("stale/main", ["origin"])).toEqual({ remote: "stale", name: "main" });
  });
});
