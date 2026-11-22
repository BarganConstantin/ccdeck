// ccdeck's opencode plugin, run against fakes of both opencode lines.
//
// The plugin (src/server/opencode-plugin-body.mjs) turns opencode's session
// events into the Claude-shaped events the deck already understands and hands
// each one to hook.js. What these pin: the mapping for OpenCode 1's hooks and
// bus events and for OpenCode 2's hooks and event stream, subagents reported
// under their root session, the serial queue that keeps a call's PreToolUse
// ahead of its PostToolUse, the cap, the kill of a forwarder that hangs, and
// that nothing the plugin meets — a throwing spawn, a lookup that fails, input
// it cannot serialise — ever reaches opencode as an error or as output.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// @ts-expect-error — .mjs server module, no types
const { ccdeckOpencodePlugin } = await import("../../server/opencode-plugin-body.mjs");

type Rec = { file: string; args: string[]; opts: any; body: string; killed: boolean; child: any };

/** A spawn that records each run. `hold` keeps every child running until
 *  `release` closes it, for the queue tests. */
function fakeSpawn({ hold = false, failFile }: { hold?: boolean; failFile?: string } = {}) {
  const runs: Rec[] = [];
  const spawn = (file: string, args: string[], opts: any) => {
    const child: any = new EventEmitter();
    const rec: Rec = { file, args, opts, body: "", killed: false, child };
    child.kill = () => { rec.killed = true; };
    child.unref = () => {};
    child.stdin = {
      on() {},
      end(b: string) {
        rec.body = b;
        if (file === failFile) {
          setImmediate(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
          return;
        }
        if (!hold) setImmediate(() => child.emit("close", 0));
      },
    };
    runs.push(rec);
    return child;
  };
  const release = (i: number) => runs[i].child.emit("close", 0);
  const payloads = () => runs.filter(r => r.file !== failFile).map(r => JSON.parse(r.body));
  return { spawn, runs, release, payloads };
}

const CONFIG = { file: "/opt/node/bin/node", args: ["/h/.claude/agent-dag/hook.js", "--provider", "opencode"], verbatim: false, claudeDir: "/h/.claude" };

function plugin(spawn: any, limits: any = {}) {
  return ccdeckOpencodePlugin({ spawn, config: CONFIG, env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/elsewhere" }, limits });
}

const tick = () => new Promise(r => setTimeout(r, 0));

/** OpenCode 1's plugin input, with a session lookup that answers from `known`. */
function v1Input(known: Record<string, any> = {}, get?: (id: string) => any) {
  return {
    directory: "/work/proj",
    worktree: "/work/proj",
    client: { session: { get: async ({ path }: any) => (get ? get(path.id) : { data: known[path.id] }) } },
  };
}

const created = (info: any) => ({ event: { type: "session.created", properties: { sessionID: info.id, info } } });
const bus = (type: string, properties: any) => ({ event: { type, properties } });
const names = (ps: any[]) => ps.map(p => p.hook_event_name);

afterEach(() => vi.restoreAllMocks());

describe("OpenCode 1: hooks and bus events become the deck's events", () => {
  it("maps a whole turn: start, prompt, a tool, a permission prompt, the end", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "ses_a", directory: "/work/proj", title: "New session" }));
    await hooks["chat.message"](
      { sessionID: "ses_a", model: { providerID: "github-copilot", modelID: "gpt-5.5" } },
      { message: { role: "user" }, parts: [{ type: "text", text: "fix the test" }, { type: "text", text: "<file body>", synthetic: true }, { type: "file", url: "x" }] },
    );
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_a", callID: "c1" }, { args: { command: "npm test", description: "run tests" } });
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_a", callID: "c1", args: { command: "npm test" } }, { title: "npm test", output: "1 passed", metadata: {} });
    await hooks.event(bus("permission.asked", { id: "per_1", sessionID: "ses_a", permission: "edit", patterns: [] }));
    await hooks.event(bus("session.status", { sessionID: "ses_a", status: { type: "busy" } }));
    await hooks.event(bus("session.idle", { sessionID: "ses_a" }));
    await vi.waitFor(() => expect(f.runs.length).toBe(6));
    await new Promise(r => setTimeout(r, 20));
    const ps = f.payloads();
    expect(names(ps)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"]);
    expect(ps[0]).toEqual({ hook_event_name: "SessionStart", session_id: "ses_a", cwd: "/work/proj" });
    expect(ps[1]).toEqual({ hook_event_name: "UserPromptSubmit", session_id: "ses_a", cwd: "/work/proj", prompt: "fix the test", model: "github-copilot/gpt-5.5" });
    expect(ps[2]).toEqual({ hook_event_name: "PreToolUse", session_id: "ses_a", cwd: "/work/proj", tool_name: "Bash", tool_input: { command: "npm test", description: "run tests" }, tool_use_id: "c1" });
    expect(ps[3]).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c1", tool_response: "1 passed" });
    expect(ps[4]).toEqual({ hook_event_name: "Notification", session_id: "ses_a", cwd: "/work/proj", notification_type: "permission_prompt", message: "opencode needs your permission" });
  });

  it("ends a turn once, whichever of opencode's idle signals arrive", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "ses_a", directory: "/p" }));
    await hooks["chat.message"]({ sessionID: "ses_a" }, { message: { role: "user" }, parts: [{ type: "text", text: "go" }] });
    await hooks.event(bus("session.status", { sessionID: "ses_a", status: { type: "idle" } }));
    await hooks.event(bus("session.idle", { sessionID: "ses_a" }));
    await hooks.event(bus("session.error", { sessionID: "ses_a", error: { name: "UnknownError" } }));
    await tick(); await tick();
    await vi.waitFor(() => expect(names(f.payloads())).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]));
    // An error on a session with no turn running ends nothing.
    await hooks.event(bus("session.error", { sessionID: "ses_a" }));
    await new Promise(r => setTimeout(r, 20));
    expect(f.runs.length).toBe(3);
    // A new turn, failed: session.error is its end.
    await hooks["chat.message"]({ sessionID: "ses_a" }, { message: { role: "user" }, parts: [{ type: "text", text: "again" }] });
    await hooks.event(bus("session.error", { sessionID: "ses_a" }));
    await vi.waitFor(() => expect(names(f.payloads())).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "UserPromptSubmit", "Stop"]));
  });

  it("closes a failed call from its tool part, and only a call it opened", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "ses_a", directory: "/p" }));
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "ses_a", callID: "c2" }, { args: { filePath: "/p/missing.ts" } });
    const errorPart = (callID: string) => bus("message.part.updated", {
      sessionID: "ses_a",
      part: { type: "tool", sessionID: "ses_a", callID, tool: "read", state: { status: "error", input: { filePath: "/p/missing.ts" }, error: "File not found" } },
    });
    await hooks.event(errorPart("c2"));
    // A second report of the same failure, and one for a call whose PreToolUse
    // never went out (an invalid tool), are both nothing.
    await hooks.event(errorPart("c2"));
    await hooks.event(errorPart("never-opened"));
    // A completed part is tool.execute.after's to report, not this.
    await hooks.event(bus("message.part.updated", { part: { type: "tool", sessionID: "ses_a", callID: "c2", tool: "read", state: { status: "completed" } } }));
    await new Promise(r => setTimeout(r, 30));
    const ps = f.payloads();
    expect(names(ps)).toEqual(["SessionStart", "PreToolUse", "PostToolUseFailure"]);
    expect(ps[2]).toEqual({
      hook_event_name: "PostToolUseFailure", session_id: "ses_a", cwd: "/p",
      tool_name: "Read", tool_input: { file_path: "/p/missing.ts" }, tool_use_id: "c2",
      tool_response: "File not found", error: "File not found",
    });
  });

  it("announces each permission or question once, under its own wording", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "ses_a", directory: "/p" }));
    await hooks.event(bus("permission.asked", { id: "per_1", sessionID: "ses_a" }));
    await hooks.event(bus("permission.v2.asked", { id: "per_1", sessionID: "ses_a" }));
    await hooks.event(bus("question.asked", { id: "que_1", sessionID: "ses_a", questions: [] }));
    await new Promise(r => setTimeout(r, 30));
    const ps = f.payloads();
    expect(names(ps)).toEqual(["SessionStart", "Notification", "Notification"]);
    expect(ps.map(p => p.message).slice(1)).toEqual(["opencode needs your permission", "opencode has a question"]);
    expect(ps.every(p => p.hook_event_name !== "Notification" || p.notification_type === "permission_prompt")).toBe(true);
  });

  it("reports a child session as a subagent of its root", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "ses_root", directory: "/p" }));
    await hooks["chat.message"]({ sessionID: "ses_root" }, { message: { role: "user" }, parts: [{ type: "text", text: "explore" }] });
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_root", callID: "t1" }, { args: { description: "look around", prompt: "find X", subagent_type: "explore" } });
    await hooks.event(created({ id: "ses_kid", parentID: "ses_root", directory: "/p", title: "look around (@explore subagent)" }));
    // The task's prompt to the child is not the user's.
    await hooks["chat.message"]({ sessionID: "ses_kid" }, { message: { role: "user" }, parts: [{ type: "text", text: "find X" }] });
    await hooks["tool.execute.before"]({ tool: "grep", sessionID: "ses_kid", callID: "g1" }, { args: { pattern: "X" } });
    await hooks["tool.execute.after"]({ tool: "grep", sessionID: "ses_kid", callID: "g1", args: { pattern: "X" } }, { title: "", output: "a.ts", metadata: {} });
    await hooks.event(bus("session.idle", { sessionID: "ses_kid" }));
    await hooks.event(bus("session.deleted", { sessionID: "ses_kid", info: { id: "ses_kid", parentID: "ses_root" } }));
    await hooks.event(bus("session.deleted", { sessionID: "ses_root", info: { id: "ses_root" } }));
    await vi.waitFor(() => expect(f.runs.length).toBe(8));
    await new Promise(r => setTimeout(r, 20));
    const ps = f.payloads();
    expect(names(ps)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "SubagentStart", "PreToolUse", "PostToolUse", "SubagentStop", "SessionEnd"]);
    expect(ps[3]).toEqual({ hook_event_name: "SubagentStart", session_id: "ses_root", agent_id: "ses_kid", agent_type: "explore", cwd: "/p" });
    expect(ps[4]).toMatchObject({ session_id: "ses_root", agent_id: "ses_kid", tool_name: "Grep" });
    expect(ps[6]).toEqual({ hook_event_name: "SubagentStop", session_id: "ses_root", agent_id: "ses_kid", agent_type: "explore", cwd: "/p" });
    expect(ps[7]).toEqual({ hook_event_name: "SessionEnd", session_id: "ses_root", cwd: "/p" });
  });

  it("looks up a session it first meets mid-life, a child's parent included", async () => {
    const f = fakeSpawn();
    const get = vi.fn((id: string) => ({
      data: id === "ses_kid" ? { id, parentID: "ses_old", directory: "/q", title: "x (@general subagent)" } : { id, directory: "/q" },
    }));
    const hooks = await plugin(f.spawn).server(v1Input({}, get));
    // The child's first tool call arrives before anything told the plugin it
    // exists — a resumed root, and a session.created still on its way.
    await hooks["tool.execute.before"]({ tool: "glob", sessionID: "ses_kid", callID: "g1" }, { args: { pattern: "**/*.ts" } });
    await hooks.event(created({ id: "ses_kid", parentID: "ses_old", directory: "/q" }));
    await vi.waitFor(() => expect(f.runs.length).toBe(3));
    await new Promise(r => setTimeout(r, 20));
    const ps = f.payloads();
    expect(names(ps)).toEqual(["SessionStart", "SubagentStart", "PreToolUse"]);
    expect(ps[0]).toEqual({ hook_event_name: "SessionStart", session_id: "ses_old", cwd: "/q" });
    expect(ps[1]).toMatchObject({ session_id: "ses_old", agent_id: "ses_kid", agent_type: "general" });
    expect(ps[2]).toMatchObject({ session_id: "ses_old", agent_id: "ses_kid", tool_name: "Glob", tool_input: { pattern: "**/*.ts" } });
    expect(get.mock.calls.map(c => c[0])).toEqual(["ses_kid", "ses_old"]);
  });

  it("treats a session it cannot look up as a root in the plugin's own directory", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn, { lookupMs: 30 }).server(v1Input({}, (id) => {
      if (id === "ses_throws") throw new Error("no server");
      return new Promise(() => {}); // never answers
    }));
    await hooks["chat.message"]({ sessionID: "ses_throws" }, { message: { role: "user" }, parts: [{ type: "text", text: "a" }] });
    await hooks["chat.message"]({ sessionID: "ses_hangs" }, { message: { role: "user" }, parts: [{ type: "text", text: "b" }] });
    await vi.waitFor(() => expect(f.runs.length).toBe(4));
    expect(f.payloads().map(p => [p.hook_event_name, p.session_id, p.cwd])).toEqual([
      ["SessionStart", "ses_throws", "/work/proj"], ["UserPromptSubmit", "ses_throws", "/work/proj"],
      ["SessionStart", "ses_hangs", "/work/proj"], ["UserPromptSubmit", "ses_hangs", "/work/proj"],
    ]);
  });
});

describe("tool names and inputs the deck can read", () => {
  it("maps opencode's built-ins to Claude Code's names and keys, and passes anything else through", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "s", directory: "/p" }));
    const calls: [string, any][] = [
      ["read", { filePath: "/p/a.ts", offset: 1 }],
      ["write", { filePath: "/p/b.ts", content: "x" }],
      ["edit", { filePath: "/p/c.ts", oldString: "a", newString: "b", replaceAll: true }],
      ["apply_patch", { patchText: "*** Begin Patch\n*** Update File: /p/d.ts\n*** End Patch" }],
      ["webfetch", { url: "https://example.com", format: "markdown" }],
      ["todowrite", { todos: [] }],
      ["question", { questions: [] }],
      ["github_create_issue", { filePath: "kept as is", title: "t" }],
      ["toString", { a: 1 }],
    ];
    for (const [i, [tool, args]] of calls.entries()) {
      await hooks["tool.execute.before"]({ tool, sessionID: "s", callID: `c${i}` }, { args });
    }
    await vi.waitFor(() => expect(f.runs.length).toBe(1 + calls.length));
    const pre = f.payloads().slice(1).map(p => [p.tool_name, p.tool_input]);
    expect(pre).toEqual([
      ["Read", { file_path: "/p/a.ts", offset: 1 }],
      ["Write", { file_path: "/p/b.ts", content: "x" }],
      ["Edit", { file_path: "/p/c.ts", old_string: "a", new_string: "b", replace_all: true }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Update File: /p/d.ts\n*** End Patch" }],
      ["WebFetch", { url: "https://example.com", format: "markdown" }],
      ["TodoWrite", { todos: [] }],
      ["AskUserQuestion", { questions: [] }],
      ["github_create_issue", { filePath: "kept as is", title: "t" }],
      ["toString", { a: 1 }],
    ]);
  });

  it("maps OpenCode 2's renamed tools and its `path`, which Grep and Glob keep", async () => {
    const f = fakeSpawn();
    const v2 = v2Ctx();
    await plugin(f.spawn).setup(v2.ctx);
    await v2.emit("session.created", { sessionID: "s", location: { directory: "/p" } });
    const calls: [string, any][] = [
      ["shell", { command: "ls", timeout: 5 }],
      ["read", { path: "/p/a.ts", offset: 1 }],
      ["write", { path: "/p/b.ts", content: "x" }],
      ["edit", { path: "/p/c.ts", oldString: "a", newString: "b", replaceAll: false }],
      ["patch", { patchText: "*** Begin Patch\n*** Add File: /p/d.ts\n*** End Patch" }],
      ["subagent", { agent: "explore", description: "find it", prompt: "look" }],
      ["grep", { pattern: "x", path: "/p/src" }],
      ["glob", { pattern: "*.ts", path: "/p" }],
      ["read", { path: "/p/e.ts", file_path: "/p/f.ts" }],
    ];
    for (const [i, [tool, input]] of calls.entries()) {
      v2.hooks.get("tool.execute.before")!({ tool, sessionID: "s", id: `c${i}`, input });
    }
    await vi.waitFor(() => expect(f.runs.length).toBe(1 + calls.length));
    expect(f.payloads().slice(1).map(p => [p.tool_name, p.tool_input])).toEqual([
      ["Bash", { command: "ls", timeout: 5 }],
      ["Read", { file_path: "/p/a.ts", offset: 1 }],
      ["Write", { file_path: "/p/b.ts", content: "x" }],
      ["Edit", { file_path: "/p/c.ts", old_string: "a", new_string: "b", replace_all: false }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Add File: /p/d.ts\n*** End Patch" }],
      ["Task", { subagent_type: "explore", description: "find it", prompt: "look" }],
      ["Grep", { pattern: "x", path: "/p/src" }],
      ["Glob", { pattern: "*.ts", path: "/p" }],
      // A `file_path` it already has wins; `path` then stays as it came.
      ["Read", { path: "/p/e.ts", file_path: "/p/f.ts" }],
    ]);
  });
});

/** OpenCode 2's plugin context: hook registrars and an event stream the test feeds. */
function v2Ctx(sessions: Record<string, any> = {}) {
  const hooks = new Map<string, (e: any) => unknown>();
  const buf: any[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const subscribed: any[] = [];
  const registrar = (domain: string) => async (name: string, cb: (e: any) => unknown) => {
    hooks.set(`${domain}.${name}`, cb);
    return { dispose: async () => {} };
  };
  const ctx = {
    location: { directory: "/v2/proj" },
    tool: { hook: registrar("tool") },
    session: { hook: registrar("session"), get: async ({ sessionID }: any) => sessions[sessionID] },
    event: {
      subscribe(opts: any) {
        subscribed.push(opts);
        opts?.signal?.addEventListener("abort", () => { closed = true; wake?.(); });
        return {
          async *[Symbol.asyncIterator]() {
            while (true) {
              while (buf.length) yield buf.shift();
              if (closed) return;
              await new Promise<void>(r => { wake = r; });
              wake = null;
            }
          },
        };
      },
    },
  };
  const emit = async (type: string, data: any) => { buf.push({ id: "evt", type, data }); wake?.(); await tick(); };
  return { ctx, hooks, emit, subscribed, isClosed: () => closed };
}

describe("OpenCode 2: hook registrations and the event stream become the deck's events", () => {
  it("maps a turn with a subagent, and stops listening on cleanup", async () => {
    const f = fakeSpawn();
    const v2 = v2Ctx();
    const cleanup = await plugin(f.spawn).setup(v2.ctx);
    expect([...v2.hooks.keys()].sort()).toEqual(["session.prompt", "tool.execute.after", "tool.execute.before"]);
    // Only the events it maps are asked for — not the text deltas.
    expect(v2.subscribed[0].types).toEqual(expect.arrayContaining(["session.created", "session.idle", "permission.asked", "form.created"]));
    expect(v2.subscribed[0].types).not.toContain("session.text.delta");

    await v2.emit("session.created", { sessionID: "ses_1", location: { directory: "/v2/repo" }, model: { id: "gpt-5.5", providerID: "github-copilot" }, slug: "s", version: "2" });
    v2.hooks.get("session.prompt")!({ sessionID: "ses_1", messageID: "m1", prompt: { text: "refactor it" }, delivery: "steer" });
    v2.hooks.get("tool.execute.before")!({ tool: "edit", sessionID: "ses_1", id: "call_1", input: { path: "/v2/repo/a.ts", oldString: "x", newString: "y" } });
    v2.hooks.get("tool.execute.after")!({ tool: "edit", sessionID: "ses_1", id: "call_1", input: {}, status: "completed", result: { content: [{ type: "text", text: "edited" }] } });
    v2.hooks.get("tool.execute.before")!({ tool: "shell", sessionID: "ses_1", id: "call_2", input: { command: "false" } });
    v2.hooks.get("tool.execute.after")!({ tool: "shell", sessionID: "ses_1", id: "call_2", input: { command: "false" }, status: "error", error: { message: "exit 1" } });
    await v2.emit("permission.asked", { id: "per_9", sessionID: "ses_1", action: "bash", resources: [] });
    await v2.emit("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "?", fields: [] } });
    await v2.emit("session.created", { sessionID: "ses_2", parentID: "ses_1", agent: "explore", location: { directory: "/v2/repo" }, slug: "k", version: "2" });
    v2.hooks.get("tool.execute.before")!({ tool: "grep", sessionID: "ses_2", id: "call_3", input: { pattern: "y" } });
    await v2.emit("session.status", { sessionID: "ses_2", status: { type: "idle" } });
    await v2.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await v2.emit("session.idle", { sessionID: "ses_1" });
    await v2.emit("session.deleted", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(f.runs.length).toBe(13));
    await new Promise(r => setTimeout(r, 20));
    const ps = f.payloads();
    expect(names(ps)).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreToolUse", "PostToolUseFailure",
      "Notification", "Notification", "SubagentStart", "PreToolUse", "SubagentStop", "Stop", "SessionEnd",
    ]);
    expect(ps[0]).toEqual({ hook_event_name: "SessionStart", session_id: "ses_1", cwd: "/v2/repo", model: "github-copilot/gpt-5.5" });
    expect(ps[1]).toEqual({ hook_event_name: "UserPromptSubmit", session_id: "ses_1", cwd: "/v2/repo", prompt: "refactor it" });
    expect(ps[2]).toMatchObject({ tool_name: "Edit", tool_input: { file_path: "/v2/repo/a.ts", old_string: "x", new_string: "y" }, tool_use_id: "call_1" });
    expect(ps[3]).toMatchObject({ hook_event_name: "PostToolUse", tool_response: "edited", tool_use_id: "call_1" });
    expect(ps[5]).toMatchObject({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_response: "exit 1", error: "exit 1" });
    expect(ps[6].message).toBe("opencode needs your permission");
    expect(ps[7].message).toBe("opencode has a question");
    expect(ps[8]).toEqual({ hook_event_name: "SubagentStart", session_id: "ses_1", agent_id: "ses_2", agent_type: "explore", cwd: "/v2/repo" });
    expect(ps[9]).toMatchObject({ session_id: "ses_1", agent_id: "ses_2", tool_name: "Grep" });
    expect(ps[10]).toMatchObject({ hook_event_name: "SubagentStop", session_id: "ses_1", agent_id: "ses_2" });

    await cleanup();
    expect(v2.isClosed()).toBe(true);
  });

  it("falls back to its location when a session names no directory, and survives a context without domains", async () => {
    const f = fakeSpawn();
    const v2 = v2Ctx({ ses_x: { id: "ses_x" } });
    await plugin(f.spawn).setup(v2.ctx);
    v2.hooks.get("session.prompt")!({ sessionID: "ses_x", prompt: { text: "hi" } });
    await vi.waitFor(() => expect(f.runs.length).toBe(2));
    expect(f.payloads().map(p => p.cwd)).toEqual(["/v2/proj", "/v2/proj"]);
    // An opencode whose context has none of these: setup still answers a cleanup.
    const bare = await plugin(f.spawn).setup({});
    expect(typeof bare).toBe("function");
    expect(() => bare()).not.toThrow();
  });
});

describe("the queue: one forwarder at a time, bounded, never stuck", () => {
  it("runs forwarders one after another, in arrival order", async () => {
    const f = fakeSpawn({ hold: true });
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "s", directory: "/p" }));
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "a" } });
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s", callID: "c1", args: {} }, { output: "x" });
    await tick();
    expect(f.runs.length).toBe(1);
    f.release(0);
    await vi.waitFor(() => expect(f.runs.length).toBe(2));
    await tick();
    expect(f.runs.length).toBe(2);
    f.release(1);
    await vi.waitFor(() => expect(f.runs.length).toBe(3));
    f.release(2);
    expect(names(f.payloads())).toEqual(["SessionStart", "PreToolUse", "PostToolUse"]);
  });

  it("drops new events while the queue is full", async () => {
    const f = fakeSpawn({ hold: true });
    const hooks = await plugin(f.spawn, { queue: 4 }).server(v1Input());
    await hooks.event(created({ id: "s", directory: "/p" })); // running, holding
    for (let i = 0; i < 10; i++) {
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: `c${i}` }, { args: { command: `n${i}` } });
    }
    for (let i = 0; i < 20; i++) {
      if (f.runs[i]) f.release(i);
      await tick();
    }
    await new Promise(r => setTimeout(r, 20));
    expect(f.payloads().map(p => p.tool_use_id ?? p.hook_event_name)).toEqual(["SessionStart", "c0", "c1", "c2", "c3"]);
  });

  it("kills a forwarder that does not finish, and goes on", async () => {
    const f = fakeSpawn({ hold: true });
    const hooks = await plugin(f.spawn, { killMs: 40 }).server(v1Input());
    await hooks.event(created({ id: "s", directory: "/p" }));
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: {} });
    await vi.waitFor(() => expect(f.runs.length).toBe(2), { timeout: 1000 });
    expect(f.runs[0].killed).toBe(true);
  });

  it("runs hook.js with an argv, no shell, no window, stdin only, in the deck's Claude config dir", async () => {
    const f = fakeSpawn();
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "s", directory: "/p" }));
    await vi.waitFor(() => expect(f.runs.length).toBe(1));
    const run = f.runs[0];
    expect(run.file).toBe(CONFIG.file);
    expect(run.args).toEqual(CONFIG.args);
    expect(run.opts).toMatchObject({ shell: false, windowsHide: true, windowsVerbatimArguments: false, stdio: ["pipe", "ignore", "ignore"] });
    expect(run.opts.env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/h/.claude" });
  });

  it("falls back to the node on PATH when the recorded one is gone", async () => {
    const f = fakeSpawn({ failFile: CONFIG.file });
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "s", directory: "/p" }));
    await vi.waitFor(() => expect(f.runs.length).toBe(2));
    expect(f.runs.map(r => r.file)).toEqual([CONFIG.file, "node"]);
    expect(f.runs[1].args).toEqual(CONFIG.args);
    expect(f.payloads()).toEqual([{ hook_event_name: "SessionStart", session_id: "s", cwd: "/p" }]);
  });
});

describe("nothing reaches opencode: no throw, no rejection, no output", () => {
  it("swallows a spawn that throws, input it cannot serialise, and hooks handed garbage", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    let n = 0;
    const spawn = (...a: any[]) => {
      n++;
      if (n === 1) throw new Error("EAGAIN");
      return fakeSpawn().spawn(...(a as [string, string[], any]));
    };
    const p = plugin(spawn as any);
    const hooks = await p.server(v1Input());
    await expect(hooks.event(created({ id: "s", directory: "/p" }))).resolves.toBeUndefined();
    const circular: any = {};
    circular.self = circular;
    await expect(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: circular })).resolves.toBeUndefined();
    for (const [name, args] of [
      ["event", [undefined]], ["event", [null]], ["event", [{ event: { type: "session.created", properties: null } }]],
      ["chat.message", [undefined, undefined]], ["chat.message", [null, { parts: "not a list" }]],
      ["tool.execute.before", [null, null]], ["tool.execute.after", [undefined, { output: 5 }]],
    ] as const) {
      await expect((hooks as any)[name](...args)).resolves.toBeUndefined();
    }
    // The queue still works after all of that.
    await hooks["chat.message"]({ sessionID: "s" }, { message: { role: "user" }, parts: [{ type: "text", text: "ok" }] });
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(2));
    await expect(p.server(undefined)).resolves.toBeTypeOf("object");
    await expect(p.setup(undefined)).resolves.toBeTypeOf("function");
    await new Promise(r => setTimeout(r, 20));
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns from every hook before its forwarder has even started", async () => {
    const f = fakeSpawn({ hold: true });
    const hooks = await plugin(f.spawn).server(v1Input());
    await hooks.event(created({ id: "s", directory: "/p" }));
    // The first forwarder holds; a tool hook must not wait for it.
    const started = Date.now();
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: {} });
    expect(Date.now() - started).toBeLessThan(50);
    expect(f.runs.length).toBe(1);
  });
});
