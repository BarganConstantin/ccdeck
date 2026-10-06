// The git view's routes, through the real server: a request names a session and
// never a folder, a path is only ever one git itself reported, and every route
// is refused to a caller the other guarded reads refuse.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-git-routes-"));
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

const ROUTES = ["/api/git/repo", "/api/git/log", "/api/git/status", "/api/git/diff", "/api/git/commit", "/api/git/edits"];
const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };

let server: Server;
let port = 0;
let repo = "";
let firstSha = "";
let secondSha = "";
let worktree = "";

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
const read = (path: string) => call("GET", path, undefined, { "x-ccdeck-token": hookToken() });
const q = (route: string, params: Record<string, string>) => `${route}?${new URLSearchParams(params)}`;

beforeAll(async () => {
  repo = track(repoWith({ "a.txt": "one\n", "keep.txt": "keep\n" }));
  firstSha = sh(repo, ["rev-parse", "HEAD"]).trim();
  write(repo, { "a.txt": "two\n" });
  secondSha = commitAll(repo, "second");
  write(repo, { "a.txt": "three\n", "new.txt": "fresh\n" });
  worktree = join(track(tempDir("ccdeck-git-routes-wt-")), "agent-wt");
  sh(repo, ["worktree", "add", "-q", "-b", "agent/branch", worktree]);
  const plain = track(tempDir("ccdeck-git-routes-plain-"));
  const gone = join(plain, "deleted-later");
  mkdirSync(gone);

  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  await event({ hook_event_name: "SessionStart", session_id: "S-repo", cwd: repo });
  await event({ hook_event_name: "PreToolUse", session_id: "S-repo", cwd: worktree, agent_id: "ag-1", tool_name: "Read" });
  await event({ hook_event_name: "SessionStart", session_id: "S-plain", cwd: plain });
  await event({ hook_event_name: "SessionStart", session_id: "S-gone", cwd: gone });
  rmTempDir(gone);
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
  it("lists every git route with the guarded reads", () => {
    for (const r of ROUTES) expect(GUARDED_READS.has(r), r).toBe(true);
  });

  for (const r of ROUTES) {
    it(`refuses ${r} with 401 to a caller that presents nothing`, async () => {
      expect((await call("GET", q(r, { session: "S-repo", path: "a.txt", sha: secondSha }))).status).toBe(401);
    });
  }

  it("answers the deck's own page", async () => {
    const r = await call("GET", q("/api/git/repo", { session: "S-repo" }), undefined, { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("repo");
  });
});

describe("which repository", () => {
  it("resolves the session's own folder, and never a folder from the request", async () => {
    const r = await read(q("/api/git/repo", { session: "S-repo", cwd: "/", folder: "/", path: "/" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true, state: "repo",
      repo: { topLevel: repo, name: basename(repo), linkedWorktree: false, head: { branch: "main", detached: false, sha: secondSha }, upstream: null },
    });
  });

  it("reads a subagent's own worktree when it runs in one", async () => {
    const r = await read(q("/api/git/repo", { session: "S-repo", agent: "ag-1" }));
    expect(r.body.repo).toMatchObject({ topLevel: worktree, linkedWorktree: true, name: "agent-wt", mainName: basename(repo), head: { branch: "agent/branch" } });
    // An agent the deck never heard of reads the session's folder.
    expect((await read(q("/api/git/repo", { session: "S-repo", agent: "nobody" }))).body.repo.topLevel).toBe(repo);
  });

  it("says why there is no repository, for a plain folder and for one that has gone", async () => {
    expect((await read(q("/api/git/repo", { session: "S-plain" }))).body).toEqual({ ok: true, state: "not-a-repo", repo: null });
    expect((await read(q("/api/git/status", { session: "S-plain" }))).body).toEqual({ ok: true, state: "not-a-repo", repo: null });
    expect((await read(q("/api/git/repo", { session: "S-gone" }))).body).toEqual({ ok: true, state: "gone", repo: null });
  });

  it("is 400 without a session and 404 for one the deck never heard", async () => {
    for (const r of ROUTES) {
      expect((await read(r)).status, r).toBe(400);
      expect((await read(q(r, { session: "never-heard", path: "a.txt", sha: secondSha }))).status, r).toBe(404);
    }
  });
});

describe("the reads", () => {
  it("answers the history and the working tree", async () => {
    const log = await read(q("/api/git/log", { session: "S-repo" }));
    expect(log.body.ok).toBe(true);
    expect(log.body.commits.map((c: any) => c.sha)).toEqual([secondSha, firstSha]);
    const status = await read(q("/api/git/status", { session: "S-repo" }));
    expect(status.body.entries).toEqual([
      { path: "a.txt", area: "unstaged", change: "modified", added: 1, removed: 1, binary: false },
      { path: "new.txt", area: "untracked", change: "untracked", added: 1, removed: 0, binary: false },
    ]);
    expect(status.body.counts).toEqual({ staged: 0, unstaged: 1, untracked: 1, conflict: 0 });
  });

  it("answers a diff for a path git reported, in the area it reported it", async () => {
    const d = await read(q("/api/git/diff", { session: "S-repo", path: "a.txt", area: "unstaged" }));
    expect(d.status).toBe(200);
    expect(d.body.file).toEqual({ path: "a.txt", area: "unstaged", change: "modified" });
    expect(d.body.diff.patch).toContain("-two\n+three\n");
    const u = await read(q("/api/git/diff", { session: "S-repo", path: "new.txt", area: "untracked" }));
    expect(u.body.diff.patch).toContain("+fresh");
  });

  it("refuses any path git did not report, so a request cannot leave the repository", async () => {
    for (const path of ["keep.txt", "../outside.txt", "../../../../etc/passwd", "/etc/passwd", join(repo, "a.txt"), "a.txt/../keep.txt", ".git/config"]) {
      expect((await read(q("/api/git/diff", { session: "S-repo", path, area: "unstaged" }))).status, path).toBe(404);
    }
    expect((await read(q("/api/git/diff", { session: "S-repo", path: "a.txt", area: "staged" }))).status).toBe(404);
    expect((await read(q("/api/git/diff", { session: "S-repo", path: "a.txt", area: "elsewhere" }))).status).toBe(400);
    expect((await read(q("/api/git/diff", { session: "S-repo" }))).status).toBe(400);
  });

  it("answers a commit's files and one file's diff within it", async () => {
    const c = await read(q("/api/git/commit", { session: "S-repo", sha: secondSha.slice(0, 8) }));
    expect(c.body).toMatchObject({ ok: true, commit: { sha: secondSha, subject: "second" }, files: [{ path: "a.txt", change: "modified", added: 1, removed: 1 }] });
    const d = await read(q("/api/git/commit", { session: "S-repo", sha: secondSha, path: "a.txt" }));
    expect(d.body.diff.patch).toContain("-one\n+two\n");
    expect((await read(q("/api/git/commit", { session: "S-repo", sha: secondSha, path: "keep.txt" }))).status).toBe(404);
    expect((await read(q("/api/git/commit", { session: "S-repo", sha: "f".repeat(40) }))).status).toBe(404);
    for (const sha of ["HEAD", "main", "--output=x", "HEAD~1"]) {
      expect((await read(q("/api/git/commit", { session: "S-repo", sha }))).status, sha).toBe(400);
    }
  });
});
