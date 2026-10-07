// GitRecentCommits, through the real server: the commits a session's agents
// were seen making in the last half hour, told to the page for the lane under
// its card. Each commit an agent makes sends its session's lane again, newest
// first, a subagent's carrying its id and type; the event is last-value-wins
// enrichment, never logged, handed again to a page that connects behind the
// ring, rebuilt from the commit store after a restart for what is still inside
// the window, and taken back when the git view is switched off.
//
// Real repositories; the "agent" is the test posting the hook events an
// agent's `git commit` would, with the output git really printed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, realpathSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-recent-");
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
const { agentGit, createAgentGitTap } = await import("../../server/agent-git-tap.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createCommitStore } = await import("../../server/agent-git-store.mjs");
const {
  RECENT_COMMITS_MAX, RECENT_COMMITS_MS, laneOf, recentCommitsBehind, refreshRecentCommits, clearRecentCommits, setRecentCommitsClock,
// @ts-expect-error — plain .mjs server module, no types
} = await import("../../server/git-recent-commits.mjs");
import { BAND_WINDOW_MS } from "../git-commit-band";

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
const lanesOf = async (sid: string, since = 0) =>
  (await all()).filter(e => e.seq > since && e.payload?.hook_event_name === "GitRecentCommits" && e.payload.session_id === sid);
/** The newest GitRecentCommits for `sid` after `since` that passes `test`. */
async function next(sid: string, since: number, test: (p: any) => boolean = () => true, ms = 8_000): Promise<Env> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const got = await lanesOf(sid, since);
    const last = got[got.length - 1];
    if (last && test(last.payload)) return last;
    await sleep(50);
  }
  throw new Error(`no matching GitRecentCommits for ${sid} after ${since}: ${JSON.stringify((await lanesOf(sid, since)).map(e => e.payload))}`);
}

/** Commit in `dir` the way an agent's Bash call would, and post that call. */
async function agentCommits(sid: string, dir: string, file: string, subject: string, extra: Record<string, unknown> = {}) {
  write(dir, { [file]: `${subject}\n` });
  sh(dir, ["add", file]);
  const stdout = sh(dir, ["commit", "-m", subject]);
  const command = `git add ${file} && git commit -m "${subject}"`;
  const id = `toolu_${subject.replace(/\W/g, "")}`;
  await event({ hook_event_name: "PreToolUse", session_id: sid, cwd: dir, tool_name: "Bash", tool_input: { command }, tool_use_id: id, ...extra });
  await event({ hook_event_name: "PostToolUse", session_id: sid, cwd: dir, tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false }, tool_use_id: id, ...extra });
  await agentGit.settled();
  return sh(dir, ["rev-parse", "HEAD"]).trim();
}

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: LOG, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  setRecentCommitsClock(null);
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

describe("GitRecentCommits", () => {
  it("is last-value-wins enrichment the ring does not count, on the page's own half hour", () => {
    expect(isEnrichment({ hook_event_name: "GitRecentCommits" })).toBe(true);
    expect(RECENT_COMMITS_MS).toBe(30 * 60_000);
    expect(BAND_WINDOW_MS).toBe(RECENT_COMMITS_MS);
  });

  it("tells the page each commit an agent makes: newest first, the real SHA, a subagent's with its id and type", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-recent-team-"));
    const since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "RC1", cwd: dir });
    const before = Date.now();
    const first = await agentCommits("RC1", dir, "b.txt", "feat(api): add the second file");
    const one = await next("RC1", since, p => p.commits.length === 1);
    expect(one.payload).toEqual({
      hook_event_name: "GitRecentCommits", session_id: "RC1", repo: realpathSync(join(dir, ".git")),
      commits: [{ sha: first, short: first.slice(0, 7), subject: "feat(api): add the second file", at: expect.any(Number), agentId: null, label: null, branch: "main", repo: realpathSync(join(dir, ".git")) }],
    });
    expect(one.payload.commits[0].at).toBeGreaterThanOrEqual(before - 1000);

    await event({ hook_event_name: "SubagentStart", session_id: "RC1", cwd: dir, agent_id: "ag-9", agent_type: "test-writer" });
    const second = await agentCommits("RC1", dir, "t.txt", "test(api): cover the second file", { agent_id: "ag-9", agent_type: "test-writer" });
    const two = await next("RC1", one.seq, p => p.commits.length === 2);
    expect(two.payload.commits.map((c: any) => [c.sha, c.agentId, c.label])).toEqual([[second, "ag-9", "test-writer"], [first, null, null]]);
    // Nothing about the commit beyond what the lane draws, and the repository
    // it is in, which says whether the card's view can open it: no folder, no spend.
    expect(Object.keys(two.payload.commits[0]).sort()).toEqual(["agentId", "at", "branch", "label", "repo", "sha", "short", "subject"]);
  });

  it("names each commit's repository, and the lane's as the one the session works in now", async () => {
    const a = track(repoWith({ "a.txt": "one\n" }, "ccdeck-recent-hopa-"));
    const b = track(repoWith({ "b.txt": "one\n" }, "ccdeck-recent-hopb-"));
    const since = await lastSeq();
    await event({ hook_event_name: "SessionStart", session_id: "RC-hop", cwd: a });
    const inA = await agentCommits("RC-hop", a, "c.txt", "feat: first in repo a");
    await next("RC-hop", since, p => p.commits.length === 1);
    // `cd b && git commit`: the session is followed to b, and its lane says so.
    write(b, { "d.txt": "two\n" });
    sh(b, ["add", "d.txt"]);
    const stdout = sh(b, ["commit", "-m", "feat: second in repo b"]);
    const command = `cd '${b}' && git add d.txt && git commit -m "feat: second in repo b"`;
    await event({ hook_event_name: "PreToolUse", session_id: "RC-hop", cwd: a, tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_hop_b" });
    await event({ hook_event_name: "PostToolUse", session_id: "RC-hop", cwd: a, tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false }, tool_use_id: "toolu_hop_b" });
    await agentGit.settled();
    const inB = sh(b, ["rev-parse", "HEAD"]).trim();
    const lane = await next("RC-hop", since, p => p.commits.length === 2 && p.repo === realpathSync(join(b, ".git")));
    expect(lane.payload.commits.map((c: any) => [c.sha, c.repo])).toEqual([[inB, realpathSync(join(b, ".git"))], [inA, realpathSync(join(a, ".git"))]]);
    // Followed back to a with no commit: the lane is read against a again.
    const back = await lastSeq();
    await event({ hook_event_name: "PostToolUse", session_id: "RC-hop", cwd: a, tool_name: "Bash", tool_input: { command: `cd '${a}' && git status` }, tool_response: { stdout: "" }, tool_use_id: "toolu_hop_back" });
    expect((await next("RC-hop", back)).payload.repo).toBe(realpathSync(join(a, ".git")));
  });

  it("is never written to the events log: a restarted deck works it out from the commit store", async () => {
    await sleep(200);
    expect(readFileSync(LOG, "utf8")).not.toContain("GitRecentCommits");
  });

  it("rebuilds every lane from the commit store after a restart, only with the commits still inside the window", async () => {
    const now = Date.now();
    const line = (sha: string, at: number, extra: Record<string, unknown> = {}) => ({
      v: 1, repo: "/r/.git", top: "/r", sha, shaFull: true, subject: `subject ${sha.slice(0, 4)}`, authorTime: at, branch: "develop", detached: false,
      sessionId: "RC-old", agentId: null, label: null, agentType: null, model: null, kind: "claude", at, cwd: "/r", cost: null,
      durationMs: null, durationFrom: null, confidence: "seen", amend: false, subcommand: "commit", ...extra,
    });
    await agentGit.store.append(line("a".repeat(40), now - RECENT_COMMITS_MS - 60_000));
    await agentGit.store.append(line("b".repeat(40), now - RECENT_COMMITS_MS + 60_000));
    await agentGit.store.append(line("c".repeat(40), now - 2 * RECENT_COMMITS_MS, { sessionId: "RC-gone" }));
    // What a restart forgets — every lane it had sent — and what it does once
    // the replay is back.
    clearRecentCommits();
    const since = await lastSeq();
    refreshRecentCommits();
    const lane = await next("RC-old", since);
    expect(lane.payload.commits.map((c: any) => c.sha)).toEqual(["b".repeat(40)]);
    expect(lane.payload.repo).toBe("/r/.git");
    await sleep(300);
    // A session whose commits are all past the window gets no lane at all.
    expect(await lanesOf("RC-gone", since)).toEqual([]);
    // RC1, whose commits are recent, is sent again from the store.
    expect((await lanesOf("RC1", since)).at(-1)?.payload.commits).toHaveLength(2);
  });

  it("hands a page behind the ring the last lane of each card it will draw, still inside the window", async () => {
    const sent = (await lanesOf("RC1")).at(-1)!;
    const range = (over: Partial<{ after: number; before: number; sessions: Set<string> }> = {}) =>
      recentCommitsBehind({ after: 0, before: Number.MAX_SAFE_INTEGER, sessions: new Set(["RC1"]), ...over });
    expect(range()).toEqual([{ seq: sent.seq, receivedAt: expect.any(Number), payload: sent.payload }]);
    // Not for a card the page will not draw, nor one it has been sent already.
    expect(range({ sessions: new Set(["someone-else"]) })).toEqual([]);
    expect(range({ after: sent.seq })).toEqual([]);
    // Nor one the ring still holds: the replay itself hands that over.
    expect(range({ before: sent.seq })).toEqual([]);
    // Half an hour on, the commits have left the lane, and a fresh page is
    // handed nothing; a page that drew them is handed the empty lane.
    setRecentCommitsClock(() => Date.now() + RECENT_COMMITS_MS + 60_000);
    try {
      expect(range()).toEqual([]);
      expect(range({ after: 1 })[0]?.payload.commits).toEqual([]);
    } finally {
      setRecentCommitsClock(null);
    }
  });

  it("takes every lane back when the git view is switched off, and sends them again when it is on", async () => {
    let since = await lastSeq();
    expect((await call("POST", "/api/prefs", { git: false })).body.prefs.git).toBe(false);
    try {
      expect((await next("RC1", since, p => p.commits.length === 0)).payload.commits).toEqual([]);
      // Nothing behind the ring for a lane taken back, and nothing at all while off.
      expect(recentCommitsBehind({ after: 0, before: Number.MAX_SAFE_INTEGER, sessions: new Set(["RC1"]) })).toEqual([]);
    } finally {
      since = await lastSeq();
      expect((await call("POST", "/api/prefs", { git: true })).body.prefs.git).toBe(true);
    }
    expect((await next("RC1", since, p => p.commits.length === 2)).payload.commits).toHaveLength(2);
  });
});

describe("a session's lane", () => {
  const line = (n: number, extra: Record<string, unknown> = {}) => ({
    sha: n.toString(16).padStart(40, "0"), repo: "/r/.git", branch: "main", at: 1_000 + n, subject: `s${n}`, agentId: null, label: null, amend: false, ...extra,
  });

  it("is newest first and at most RECENT_COMMITS_MAX long, with the repository of the newest", () => {
    const lane = laneOf(Array.from({ length: 30 }, (_, i) => line(i + 1)));
    expect(RECENT_COMMITS_MAX).toBe(24);
    expect(lane.commits).toHaveLength(24);
    expect(lane.commits[0].subject).toBe("s30");
    expect(lane.commits.at(-1).subject).toBe("s7");
    expect(lane.repo).toBe("/r/.git");
    expect(laneOf([])).toEqual({ repo: null, commits: [] });
  });

  it("puts an amend in the place of the commit it amended, on the same branch only", () => {
    const lane = laneOf([line(1), line(2, { branch: "other" }), line(3, { amend: true, subject: "s1 amended" })]);
    expect(lane.commits.map((c: any) => c.subject)).toEqual(["s1 amended", "s2"]);
  });
});

describe("the tap", () => {
  it("tells a listener of each line it records, and of a commit another deck records", async () => {
    const dir = track(tempDir("ccdeck-recent-tap-"));
    const store = createCommitStore({ path: join(dir, "agent-commits.jsonl") });
    const tap = createAgentGitTap({
      store,
      resolveRepo: () => ({ top: "/r", commonDir: "/r/.git" }),
      confirm: () => ({ sha: "d".repeat(40), authorTime: 1 }),
    });
    const heard: any[] = [];
    const stop = tap.onCommit((h: any) => heard.push(h));
    const call = (sid: string, n: number) => {
      const base = { session_id: sid, cwd: "/r", tool_name: "Bash", tool_use_id: `t${n}`, tool_input: { command: "git commit -m x" } };
      tap.observe({ payload: { ...base, hook_event_name: "PreToolUse" }, receivedAt: n, source: "hook" }, { persisting: true });
      return { payload: { ...base, hook_event_name: "PostToolUse", tool_response: { stdout: `[main ${"d".repeat(7)}] x\n 1 file changed\n` } }, receivedAt: n + 1, source: "hook" };
    };
    tap.observe(call("mine", 1), { persisting: true });
    await tap.settled();
    await sleep(10);
    tap.observe(call("theirs", 3), { persisting: false });
    expect(heard.map(h => h.line ? `line ${h.line.sessionId} ${h.line.sha.slice(0, 7)}` : `elsewhere ${h.elsewhere}`)).toEqual(["line mine ddddddd", "elsewhere theirs"]);
    stop();
    tap.observe(call("theirs", 5), { persisting: false });
    expect(heard).toHaveLength(2);
  });
});
