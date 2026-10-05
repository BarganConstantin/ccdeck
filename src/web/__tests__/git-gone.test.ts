// A session whose folder has been deleted — a worktree removed after the work
// was merged, a scratch clone cleaned up — can no longer have its repository
// asked. Its own log still names the branch it ran on: the newest `gitBranch`
// on a Claude transcript, or the branch a Codex rollout's session_meta
// recorded at the start. GitObserved says so, marked as read from the log.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { tempDir } from "./git-fixture";

const DIR = tempDir("ccdeck-git-gone-");
const CLAUDE = join(DIR, "claude");
const CODEX_HOME = join(DIR, "codex");
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
process.env.CODEX_HOME = CODEX_HOME;
process.env.XDG_CONFIG_HOME = join(DIR, "config");
mkdirSync(join(CODEX_HOME, "sessions"), { recursive: true });

// @ts-expect-error — plain .mjs server module, no types
const { startServer, startCodexWatcher, scanCodexNow, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { foldGitBranchLine } = await import("../../server/transcript-scan.mjs");

let server: Server;
let port = 0;
let codexTimer: ReturnType<typeof setInterval> | null = null;
const GONE = join(DIR, "deleted-worktree");

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
const observed = async (sid: string) =>
  ((await call("GET", "/api/events?since=0")).body as { payload: any }[])
    .filter(e => e.payload?.hook_event_name === "GitObserved" && e.payload.session_id === sid);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function first(sid: string): Promise<any> {
  for (let i = 0; i < 120; i++) {
    const [e] = await observed(sid);
    if (e) return e.payload;
    await sleep(50);
  }
  throw new Error(`no GitObserved for ${sid}`);
}
function transcript(name: string, lines: object[]): string {
  const dir = join(CLAUDE, "projects", "-tmp-gone");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  codexTimer = startCodexWatcher("");
});

afterAll(async () => {
  if (codexTimer) clearInterval(codexTimer);
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

describe("the branch a transcript line carries", () => {
  it("is folded newest-first, and a line without one changes nothing", () => {
    const s = { gitBranch: null as string | null };
    foldGitBranchLine(s, JSON.stringify({ type: "user", gitBranch: "main" }));
    foldGitBranchLine(s, JSON.stringify({ type: "assistant" }));
    expect(s.gitBranch).toBe("main");
    foldGitBranchLine(s, JSON.stringify({ type: "user", gitBranch: "feature/\"quoted\"" }));
    expect(s.gitBranch).toBe("feature/\"quoted\"");
  });
});

describe("a Claude session whose folder is gone", () => {
  it("is told the newest branch its transcript recorded, marked as from the log", async () => {
    const path = transcript("claude-gone", [
      { type: "user", gitBranch: "main", cwd: GONE },
      { type: "assistant", gitBranch: "feature/merged-and-removed", cwd: GONE },
    ]);
    await call("POST", "/api/event", { hook_event_name: "SessionStart", session_id: "C-gone", cwd: GONE, transcript_path: path });
    expect((await first("C-gone")).git).toEqual({ state: "gone", stale: 0, branch: "feature/merged-and-removed", fromLog: true });
  });

  it("is told nothing for a detached HEAD, which the transcript only calls HEAD", async () => {
    const path = transcript("claude-detached", [{ type: "user", gitBranch: "HEAD", cwd: GONE }]);
    await call("POST", "/api/event", { hook_event_name: "SessionStart", session_id: "C-detached", cwd: GONE, transcript_path: path });
    await sleep(800);
    expect(await observed("C-detached")).toEqual([]);
  });

  it("never reads a transcript path outside Claude Code's own folders", async () => {
    const outside = join(DIR, "elsewhere.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "user", gitBranch: "should-not-be-read" }) + "\n");
    await call("POST", "/api/event", { hook_event_name: "SessionStart", session_id: "C-outside", cwd: GONE, transcript_path: outside });
    await sleep(800);
    expect(await observed("C-outside")).toEqual([]);
  });
});

describe("a Codex session whose folder is gone", () => {
  it("is told the branch its rollout recorded when it began", async () => {
    const sid = "7d3b2a10-0000-4000-8000-00000000c0de";
    const day = join(CODEX_HOME, "sessions", "2026", "10", "05");
    mkdirSync(day, { recursive: true });
    await scanCodexNow();
    writeFileSync(join(day, `rollout-2026-10-05T10-00-00-${sid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: GONE, git: { branch: "fix/codex-gone", commit_hash: "abc" } } }) + "\n"
      + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } }) + "\n");
    await scanCodexNow();
    const p = await first(sid);
    expect(p.provider).toBe("codex");
    expect(p.git).toEqual({ state: "gone", stale: 0, branch: "fix/codex-gone", fromLog: true });
  });
});
