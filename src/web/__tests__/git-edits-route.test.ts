// GET /api/git/edits, through the real server: the files a session's agents
// edited through their edit tools, as paths in the session's repository — the
// whole team from the session, one subagent when asked, Codex's patches too,
// and nothing outside the repository.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, tempDir } from "./git-fixture";

const DIR = tempDir("ccdeck-git-edits-");
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
const { codexObjToPayload } = await import("../../server/codex-translate.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { relativeIn } = await import("../../server/git-edits.mjs");

const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };
let server: Server;
let port = 0;
let repo = "";
let outside = "";

function call(method: string, path: string, body?: unknown, token = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...(token ? { "x-ccdeck-token": hookToken() } : {}) } }, res => {
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
const edits = (params: Record<string, string>) => call("GET", `/api/git/edits?${new URLSearchParams(params)}`);
let n = 0;
const edit = (sid: string, cwd: string, tool: string, file_path: string, extra: Record<string, unknown> = {}, name = "PostToolUse") =>
  event({ hook_event_name: name, session_id: sid, cwd, tool_name: tool, tool_input: { file_path }, tool_response: { success: true }, tool_use_id: `toolu_e${++n}`, ...extra });

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  repo = track(repoWith({ "a.ts": "a\n" }, "ccdeck-git-edits-repo-"));
  outside = track(tempDir("ccdeck-git-edits-outside-"));
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

describe("a session's edited files", () => {
  it("answers the whole team's edits as repository paths, newest first, and nothing outside", async () => {
    await event({ hook_event_name: "SessionStart", session_id: "E1", cwd: repo });
    await event({ hook_event_name: "SessionNamed", session_id: "E1", sessionName: "auth-pass" });
    await edit("E1", repo, "Edit", join(repo, "a.ts"));
    await edit("E1", repo, "Write", join(repo, "src", "deep", "b.ts"));
    await edit("E1", repo, "Write", join(outside, "elsewhere.ts"));
    await edit("E1", repo, "Edit", join(repo, "failed.ts"), {}, "PostToolUseFailure");
    await event({ hook_event_name: "SubagentStart", session_id: "E1", cwd: repo, agent_id: "ag-1", agent_type: "test-writer" });
    await edit("E1", repo, "Write", join(repo, "test", "c.test.ts"), { agent_id: "ag-1", agent_type: "test-writer" });
    // The subagent touches a file the main thread touched too: one row each.
    await edit("E1", repo, "MultiEdit", join(repo, "a.ts"), { agent_id: "ag-1", agent_type: "test-writer" });

    const r = await edits({ session: "E1" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.state).toBe("repo");
    expect(r.body.repo.topLevel).toBe(repo);
    expect(r.body.edits.map((e: any) => [e.path, e.agentId, e.label])).toEqual([
      ["a.ts", "ag-1", "test-writer"],
      ["test/c.test.ts", "ag-1", "test-writer"],
      ["src/deep/b.ts", null, "auth-pass"],
      ["a.ts", null, "auth-pass"],
    ]);
    for (const e of r.body.edits) expect(typeof e.at).toBe("number");
    const ats = r.body.edits.map((e: any) => e.at);
    expect([...ats].sort((x: number, y: number) => y - x)).toEqual(ats);
  });

  it("narrows to one subagent when asked", async () => {
    const r = await edits({ session: "E1", agent: "ag-1" });
    expect(r.body.edits.map((e: any) => e.path)).toEqual(["a.ts", "test/c.test.ts"]);
    expect(r.body.edits.every((e: any) => e.agentId === "ag-1")).toBe(true);
  });

  it("answers an empty list for a session that edited nothing, and says why there is no repository", async () => {
    await event({ hook_event_name: "SessionStart", session_id: "E-quiet", cwd: repo });
    expect((await edits({ session: "E-quiet" })).body).toMatchObject({ ok: true, state: "repo", edits: [] });
    await event({ hook_event_name: "SessionStart", session_id: "E-plain", cwd: outside });
    await edit("E-plain", outside, "Write", join(outside, "notes.md"));
    expect((await edits({ session: "E-plain" })).body).toEqual({ ok: true, state: "not-a-repo", repo: null });
  });

  it("includes a Codex session's patches", async () => {
    const SID = "019ff475-79c7-7783-97e6-414efa70e0e0";
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** Add File: lib/new.ts\n+export {}\n*** End Patch\n";
    await event({ hook_event_name: "SessionStart", session_id: SID, cwd: repo, provider: "codex" });
    await event(codexObjToPayload({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "call_e1" } }, SID, repo));
    await event(codexObjToPayload({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_e1", output: [{ type: "input_text", text: "Exit code: 0\n" }] } }, SID, repo));
    const r = await edits({ session: SID });
    expect(r.body.edits.map((e: any) => e.path).sort()).toEqual(["a.ts", "lib/new.ts"]);
    expect(r.body.edits.every((e: any) => e.agentId === null)).toBe(true);
  });

  it("places edits named through a symlinked folder", async () => {
    const link = join(track(tempDir("ccdeck-git-edits-link-")), "via-link");
    try { symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir"); } catch { return; }
    await event({ hook_event_name: "SessionStart", session_id: "E-link", cwd: link });
    await edit("E-link", link, "Edit", join(link, "a.ts"));
    mkdirSync(join(repo, "made"), { recursive: true });
    await edit("E-link", link, "Write", join(link, "made", "later.ts"));
    const r = await edits({ session: "E-link" });
    expect(r.body.repo.topLevel).toBe(repo);
    expect(r.body.edits.map((e: any) => e.path).sort()).toEqual(["a.ts", "made/later.ts"]);
  });

  it("is guarded like the other git reads", async () => {
    expect((await call("GET", "/api/git/edits?session=E1", undefined, false)).status).toBe(401);
    expect((await edits({})).status).toBe(400);
    expect((await edits({ session: "never-heard" })).status).toBe(404);
  });
});

describe("relativeIn", () => {
  it("answers a path strictly inside, with forward slashes, and nothing else", () => {
    expect(relativeIn("/w/repo", "/w/repo/src/a.ts", "linux")).toBe("src/a.ts");
    expect(relativeIn("/w/repo", "/w/repo", "linux")).toBeNull();
    expect(relativeIn("/w/repo", "/w/repo-other/a.ts", "linux")).toBeNull();
    expect(relativeIn("/w/repo", "/w/repo/../x.ts", "linux")).toBeNull();
    expect(relativeIn("/w/repo", "src/a.ts", "linux")).toBeNull();
    expect(relativeIn("/w/repo", "/w/repo/..notes", "linux")).toBe("..notes");
    expect(relativeIn("/w/Repo", "/w/repo/a.ts", "linux")).toBeNull();
    expect(relativeIn("/w/Repo", "/w/repo/a.ts", "darwin")).toBe("a.ts");
    expect(relativeIn("C:\\w\\repo", "c:\\W\\repo\\src\\a.ts", "win32")).toBe("src/a.ts");
  });
});
