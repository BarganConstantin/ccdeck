// The git view's history names the agent behind each commit, through the real
// server: a commit the deck watched an agent make is "seen", one an amend
// replaced is "matched", one it never saw but whose trailers name Claude or
// Codex is "trailer", and the rest are null. The session's own agent commits
// older than the 100-commit window are added after it, flagged — and a commit
// that left the history is not. No cost reaches the page.
//
// Real repositories; the agents' commits are recorded the way the deck records
// them, from the Bash events carrying what git printed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-attribution-");
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
const { agentGit } = await import("../../server/agent-git-tap.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { agentMark } = await import("../../server/git-attribution.mjs");

let server: Server;
let port = 0;
let repo = "";
const WHEN = "2026-01-02T03:04:05Z";
const sha: Record<string, string> = {};

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", "x-ccdeck-token": hookToken() } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, text: out });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const event = (p: Record<string, unknown>) => call("POST", "/api/event", p);
const log = (params: Record<string, string>) => call("GET", `/api/git/log?${new URLSearchParams(params)}`);

/** Commit as an agent's Bash call would and post that call; answers the SHA. */
async function agentCommit(sid: string, file: string, subject: string, who: Record<string, unknown> = {}): Promise<string> {
  write(repo, { [file]: `${subject}\n` });
  sh(repo, ["add", file]);
  const stdout = sh(repo, ["commit", "-m", subject], undefined, WHEN);
  const command = `git commit -m "${subject}"`;
  const id = `toolu_${file.replace(/\W/g, "")}`;
  await event({ hook_event_name: "PostToolUse", session_id: sid, cwd: repo, tool_name: "Bash", tool_input: { command }, tool_response: { stdout }, tool_use_id: id, ...who });
  await agentGit.settled();
  return sh(repo, ["rev-parse", "HEAD"]).trim();
}

/** `n` commits on top of HEAD in one process, nobody's. */
function fill(n: number, from: string) {
  let stream = "";
  for (let i = 1; i <= n; i++) {
    stream += `commit refs/heads/main\nauthor Ada Lovelace <ada@example.com> 1767323045 +0000\ncommitter Ada Lovelace <ada@example.com> 1767323045 +0000\ndata <<EOM\nchore: filler ${i}\nEOM\n${i === 1 ? `from ${from}\n` : ""}M 644 inline fill.txt\ndata <<EOM\n${i}\nEOM\n\n`;
  }
  sh(repo, ["fast-import", "--quiet"], stream);
  sh(repo, ["reset", "-q", "--hard"]);
}

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: LOG, codex: false });
  port = (server.address() as AddressInfo).port;
  repo = repoWith({ "a.txt": "one\n" }, "ccdeck-git-attribution-repo-");
  for (const sid of ["L1", "L2"]) await event({ hook_event_name: "SessionStart", session_id: sid, cwd: repo });
  await event({ hook_event_name: "SubagentStart", session_id: "L1", cwd: repo, agent_id: "ag-old", agent_type: "archaeologist" });

  // Long ago: one commit each by L1, L1's subagent and L2, and one by L1 that
  // a reset then took out of the history.
  sha.oldL1 = await agentCommit("L1", "old-l1.txt", "feat: old work of L1");
  sha.oldSub = await agentCommit("L1", "old-sub.txt", "feat: old work of the subagent", { agent_id: "ag-old", agent_type: "archaeologist" });
  sha.oldL2 = await agentCommit("L2", "old-l2.txt", "feat: old work of L2");
  sha.lost = await agentCommit("L1", "lost.txt", "feat: work a reset took away");
  sh(repo, ["reset", "-q", "--hard", "HEAD~1"]);
  fill(105, sh(repo, ["rev-parse", "HEAD"]).trim());

  // Inside the window.
  write(repo, { "t.txt": "trailer\n" });
  sh(repo, ["add", "t.txt"]);
  sh(repo, ["commit", "-q", "-m", "fix: nobody watched\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"], undefined, WHEN);
  sha.trailer = sh(repo, ["rev-parse", "HEAD"]).trim();
  write(repo, { "x.txt": "codex\n" });
  sh(repo, ["add", "x.txt"]);
  sh(repo, ["commit", "-q", "-m", "fix: codex was here\n\nCo-authored-by: Codex <noreply@openai.com>"], undefined, WHEN);
  sha.codexTrailer = sh(repo, ["rev-parse", "HEAD"]).trim();
  sha.seenWithTrailer = await agentCommit("L1", "s.txt", "feat: seen and signed\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
  sha.beforeAmend = await agentCommit("L1", "m.txt", "feat: amended later");
  write(repo, { "m2.txt": "more\n" });
  sh(repo, ["add", "m2.txt"]);
  sh(repo, ["commit", "-q", "--amend", "--no-edit"], undefined, WHEN);
  sha.amended = sh(repo, ["rev-parse", "HEAD"]).trim();
  sha.l2 = await agentCommit("L2", "l2.txt", "feat: recent work of L2", { model: "claude-sonnet-5-5" });
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
  rmTempDir(repo);
  rmTempDir(DIR);
});

const bySha = (commits: any[]) => new Map(commits.map(c => [c.sha, c]));

describe("the agent on each commit", () => {
  it("marks what was seen, what an amend replaced, and what only the trailers name", async () => {
    const r = await log({ session: "L1" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const c = bySha(r.body.commits);
    expect(c.get(sha.seenWithTrailer).agent).toEqual({
      sessionId: "L1", agentId: null, label: null, agentType: null, kind: "claude", model: null,
      durationMs: expect.any(Number), confidence: "seen",
    });
    expect(c.get(sha.amended).agent).toMatchObject({ sessionId: "L1", confidence: "matched" });
    expect(c.has(sha.beforeAmend)).toBe(false);
    expect(c.get(sha.trailer).agent).toEqual({ agent: "claude", confidence: "trailer" });
    expect(c.get(sha.codexTrailer).agent).toEqual({ agent: "codex", confidence: "trailer" });
    // Another session's commit is marked too: the view shows every agent's.
    expect(c.get(sha.l2).agent).toMatchObject({ sessionId: "L2", model: "claude-sonnet-5-5", confidence: "seen" });
    // Nobody's.
    const filler = r.body.commits.find((x: any) => x.subject === "chore: filler 105");
    expect(filler.agent).toBeNull();
  });

  it("adds the session's own older commits after the window, and only those still in the history", async () => {
    const r = await log({ session: "L1" });
    const inside = r.body.commits.filter((x: any) => !x.outsideWindow);
    const after = r.body.commits.filter((x: any) => x.outsideWindow);
    expect(inside).toHaveLength(100);
    expect(r.body.commits.slice(0, 100).every((x: any) => !x.outsideWindow)).toBe(true);
    expect(after.map((x: any) => x.sha).sort()).toEqual([sha.oldL1, sha.oldSub].sort());
    expect(after.find((x: any) => x.sha === sha.oldSub).agent).toMatchObject({ sessionId: "L1", agentId: "ag-old", label: "archaeologist", agentType: "archaeologist", confidence: "seen" });
    expect(after[0]).toMatchObject({ subject: expect.stringMatching(/^feat: old work/), parents: [expect.any(String)], refs: { local: [], remote: [], tags: [], head: false } });
    // HEAD has them, though the commits joining them to the window are not listed.
    expect(after.every((x: any) => x.onHead === true)).toBe(true);
    // Never twice, never another session's, never one a reset took away.
    expect(new Set(r.body.commits.map((x: any) => x.sha)).size).toBe(r.body.commits.length);
    expect(r.body.commits.some((x: any) => x.sha === sha.oldL2 || x.sha === sha.lost)).toBe(false);

    const other = await log({ session: "L2" });
    expect(other.body.commits.filter((x: any) => x.outsideWindow).map((x: any) => x.sha)).toEqual([sha.oldL2]);
  });

  it("narrows the older commits to one subagent's when asked", async () => {
    const r = await log({ session: "L1", agent: "ag-old" });
    expect(r.body.commits.filter((x: any) => x.outsideWindow).map((x: any) => x.sha)).toEqual([sha.oldSub]);
  });

  it("never answers with what a session spent", async () => {
    const r = await log({ session: "L1" });
    expect(r.text).not.toMatch(/"cost"|"usage"|input_tokens|"cwd"/);
  });
});

describe("agentMark", () => {
  it("lets a store record beat the trailers, and names nothing without either", () => {
    const trailers = [{ key: "Co-Authored-By", value: "Claude <noreply@anthropic.com>" }];
    const record = { sessionId: "s", agentId: "a", label: "x", agentType: "x", kind: "codex", model: "gpt-5.6", durationMs: 5, cost: { usage: {} }, cwd: "/w" };
    expect(agentMark({ record, confidence: "seen" }, trailers)).toEqual({ sessionId: "s", agentId: "a", label: "x", agentType: "x", kind: "codex", model: "gpt-5.6", durationMs: 5, confidence: "seen" });
    expect(agentMark(undefined, trailers)).toEqual({ agent: "claude", confidence: "trailer" });
    expect(agentMark(undefined, [])).toBeNull();
    expect(agentMark(undefined, undefined)).toBeNull();
  });
});
