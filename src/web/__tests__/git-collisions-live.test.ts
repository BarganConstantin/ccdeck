// GitCollisions, through the real server: two live agents in one working tree
// get a quiet mark, the same uncommitted file edited by both a sharp one, and
// both clear by themselves — the file committed, a session ending or let go,
// a subagent stopping, the git view switched off. A session never collides
// with its own subagent, and two worktrees on different branches never at all.
// Never logged: a restarted deck works it out afresh.
//
// Real repositories; the agents are the test posting the hook events their
// edits and commands would.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-collisions-");
const LOG = join(DIR, "events.jsonl");
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");

// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { isEnrichment } = await import("../../server/ring-bounds.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { refreshCollisions, setCollisionClock, STALE_SESSION_MS } = await import("../../server/git-collisions.mjs");

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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const all = async (): Promise<Env[]> => (await call("GET", "/api/events?since=0")).body;
const lastSeq = async () => { const a = await all(); return a.length ? a[a.length - 1].seq : 0; };
const collisionsOf = async (sid: string, since = 0) =>
  (await all()).filter(e => e.seq > since && e.payload?.hook_event_name === "GitCollisions" && e.payload.session_id === sid);
/** The newest GitCollisions for `sid` after `since` that passes `test`. */
async function next(sid: string, since: number, test: (c: any) => boolean = () => true, ms = 8_000): Promise<any> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const got = await collisionsOf(sid, since);
    const last = got[got.length - 1];
    if (last && test(last.payload.collisions)) return last.payload.collisions;
    await sleep(50);
  }
  throw new Error(`no matching GitCollisions for ${sid} after ${since}: ${JSON.stringify((await collisionsOf(sid, since)).map(e => e.payload.collisions))}`);
}
let n = 0;
const edit = (sid: string, cwd: string, file: string, extra: Record<string, unknown> = {}, tool = "Edit") => {
  write(cwd, { [file]: `${sid} ${++n}\n` });
  return event({ hook_event_name: "PostToolUse", session_id: sid, cwd, tool_name: tool, tool_input: { file_path: join(cwd, file) }, tool_response: { success: true }, tool_use_id: `toolu_c${n}`, ...extra });
};
const start = (sid: string, cwd: string) => event({ hook_event_name: "SessionStart", session_id: sid, cwd });
const empty = (c: any) => c.quiet.length === 0 && c.sharp.length === 0;

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: LOG, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  setCollisionClock(null);
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

describe("GitCollisions", () => {
  it("is last-value-wins enrichment the ring does not count", () => {
    expect(isEnrichment({ hook_event_name: "GitCollisions" })).toBe(true);
  });

  it("marks two sessions in one working tree quietly, and sharply once both edit one uncommitted file", async () => {
    const repo = track(repoWith({ "src/app.ts": "app\n", "src/mine.ts": "mine\n" }, "ccdeck-collide-web-"));
    let since = await lastSeq();
    await start("W-ui", repo);
    await start("W-fix", repo);
    const quiet = { quiet: [expect.objectContaining({ reason: "same-worktree", branch: "main" })], sharp: [] };
    expect(await next("W-ui", since, c => c.quiet.length === 1)).toEqual({
      quiet: [{ agentId: null, with: { sessionId: "W-fix", agentId: null }, reason: "same-worktree", branch: "main" }], sharp: [],
    });
    expect(await next("W-fix", since, c => c.quiet.length === 1)).toMatchObject(quiet);

    since = await lastSeq();
    await edit("W-ui", repo, "src/app.ts");
    await edit("W-ui", repo, "src/mine.ts");
    await edit("W-fix", repo, "src/app.ts", {}, "MultiEdit");
    const sharp = await next("W-ui", since, c => c.sharp.length === 1);
    expect(sharp.sharp).toEqual([{ agentId: null, with: { sessionId: "W-fix", agentId: null }, files: ["src/app.ts"] }]);
    expect(sharp.quiet).toHaveLength(1);
    expect((await next("W-fix", since, c => c.sharp.length === 1)).sharp[0]).toMatchObject({ with: { sessionId: "W-ui" }, files: ["src/app.ts"] });

    // Committed: no longer sharp, still in one folder.
    since = await lastSeq();
    sh(repo, ["add", "src/app.ts"]);
    sh(repo, ["commit", "-q", "-m", "fix: app"]);
    await event({ hook_event_name: "PostToolUse", session_id: "W-fix", cwd: repo, tool_name: "Bash", tool_input: { command: "git commit -m 'fix: app' -- src/app.ts" }, tool_response: { stdout: "" }, tool_use_id: "toolu_wfix_commit" });
    expect(await next("W-ui", since, c => c.sharp.length === 0)).toMatchObject({ quiet: [expect.objectContaining({ with: { sessionId: "W-fix", agentId: null } })], sharp: [] });

    // One session ends: both are told there is nobody left.
    since = await lastSeq();
    await event({ hook_event_name: "SessionEnd", session_id: "W-fix", cwd: repo, reason: "exit" });
    expect(await next("W-ui", since, empty)).toEqual({ quiet: [], sharp: [] });
    expect(await next("W-fix", since, empty)).toEqual({ quiet: [], sharp: [] });
  });

  it("does not mark a file the other agent committed before this one edited it, until both edit it again", async () => {
    const repo = track(repoWith({ "src/app.ts": "app\n" }, "ccdeck-collide-after-"));
    let since = await lastSeq();
    await start("A1", repo);
    await start("A2", repo);
    await next("A1", since, c => c.quiet.length === 1);
    await edit("A1", repo, "src/app.ts");
    sh(repo, ["add", "src/app.ts"]);
    sh(repo, ["commit", "-q", "-m", "feat: app"], undefined, new Date().toISOString());
    await event({ hook_event_name: "PostToolUse", session_id: "A1", cwd: repo, tool_name: "Bash", tool_input: { command: "git commit -am 'feat: app'" }, tool_response: { stdout: "" }, tool_use_id: "toolu_a1_commit" });
    // Commit times are whole seconds: the next edits come after that one.
    await sleep(1_100);
    since = await lastSeq();
    await edit("A2", repo, "src/app.ts");
    await sleep(1_200);
    expect((await collisionsOf("A1", since)).filter(e => e.payload.collisions.sharp.length)).toEqual([]);
    await edit("A1", repo, "src/app.ts");
    expect((await next("A1", since, c => c.sharp.length === 1)).sharp).toEqual([{ agentId: null, with: { sessionId: "A2", agentId: null }, files: ["src/app.ts"] }]);
  });

  it("never pairs a session with its own subagent, and pairs two of its running subagents until one stops", async () => {
    const repo = track(repoWith({ "src/session.ts": "s\n" }, "ccdeck-collide-team-"));
    const since = await lastSeq();
    await start("T", repo);
    await event({ hook_event_name: "SubagentStart", session_id: "T", cwd: repo, agent_id: "ag-a", agent_type: "test-writer" });
    await edit("T", repo, "src/session.ts");
    await edit("T", repo, "src/session.ts", { agent_id: "ag-a", agent_type: "test-writer" });
    await sleep(1_200);
    expect(await collisionsOf("T", since)).toEqual([]);

    const since2 = await lastSeq();
    await event({ hook_event_name: "SubagentStart", session_id: "T", cwd: repo, agent_id: "ag-b", agent_type: "refactorer" });
    await edit("T", repo, "src/session.ts", { agent_id: "ag-b", agent_type: "refactorer" });
    expect(await next("T", since2, c => c.sharp.length === 2)).toEqual({
      quiet: [],
      sharp: [
        { agentId: "ag-b", with: { sessionId: "T", agentId: "ag-a" }, files: ["src/session.ts"] },
        { agentId: "ag-a", with: { sessionId: "T", agentId: "ag-b" }, files: ["src/session.ts"] },
      ],
    });

    // ag-a finishes: its work is the session's, which ag-b was handed.
    const since3 = await lastSeq();
    await event({ hook_event_name: "SubagentStop", session_id: "T", cwd: repo, agent_id: "ag-a", agent_type: "test-writer" });
    expect(await next("T", since3, empty)).toEqual({ quiet: [], sharp: [] });
  });

  it("never marks two worktrees on different branches, and marks a subagent working in another session's worktree", async () => {
    const repo = track(repoWith({ "a.txt": "a\n" }, "ccdeck-collide-wt-"));
    const wt = join(track(tempDir("ccdeck-collide-wt2-")), "other");
    sh(repo, ["worktree", "add", "-q", "-b", "other", wt]);
    const since = await lastSeq();
    await start("D-main", repo);
    await start("D-other", wt);
    await sleep(1_200);
    expect(await collisionsOf("D-main", since)).toEqual([]);
    expect(await collisionsOf("D-other", since)).toEqual([]);

    await event({ hook_event_name: "SubagentStart", session_id: "D-main", cwd: wt, agent_id: "ag-w", agent_type: "porter" });
    expect(await next("D-main", since, c => c.quiet.length === 1)).toEqual({
      quiet: [{ agentId: "ag-w", with: { sessionId: "D-other", agentId: null }, reason: "same-worktree", branch: "other" }], sharp: [],
    });
    expect(await next("D-other", since, c => c.quiet.length === 1)).toEqual({
      quiet: [{ agentId: null, with: { sessionId: "D-main", agentId: "ag-w" }, reason: "same-worktree", branch: "other" }], sharp: [],
    });
  });

  it("keeps a file sharp in the worktree an agent left uncommitted, after it is followed into another", async () => {
    const repo = track(repoWith({ "a.txt": "a\n" }, "ccdeck-collide-left-"));
    const wt = join(track(tempDir("ccdeck-collide-leftwt-")), "side");
    sh(repo, ["worktree", "add", "-q", "-b", "side", wt]);
    let since = await lastSeq();
    await start("L-x", repo);
    await start("L-y", repo);
    await edit("L-x", repo, "a.txt");
    await edit("L-y", repo, "a.txt");
    await next("L-x", since, c => c.sharp.length === 1);
    // L-x looks at the other worktree once: the reads follow it there, while
    // both edits still sit uncommitted in the first one.
    since = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "L-x", cwd: repo, tool_name: "Bash", tool_input: { command: `cd '${wt}' && git status` }, tool_response: { stdout: "" }, tool_use_id: "toolu_lx_cd" });
    expect(await next("L-y", since, c => c.quiet.length === 0)).toEqual({
      quiet: [], sharp: [{ agentId: null, with: { sessionId: "L-x", agentId: null }, files: ["a.txt"] }],
    });
    expect((await next("L-x", since, c => c.quiet.length === 0)).sharp).toEqual([{ agentId: null, with: { sessionId: "L-y", agentId: null }, files: ["a.txt"] }]);
  });

  it("clears for a session the page let go of, and when the git view is switched off", async () => {
    const repo = track(repoWith({ "a.txt": "a\n" }, "ccdeck-collide-forget-"));
    let since = await lastSeq();
    await start("F1", repo);
    await start("F2", repo);
    await next("F1", since, c => c.quiet.length === 1);
    since = await lastSeq();
    expect((await call("POST", "/api/forget", { ids: ["F2"] })).status).toBe(200);
    expect(await next("F1", since, empty)).toEqual({ quiet: [], sharp: [] });

    await start("F3", repo);
    await next("F1", since, c => c.quiet.length === 1);
    since = await lastSeq();
    expect((await call("POST", "/api/prefs", { git: false })).body.prefs.git).toBe(false);
    try {
      expect(await next("F1", since, empty)).toEqual({ quiet: [], sharp: [] });
      expect(await next("F3", since, empty)).toEqual({ quiet: [], sharp: [] });
      const quietSince = await lastSeq();
      await edit("F3", repo, "a.txt");
      await sleep(900);
      expect(await collisionsOf("F1", quietSince)).toEqual([]);
    } finally {
      expect((await call("POST", "/api/prefs", { git: true })).body.prefs.git).toBe(true);
    }
    expect(await next("F1", since, c => c.quiet.length === 1)).toMatchObject({ quiet: [{ with: { sessionId: "F3" } }] });
  });

  it("clears once the sessions have been silent as long as the board allows", async () => {
    const repo = track(repoWith({ "a.txt": "a\n" }, "ccdeck-collide-stale-"));
    const since = await lastSeq();
    await start("Q1", repo);
    await start("Q2", repo);
    await next("Q1", since, c => c.quiet.some((q: any) => q.with.sessionId === "Q2"));
    const later = await lastSeq();
    setCollisionClock(() => Date.now() + STALE_SESSION_MS + 60_000);
    try {
      refreshCollisions();
      expect(await next("Q1", later, empty)).toEqual({ quiet: [], sharp: [] });
    } finally {
      setCollisionClock(null);
    }
  });

  it("is never written to the log", async () => {
    await sleep(100);
    const lines = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
    expect(lines).toContain("SessionStart");
    expect(lines).not.toContain("GitCollisions");
  });
});
