// A deck started with --no-persist writes no events log, so it is the deck no
// log election names: commits its agents make are still kept — in its own
// memory, never in the commit store's file — so its git view marks them as
// seen for as long as it runs. Through the real server, with a real commit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-ram-only-");
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

const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };
let server: Server;
let port = 0;

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

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
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

describe("a deck with no events log", () => {
  it("marks a commit its agent made as seen, and writes nothing to disk for it", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }, "ccdeck-git-ram-only-repo-"));
    await event({ hook_event_name: "SessionStart", session_id: "RAM1", cwd: dir });
    write(dir, { "b.txt": "two\n" });
    sh(dir, ["add", "b.txt"]);
    const stdout = sh(dir, ["commit", "-m", "feat: made under no-persist"]);
    const sha = sh(dir, ["rev-parse", "HEAD"]).trim();
    const command = 'git add b.txt && git commit -m "feat: made under no-persist"';
    await event({ hook_event_name: "PreToolUse", session_id: "RAM1", cwd: dir, tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_ram1" });
    await event({ hook_event_name: "PostToolUse", session_id: "RAM1", cwd: dir, tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false }, tool_use_id: "toolu_ram1" });
    await agentGit.settled();

    const log = (await call("GET", "/api/git/log?session=RAM1")).body;
    const top = log.commits.find((c: any) => c.sha === sha);
    expect(top.agent).toMatchObject({ sessionId: "RAM1", confidence: "seen" });
    expect(existsSync(agentGit.store.path)).toBe(false);
  });
});
