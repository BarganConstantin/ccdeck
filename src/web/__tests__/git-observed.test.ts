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
const { changesRepo, noteGitEvent } = await import("../../server/git-watch.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { noteSessionFolder, sessionFolder } = await import("../../server/git-sessions.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { staleCount } = await import("../../server/git-state.mjs");

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
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"]) {
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

  it("tells a session sharing the worktree that another session's edit changed it", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-pair-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G12", cwd: dir });
    await event({ hook_event_name: "SessionStart", session_id: "G13", cwd: dir });
    await next("G12", since);
    await next("G13", since);
    since = await lastSeq();
    write(dir, { "a.txt": "two\n" });
    await event({ hook_event_name: "PostToolUse", session_id: "G12", cwd: dir, tool_name: "Edit", tool_input: { file_path: join(dir, "a.txt") } });
    expect((await next("G13", since, g => g.stale === 1)).payload.git.branch).toBe("main");
  });

  it("tells a session in a sibling worktree that a commit in another changed the history", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-sib-"));
    const wt = join(track(tempDir("ccdeck-git-observed-sibwt-")), "side");
    sh(dir, ["worktree", "add", "-q", "-b", "side", wt]);
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G14", cwd: dir });
    await event({ hook_event_name: "SessionStart", session_id: "G15", cwd: wt });
    await next("G14", since);
    await next("G15", since);
    since = await lastSeq();
    write(wt, { "b.txt": "side\n" });
    commitAll(wt, "on the side");
    await event({ hook_event_name: "PostToolUse", session_id: "G15", cwd: wt, tool_name: "Bash", tool_input: { command: "git commit -am 'on the side'" } });
    const seen = await next("G14", since, g => g.stale >= 1);
    expect(seen.payload.git).toMatchObject({ topLevel: dir, branch: "main" });
  });

  it("marks only the worktree an edit was made in, so a subagent working elsewhere is not told again", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-narrow-"));
    const wt = join(track(tempDir("ccdeck-git-observed-narrowwt-")), "sub");
    sh(dir, ["worktree", "add", "-q", "-b", "sub/narrow", wt]);
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G16", cwd: dir });
    await event({ hook_event_name: "PreToolUse", session_id: "G16", cwd: wt, agent_id: "ag-16", tool_name: "Read" });
    await next("G16", since, g => !g.subagent);
    await next("G16", since, g => g.subagent === "ag-16");
    since = await lastSeq();
    write(dir, { "a.txt": "two\n" });
    await event({ hook_event_name: "PostToolUse", session_id: "G16", cwd: dir, tool_name: "Write", tool_input: { file_path: join(dir, "a.txt") } });
    expect(staleCount(dir)).toBe(1);
    expect(staleCount(wt)).toBe(0);
    await next("G16", since, g => !g.subagent && g.stale === 1);
    expect((await observed("G16", since)).filter(e => e.payload.git.subagent === "ag-16")).toEqual([]);
  });

  it("marks the repository a command names, and tells the sessions working there", async () => {
    const here = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-observed-here-"));
    const there = track(repoWith({ "b.txt": "one\n" }, "ccdeck-git-observed-there-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "G17", cwd: here });
    await event({ hook_event_name: "SessionStart", session_id: "G18", cwd: there });
    await next("G17", since);
    await next("G18", since);
    since = await lastSeq();
    write(there, { "b.txt": "two\n" });
    commitAll(there, "from elsewhere");
    await event({ hook_event_name: "PostToolUse", session_id: "G17", cwd: here, tool_name: "Bash", tool_input: { command: `git -C '${there}' commit -am 'from elsewhere'` } });
    expect(staleCount(there)).toBe(1);
    await next("G18", since, g => g.stale === 1);
    // And an edit through an absolute path into it.
    since = await lastSeq();
    write(there, { "b.txt": "three\n" });
    await event({ hook_event_name: "PostToolUse", session_id: "G17", cwd: here, tool_name: "Edit", tool_input: { file_path: join(there, "b.txt") } });
    expect(staleCount(there)).toBe(2);
    await next("G18", since, g => g.stale === 2);
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

describe("the worktree a session works in", () => {
  /** A repository with a linked worktree on its own branch. */
  function repoAndWorktree(name: string) {
    const dir = track(repoWith({ "a.txt": "one\n" }, `ccdeck-git-follow-${name}-`));
    const wt = join(track(tempDir(`ccdeck-git-follow-${name}wt-`)), "wt");
    sh(dir, ["worktree", "add", "-q", "-b", `wt/${name}`, wt]);
    return { dir, wt };
  }
  const repoTop = async (sid: string, agent?: string) =>
    (await call("GET", `/api/git/repo?session=${sid}${agent ? `&agent=${agent}` : ""}`)).body?.repo?.topLevel;

  it("follows a session whose command moves into another worktree, and back", async () => {
    const { dir, wt } = repoAndWorktree("cd");
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "F1", cwd: dir });
    await next("F1", since);
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "F1", cwd: dir, tool_name: "Bash", tool_input: { command: `cd '${wt}' && git status` } });
    const moved = await next("F1", since, g => g.topLevel === wt);
    expect(moved.payload.git).toMatchObject({ branch: "wt/cd", linkedWorktree: true });
    expect(await repoTop("F1")).toBe(wt);
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "F1", cwd: dir, tool_name: "Bash", tool_input: { command: `git -C '${dir}' log -1` } });
    await next("F1", since, g => g.topLevel === dir);
    expect(await repoTop("F1")).toBe(dir);
    for (let i = 0; i < 100 && loggedFor("F1").length < 3; i++) await new Promise(r => setTimeout(r, 50));
    expect(loggedFor("F1").map((p: any) => p.git.branch)).toEqual(["main", "wt/cd", "main"]);
  });

  it("follows a session whose own folder changes to a worktree", async () => {
    const { dir, wt } = repoAndWorktree("enter");
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "F2", cwd: dir });
    await next("F2", since);
    since = await lastSeq();
    await event({ hook_event_name: "UserPromptSubmit", session_id: "F2", cwd: wt, prompt: "go on" });
    expect((await next("F2", since, g => g.topLevel === wt)).payload.git.branch).toBe("wt/enter");
  });

  it("follows edits to another worktree only from the second call in a row", async () => {
    const { dir, wt } = repoAndWorktree("edit");
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "F3", cwd: dir });
    await next("F3", since);
    since = await lastSeq();
    const edit = (file: string) => event({ hook_event_name: "PostToolUse", session_id: "F3", cwd: dir, tool_name: "Write", tool_input: { file_path: file } });
    write(wt, { "b.txt": "one\n" });
    await edit(join(wt, "b.txt"));
    // An edit back home ends the count.
    await edit(join(dir, "a.txt"));
    await edit(join(wt, "b.txt"));
    await new Promise(r => setTimeout(r, 900));
    expect((await observed("F3", since)).filter(e => e.payload.git.topLevel === wt)).toEqual([]);
    expect(await repoTop("F3")).toBe(dir);
    await edit(join(wt, "b.txt"));
    await next("F3", since, g => g.topLevel === wt);
    expect(await repoTop("F3")).toBe(wt);
  });

  it("stays put for a folder outside every repository", async () => {
    const { dir } = repoAndWorktree("plain");
    const plain = track(tempDir("ccdeck-git-follow-plain-"));
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "F4", cwd: dir });
    await next("F4", since);
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "F4", cwd: dir, tool_name: "Bash", tool_input: { command: `cd '${plain}' && ls` } });
    await new Promise(r => setTimeout(r, 900));
    // The command still marks its repository stale; it takes the session nowhere.
    expect((await observed("F4", since)).filter(e => e.payload.git.topLevel !== dir)).toEqual([]);
    expect(await repoTop("F4")).toBe(dir);
  });

  it("takes along a subagent started in the session's folder, and lets one that moved itself go its own way", async () => {
    const { dir, wt } = repoAndWorktree("team");
    const own = join(track(tempDir("ccdeck-git-follow-teamown-")), "own");
    sh(dir, ["worktree", "add", "-q", "-b", "wt/own", own]);
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "F5", cwd: dir });
    await event({ hook_event_name: "PreToolUse", session_id: "F5", cwd: dir, agent_id: "fa-1", tool_name: "Read" });
    await event({ hook_event_name: "PreToolUse", session_id: "F5", cwd: dir, agent_id: "fa-2", tool_name: "Read" });
    await next("F5", since);
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "F5", cwd: dir, tool_name: "Bash", tool_input: { command: `cd '${wt}'` } });
    await next("F5", since, g => !g.subagent && g.topLevel === wt);
    expect(await repoTop("F5", "fa-1")).toBe(wt);
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "F5", cwd: dir, agent_id: "fa-2", tool_name: "Bash", tool_input: { command: `cd '${own}' && git status` } });
    expect((await next("F5", since, g => g.subagent === "fa-2")).payload.git).toMatchObject({ topLevel: own, branch: "wt/own" });
    expect(await repoTop("F5", "fa-1")).toBe(wt);
    expect(await repoTop("F5")).toBe(wt);
  });

  it("follows a folder change made while git was switched off, once it is on again", async () => {
    const { dir, wt } = repoAndWorktree("off");
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "F7", cwd: dir });
    await next("F7", since);
    expect((await call("POST", "/api/prefs", { git: false })).body.prefs.git).toBe(false);
    try {
      await event({ hook_event_name: "UserPromptSubmit", session_id: "F7", cwd: wt, prompt: "go on" });
    } finally {
      expect((await call("POST", "/api/prefs", { git: true })).body.prefs.git).toBe(true);
    }
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "F7", cwd: wt, tool_name: "Bash", tool_input: { command: "npm test" } });
    await next("F7", since, g => g.topLevel === wt);
    expect(await repoTop("F7")).toBe(wt);
  });

  it("follows a folder change made after the page let the session go", async () => {
    const { dir, wt } = repoAndWorktree("forgot");
    let since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "F8", cwd: dir });
    await next("F8", since);
    await event({ hook_event_name: "UserPromptSubmit", session_id: "F8", cwd: dir, prompt: "one" });
    expect((await call("POST", "/api/forget", { ids: ["F8"] })).status).toBe(200);
    since = await lastSeq();
    await event({ hook_event_name: "UserPromptSubmit", session_id: "F8", cwd: wt, prompt: "two" });
    await next("F8", since, g => g.topLevel === wt);
    expect(await repoTop("F8")).toBe(wt);
  });

  it("puts a restarted deck's session back in the worktree its last GitObserved named", () => {
    const { dir, wt } = repoAndWorktree("replay");
    noteSessionFolder({ session_id: "F6", cwd: dir, hook_event_name: "SessionStart" });
    noteGitEvent({ hook_event_name: "GitObserved", session_id: "F6", git: { state: "repo", topLevel: wt, branch: "wt/replay" } }, { replay: true, seq: 1, at: 1 });
    expect(sessionFolder("F6")).toMatchObject({ cwd: wt, start: dir });
    // Its own folder's worktree again: nothing followed any more.
    noteGitEvent({ hook_event_name: "GitObserved", session_id: "F6", git: { state: "repo", topLevel: dir, branch: "main" } }, { replay: true, seq: 2, at: 2 });
    expect(sessionFolder("F6")).toMatchObject({ cwd: dir, start: dir });
  });
});
