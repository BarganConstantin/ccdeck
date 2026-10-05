// Commit recording, switched on: a commit an agent's shell output reports is
// checked against its repository through the deck's own git runner and kept in
// the local store with its full SHA, its author time and what the session had
// spent — and nothing is recorded while the git view is switched off.
//
// Real repositories; the "agent" is the test posting the hook events an agent's
// `git commit` would, with the output git really printed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-recording-");
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
const { confirmCommit } = await import("../../server/git-confirm.mjs");

const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };
let server: Server;
let port = 0;
const WHEN = "2026-01-02T03:04:05Z";
const WHEN_MS = Date.parse(WHEN);

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

/** The store's lines, as written. */
const stored = (): any[] => {
  const path = agentGit.store.path as string;
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
};

/** Commit in `dir` the way an agent's Bash call would, and post that call. */
async function agentCommits(sid: string, dir: string, file: string, subject: string, extra: Record<string, unknown> = {}) {
  write(dir, { [file]: `${subject}\n` });
  sh(dir, ["add", file]);
  const stdout = sh(dir, ["commit", "-m", subject], undefined, WHEN);
  const command = `git add ${file} && git commit -m "${subject}"`;
  const id = `toolu_${subject.replace(/\W/g, "")}`;
  await event({ hook_event_name: "PreToolUse", session_id: sid, cwd: dir, tool_name: "Bash", tool_input: { command }, tool_use_id: id, ...extra });
  await event({ hook_event_name: "PostToolUse", session_id: sid, cwd: dir, tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false }, tool_use_id: id, ...extra });
  await agentGit.settled();
  return { stdout, sha: sh(dir, ["rev-parse", "HEAD"]).trim() };
}

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

describe("the repository's word on a commit", () => {
  it("answers the full SHA and the author time when the subject is the one printed", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-confirm-"));
    write(dir, { "b.txt": "two\n" });
    sh(dir, ["add", "b.txt"]);
    sh(dir, ["commit", "-q", "-m", "feat: second"], undefined, WHEN);
    const sha = sh(dir, ["rev-parse", "HEAD"]).trim();
    const at = { cwd: join(dir), repo: { top: dir, commonDir: join(dir, ".git") } };
    expect(await confirmCommit({ ...at, shortSha: sha.slice(0, 7), subject: "feat: second" })).toEqual({ sha, authorTime: WHEN_MS });
    // A subject other than the one printed: the repository cannot vouch for it.
    expect(await confirmCommit({ ...at, shortSha: sha.slice(0, 7), subject: "feat: something else" })).toBeNull();
    // No such commit here at all, and an object that is not a commit.
    expect(await confirmCommit({ ...at, shortSha: "deadbee", subject: "feat: second" })).toBe(false);
    const blob = sh(dir, ["rev-parse", "HEAD:b.txt"]).trim();
    expect(await confirmCommit({ ...at, shortSha: blob.slice(0, 7), subject: "feat: second" })).toBe(false);
  });

  it("cannot tell outside a repository, in a folder that is gone, or for a SHA that is not one", async () => {
    const plain = track(tempDir("ccdeck-git-confirm-plain-"));
    expect(await confirmCommit({ cwd: plain, repo: null, shortSha: "1a2b3c4", subject: "x" })).toBeNull();
    expect(await confirmCommit({ cwd: join(plain, "gone"), repo: null, shortSha: "1a2b3c4", subject: "x" })).toBeNull();
    for (const shortSha of ["HEAD", "--all", "1a2b3c", "", null]) {
      expect(await confirmCommit({ cwd: plain, shortSha, subject: "x" }), String(shortSha)).toBeNull();
    }
  });

  it("is a no only when git says there is no such commit", async () => {
    const answer = (r: Record<string, unknown>) => async () => ({ ok: false, stdout: "", stderr: "", code: 128, timedOut: false, tooLarge: false, missing: false, noFolder: false, ...r });
    const c = { cwd: "/r", repo: { top: "/r" }, shortSha: "1a2b3c4", subject: "x" };
    expect(await confirmCommit(c, { run: answer({ stderr: "fatal: Needed a single revision\n" }) })).toBe(false);
    expect(await confirmCommit(c, { run: answer({ stderr: "error: short object ID 1a2b3c4 is ambiguous\nhint: The candidates are:\nfatal: Needed a single revision\n" }) })).toBeNull();
    expect(await confirmCommit(c, { run: answer({ missing: true, code: "ENOENT" }) })).toBeNull();
    expect(await confirmCommit(c, { run: answer({ timedOut: true }) })).toBeNull();
    expect(await confirmCommit(c, { run: answer({ stderr: "fatal: detected dubious ownership in repository at '/r'\n" }) })).toBeNull();
    expect(await confirmCommit(c, { run: answer({ stderr: "fatal: something unexpected\n" }) })).toBeNull();
  });
});

describe("recording, switched on at start", () => {
  it("keeps a commit an agent made with its full SHA, author time and the session's spend", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-record-on-"));
    const usage = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 };
    await event({ hook_event_name: "SessionStart", session_id: "R1", cwd: dir });
    await event({ hook_event_name: "UsageObserved", session_id: "R1", usage, usageByModel: { "claude-opus-5-5": usage }, model: "claude-opus-5-5" });
    const { sha } = await agentCommits("R1", dir, "b.txt", "feat: record me");
    const line = stored().find(r => r.sessionId === "R1");
    expect(line).toMatchObject({
      v: 1, top: dir, sha, shaFull: true, subject: "feat: record me", authorTime: WHEN_MS,
      branch: "main", sessionId: "R1", agentId: null, kind: "claude", confidence: "seen", cwd: dir,
      cost: { usage, usageByModel: { "claude-opus-5-5": usage }, model: "claude-opus-5-5" },
    });
    expect(line.durationFrom).toBe("session-start");
  });

  it("names a subagent's commit after the subagent", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-record-sub-"));
    await event({ hook_event_name: "SessionStart", session_id: "R2", cwd: dir });
    await event({ hook_event_name: "SubagentStart", session_id: "R2", cwd: dir, agent_id: "ag-7", agent_type: "test-writer" });
    const { sha } = await agentCommits("R2", dir, "t.txt", "test: cover it", { agent_id: "ag-7", agent_type: "test-writer" });
    expect(stored().find(r => r.sessionId === "R2")).toMatchObject({ sha, shaFull: true, agentId: "ag-7", label: "test-writer", agentType: "test-writer" });
  });

  it("records nothing for a summary line no commit command printed", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-record-cat-"));
    const sha = sh(dir, ["rev-parse", "--short=7", "HEAD"]).trim();
    await event({ hook_event_name: "SessionStart", session_id: "R3", cwd: dir });
    await event({ hook_event_name: "PostToolUse", session_id: "R3", cwd: dir, tool_name: "Bash", tool_input: { command: "cat notes.txt" }, tool_response: { stdout: `[main ${sha}] first\n` }, tool_use_id: "toolu_cat" });
    await agentGit.settled();
    expect(stored().filter(r => r.sessionId === "R3")).toEqual([]);
  });

  it("records nothing while the git view is switched off, and again once it is on", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-record-off-"));
    await event({ hook_event_name: "SessionStart", session_id: "R4", cwd: dir });
    expect((await call("POST", "/api/prefs", { git: false })).body.prefs.git).toBe(false);
    try {
      await agentCommits("R4", dir, "off.txt", "feat: made while off");
      await sleep(200);
      expect(stored().filter(r => r.sessionId === "R4")).toEqual([]);
    } finally {
      expect((await call("POST", "/api/prefs", { git: true })).body.prefs.git).toBe(true);
    }
    const { sha } = await agentCommits("R4", dir, "on.txt", "feat: made while on");
    expect(stored().filter(r => r.sessionId === "R4").map(r => r.sha)).toEqual([sha]);
  });
});
