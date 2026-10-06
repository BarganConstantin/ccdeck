// Agent commits found in the events log the deck replays at boot: recorded
// after the replay, off its path, by the deck that writes the log, so a deck
// that never saw them made (one from before recording, or one with the git view
// off at the time) still marks them "seen" rather than only by their trailers.
//
// Real repositories, a log written the way the deck writes it, and the real
// server's boot replay and log route.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-replay-rec-");
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
const { ownsEventLog, recordReplayedCommits } = await import("../../server/git-confirm.mjs");

const SID = "e3200d5a-0000-4000-8000-0000000000a1";
const DOCS = "498737ff-0000-4000-8000-0000000000a2";
const SUB = "a4f1c9e27b3d5086";
const WHEN = "2026-01-02T03:04:05Z";
const T0 = Date.now() - 60 * 60_000;
const TRAILER = "\n\nCo-Authored-By: Claude <noreply@anthropic.com>";

let repo = "";
let server: Server;
let port = 0;
const shas: Record<string, string> = {};

function call(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { "x-ccdeck-token": hookToken() } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const stored = (): any[] => {
  const path = agentGit.store.path as string;
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
};

let seq = 0;
const line = (at: number, payload: Record<string, unknown>, source = "hook") => ({ seq: ++seq, receivedAt: at, source, payload });

/** Commit the way an agent's Bash call would, and the log lines that call left. */
function agentCommit(sid: string, file: string, subject: string, message: string, at: number, extra: Record<string, unknown> = {}) {
  write(repo, { [file]: `${subject}\n` });
  sh(repo, ["add", file]);
  const stdout = sh(repo, ["commit", "-m", message], undefined, WHEN);
  shas[subject] = sh(repo, ["rev-parse", "HEAD"]).trim();
  const command = `git add ${file} && git commit -m "${subject}"`;
  const id = `toolu_${subject.replace(/\W/g, "")}`;
  return [
    line(at, { hook_event_name: "PreToolUse", session_id: sid, cwd: repo, tool_name: "Bash", tool_input: { command }, tool_use_id: id, ...extra }),
    line(at + 500, { hook_event_name: "PostToolUse", session_id: sid, cwd: repo, tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false }, tool_use_id: id, ...extra }),
  ];
}

beforeAll(async () => {
  repo = repoWith({ "README.md": "shop\n" }, "ccdeck-git-replay-rec-repo-");
  const usage = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 };
  const log = [
    line(T0, { hook_event_name: "SessionStart", session_id: SID, cwd: repo }),
    line(T0 + 10, { hook_event_name: "SessionNamed", session_id: SID, sessionName: "api-fix" }, "internal"),
    line(T0 + 20, { hook_event_name: "UsageObserved", session_id: SID, usage, usageByModel: { "claude-opus-5-5": usage }, model: "claude-opus-5-5" }, "internal"),
    ...agentCommit(SID, "src/login.ts", "feat(auth): add login route", `feat(auth): add login route${TRAILER}`, T0 + 60_000),
    line(T0 + 61_000, { hook_event_name: "SubagentStart", session_id: SID, cwd: repo, agent_id: SUB, agent_type: "test-writer" }),
    ...agentCommit(SID, "test/login.test.ts", "test(auth): cover login failures", `test(auth): cover login failures${TRAILER}`, T0 + 90_000, { agent_id: SUB, agent_type: "test-writer" }),
    line(T0 + 100_000, { hook_event_name: "SessionStart", session_id: DOCS, cwd: repo }),
    ...agentCommit(DOCS, "docs/auth.md", "docs(auth): describe the login flow", "docs(auth): describe the login flow", T0 + 120_000),
  ];
  writeFileSync(LOG, log.map(l => JSON.stringify(l)).join("\n") + "\n");
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
  rmTempDir(repo);
  rmTempDir(DIR);
});

describe("commits found in the boot replay", () => {
  it("are not recorded on the replay's own path", () => {
    expect(stored()).toEqual([]);
  });

  it("are recorded by the deck writing the log, confirmed, and marked seen in the history over their trailers", async () => {
    // Before the pass, only a trailer speaks for them.
    const before = await call(`/api/git/log?session=${SID}`);
    const mark = (body: any, subject: string) => body.commits.find((c: any) => c.subject === subject)?.agent;
    expect(mark(before.body, "feat(auth): add login route")).toEqual({ agent: "claude", confidence: "trailer" });
    expect(mark(before.body, "docs(auth): describe the login flow")).toBeNull();

    expect(await recordReplayedCommits({ owns: async () => true })).toEqual({ found: 3, known: 0, recorded: 3 });
    const lines = stored();
    expect(lines.map(r => [r.sha, r.source, r.confidence, r.shaFull])).toEqual([
      [shas["feat(auth): add login route"], "replay", "seen", true],
      [shas["test(auth): cover login failures"], "replay", "seen", true],
      [shas["docs(auth): describe the login flow"], "replay", "seen", true],
    ]);
    expect(lines[0]).toMatchObject({ sessionId: SID, agentId: null, label: "api-fix", model: "claude-opus-5-5", durationFrom: "session-start", durationMs: 60_500 });
    expect(lines[1]).toMatchObject({ sessionId: SID, agentId: SUB, label: "test-writer", durationFrom: "commit" });

    const after = await call(`/api/git/log?session=${SID}`);
    expect(mark(after.body, "feat(auth): add login route")).toMatchObject({ sessionId: SID, agentId: null, label: "api-fix", confidence: "seen" });
    expect(mark(after.body, "test(auth): cover login failures")).toMatchObject({ sessionId: SID, agentId: SUB, label: "test-writer", confidence: "seen" });
    expect(mark(after.body, "docs(auth): describe the login flow")).toMatchObject({ sessionId: DOCS, confidence: "seen" });
  });

  it("are taken once: asking again, or after the next replay, adds nothing", async () => {
    const before = readFileSync(agentGit.store.path, "utf8");
    expect(await recordReplayedCommits({ owns: async () => true })).toEqual({ found: 0, known: 0, recorded: 0 });
    // The next boot replays the same log.
    // @ts-expect-error — plain .mjs server module, no types
    const { replayLog } = await import("../../server/log-replay.mjs");
    await replayLog(LOG);
    expect(await recordReplayedCommits({ owns: async () => true })).toEqual({ found: 3, known: 3, recorded: 0 });
    expect(readFileSync(agentGit.store.path, "utf8")).toBe(before);
  });
});

describe("who records them", () => {
  const fakeTap = () => {
    const calls: string[] = [];
    return { calls, tap: { recordReplayed: async () => { calls.push("record"); return { found: 1, known: 0, recorded: 1 }; }, dropReplayed: () => { calls.push("drop"); } } };
  };

  it("is only the deck that writes the log, with the git view on", async () => {
    const owner = fakeTap();
    expect(await recordReplayedCommits({ tap: owner.tap, owns: async () => true, enabled: () => true })).toEqual({ found: 1, known: 0, recorded: 1 });
    const other = fakeTap();
    expect(await recordReplayedCommits({ tap: other.tap, owns: async () => false, enabled: () => true })).toBeNull();
    const off = fakeTap();
    expect(await recordReplayedCommits({ tap: off.tap, owns: async () => true, enabled: () => false })).toBeNull();
    expect([owner.calls, other.calls, off.calls]).toEqual([["record"], ["drop"], ["drop"]]);
  });

  it("is decided by the log election once this deck is registered, and a deck that never registers is alone", async () => {
    const answers = (...seq: any[]) => { let i = 0; return async () => seq[Math.min(i++, seq.length - 1)]; };
    const unregistered = { path: LOG, decks: 2, mine: true, owner: null };
    expect(await ownsEventLog({ sharing: answers(unregistered, { path: LOG, decks: 2, mine: false, owner: { pid: 1, port: 4317 } }), everyMs: 1 })).toBe(false);
    expect(await ownsEventLog({ sharing: answers(unregistered, { path: LOG, decks: 1, mine: true, owner: { pid: 2, port: 4400 } }), everyMs: 1 })).toBe(true);
    expect(await ownsEventLog({ sharing: answers(unregistered), tries: 3, everyMs: 1 })).toBe(true);
    expect(await ownsEventLog({ sharing: answers({ path: null, decks: 1, mine: true, owner: null }), everyMs: 1 })).toBe(false);
    expect(await ownsEventLog({ sharing: async () => { throw new Error("unreadable"); }, everyMs: 1 })).toBe(false);
  });
});
