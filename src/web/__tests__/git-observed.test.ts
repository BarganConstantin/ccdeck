// GitObserved, through the real server: a session is told its repository and
// branch once, again when a tool call that can change them finishes, and only
// the changes of identity reach the log. Real repositories; the "agent" here
// is the test posting the hook events an agent's calls would.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-observed-");
const LOG = join(DIR, "events.jsonl");
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
const { isEnrichment } = await import("../../server/ring-bounds.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { changesRepo } = await import("../../server/git-watch.mjs");

const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };
let server: Server;
let port = 0;

type Env = { seq: number; payload: any };

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", "x-ccdeck-token": hookToken() } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const event = (p: Record<string, unknown>) => call("POST", "/api/event", p);
const observed = async (sid: string, since = 0): Promise<Env[]> =>
  ((await call("GET", `/api/events?since=${since}`)).body as Env[]).filter(e => e.payload?.hook_event_name === "GitObserved" && e.payload.session_id === sid);
const lastSeq = async (): Promise<number> => {
  const all = (await call("GET", "/api/events?since=0")).body as Env[];
  return all.length ? all[all.length - 1].seq : 0;
};
/** Waits for the next GitObserved for `sid` after `since`, or fails. */
async function next(sid: string, since: number, test: (git: any) => boolean = () => true, ms = 6_000): Promise<Env> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = (await observed(sid, since)).find(e => test(e.payload.git));
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no GitObserved for ${sid} after ${since}`);
}
const loggedFor = (sid: string) => existsSync(LOG)
  ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l).payload)
    .filter((p: any) => p?.hook_event_name === "GitObserved" && p.session_id === sid)
  : [];

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: LOG, codex: false });
  port = (server.address() as AddressInfo).port;
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

describe("which calls can change a repository", () => {
  it("counts finished edits and commands, and every finished Codex call", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
      expect(changesRepo({ hook_event_name: "PostToolUse", tool_name: tool }), tool).toBe(true);
      expect(changesRepo({ hook_event_name: "PostToolUseFailure", tool_name: tool }), tool).toBe(true);
      expect(changesRepo({ hook_event_name: "PreToolUse", tool_name: tool }), tool).toBe(false);
    }
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "Task"]) expect(changesRepo({ hook_event_name: "PostToolUse", tool_name: tool }), tool).toBe(false);
    expect(changesRepo({ hook_event_name: "PostToolUse", provider: "codex" })).toBe(true);
  });

  it("files GitObserved with the last-value-wins enrichment the ring does not count", () => {
    expect(isEnrichment({ hook_event_name: "GitObserved" })).toBe(true);
  });
});

describe("GitObserved", () => {
  it("names a session's repository and branch on its first event", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-repo-"));
    const since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G1", cwd: dir });
    const e = await next("G1", since);
    expect(e.payload.provider).toBeUndefined();
    expect(e.payload.git).toEqual({
      state: "repo", topLevel: dir, name: dir.split(/[\\/]/).pop(), mainName: dir.split(/[\\/]/).pop(),
      folderName: dir.split(/[\\/]/).pop(), nameDiffers: false, linkedWorktree: false,
      branch: "main", detached: false, sha: sh(dir, ["rev-parse", "--short=7", "HEAD"]).trim(), unborn: false, empty: false, stale: 0,
    });
  });

  it("follows a checkout the session's command made, and keeps that change in the log", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-co-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G2", cwd: dir });
    await next("G2", since);
    since = await lastSeq();
    sh(dir, ["checkout", "-q", "-b", "feature/x"]);
    await event({ hook_event_name: "PostToolUse", session_id: "G2", cwd: dir, tool_name: "Bash", tool_input: { command: "git checkout -b feature/x" } });
    const e = await next("G2", since, g => g.branch === "feature/x");
    expect(e.payload.git.stale).toBe(1);
    // The log is appended without waiting, and a Windows runner takes its time.
    for (let i = 0; i < 100 && loggedFor("G2").length < 2; i++) await new Promise(r => setTimeout(r, 50));
    expect(loggedFor("G2").map((p: any) => p.git.branch)).toEqual(["main", "feature/x"]);
  });

  it("tells open pages an edit made the repository stale, without logging it", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-edit-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G3", cwd: dir });
    await next("G3", since);
    since = await lastSeq();
    write(dir, { "a.txt": "two\n" });
    await event({ hook_event_name: "PostToolUse", session_id: "G3", cwd: dir, tool_name: "Edit", tool_input: { file_path: join(dir, "a.txt") } });
    const e = await next("G3", since, g => g.stale === 1);
    expect(e.payload.git.branch).toBe("main");
    // A later event for the same session is in the log once this one is: the
    // first look's line is, and the stale mark's never arrives.
    await event({ hook_event_name: "Stop", session_id: "G3", cwd: dir });
    const stopLogged = () => existsSync(LOG) && readFileSync(LOG, "utf8").split("\n").some(l => l.includes('"Stop"') && l.includes('"G3"'));
    for (let i = 0; i < 100 && !stopLogged(); i++) await new Promise(r => setTimeout(r, 50));
    expect(stopLogged()).toBe(true);
    expect(loggedFor("G3").map((p: any) => p.git.stale)).toEqual([0]);
  });

  it("says nothing more for a call that cannot change the repository", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-read-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G4", cwd: dir });
    await next("G4", since);
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "G4", cwd: dir, tool_name: "Read" });
    await new Promise(r => setTimeout(r, 900));
    expect(await observed("G4", since)).toEqual([]);
  });

  it("names a detached HEAD by its short SHA", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-det-"));
    const sha = commitAll(dir, "two");
    sh(dir, ["checkout", "-q", "--detach", "HEAD~1"]);
    const plain = track(tempDir("ccdeck-git-observed-plain-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G5", cwd: dir });
    await event({ hook_event_name: "SessionStart", session_id: "G6", cwd: plain });
    const det = await next("G5", since);
    expect(det.payload.git).toMatchObject({ branch: null, detached: true, sha: sh(dir, ["rev-parse", "--short=7", "HEAD"]).trim() });
    expect(det.payload.git.sha).not.toBe(sha.slice(0, 7));
    // A folder that is not a repository costs the page no event at all…
    await new Promise(r => setTimeout(r, 700));
    expect(await observed("G6", since)).toEqual([]);
  });

  it("takes a branch back when the folder stops being a repository", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-gone-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G11", cwd: dir });
    await next("G11", since);
    since = await lastSeq();
    rmTempDir(join(dir, ".git"));
    await event({ hook_event_name: "PostToolUse", session_id: "G11", cwd: dir, tool_name: "Bash", tool_input: { command: "rm -rf .git" } });
    expect((await next("G11", since)).payload.git).toEqual({ state: "not-a-repo", stale: 0 });
  });

  it("tells a subagent working in its own worktree about that worktree", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-sub-"));
    const wt = join(track(tempDir("ccdeck-git-observed-subwt-")), "sub-wt");
    sh(dir, ["worktree", "add", "-q", "-b", "sub/branch", wt]);
    const since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G7", cwd: dir });
    await event({ hook_event_name: "PreToolUse", session_id: "G7", cwd: wt, agent_id: "ag-7", tool_name: "Read" });
    const sub = await next("G7", since, g => g.subagent === "ag-7");
    expect(sub.payload.git).toMatchObject({ subagent: "ag-7", topLevel: wt, branch: "sub/branch", linkedWorktree: true });
    // A subagent in its parent's folder gets nothing of its own.
    await event({ hook_event_name: "PreToolUse", session_id: "G7", cwd: dir, agent_id: "ag-8", tool_name: "Read" });
    await new Promise(r => setTimeout(r, 700));
    expect((await observed("G7", since)).filter(e => e.payload.git.subagent === "ag-8")).toEqual([]);
  });

  it("moves every session sharing the worktree when one of them checks out", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-share-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G8", cwd: dir });
    await event({ hook_event_name: "SessionStart", session_id: "G9", cwd: dir });
    await next("G8", since);
    await next("G9", since);
    since = await lastSeq();
    sh(dir, ["checkout", "-q", "-b", "shared-move"]);
    await event({ hook_event_name: "PostToolUse", session_id: "G8", cwd: dir, tool_name: "Bash" });
    await next("G8", since, g => g.branch === "shared-move");
    await next("G9", since, g => g.branch === "shared-move");
  });

  it("is marked as Codex's for a Codex session, whose every finished call counts", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-codex-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "GX", cwd: dir, provider: "codex" });
    expect((await next("GX", since)).payload.provider).toBe("codex");
    since = await lastSeq();
    sh(dir, ["checkout", "-q", "-b", "codex-branch"]);
    await event({ hook_event_name: "PostToolUse", session_id: "GX", cwd: dir, provider: "codex", tool_use_id: "c1" });
    expect((await next("GX", since, g => g.branch === "codex-branch")).payload.provider).toBe("codex");
  });

  it("sends it again after the page forgets the session", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-forget-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G10", cwd: dir });
    await next("G10", since);
    expect((await call("POST", "/api/forget", { ids: ["G10"] })).status).toBe(200);
    since = await lastSeq();
    await event({ hook_event_name: "UserPromptSubmit", session_id: "G10", cwd: dir, prompt: "again" });
    expect((await next("G10", since)).payload.git.branch).toBe("main");
  });
});
