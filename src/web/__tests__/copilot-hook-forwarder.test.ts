// What hook.js does with an event GitHub Copilot CLI hands it (`--provider
// copilot`, from the entries in src/server/copilot-hooks.mjs), and what its
// Claude entries do when Copilot is the one running them.
//
// The payloads below are the shapes Copilot CLI 1.0.114 sent for its PascalCase
// event names in a scratch session (ids and paths replaced), so each case pins
// the one normalisation step against what really arrives: SubagentStart's half
// camelCase payload, the subagent reported as the session, a subagent's own
// prompt and stop, tool_result for tool_response, and the notification kinds.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import { endStdin } from "./child-stdin";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-copilot-forwarder-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const COPY = join(DIR, "hook.cjs");
copyFileSync(HOOK, COPY);
type Payload = Record<string, unknown>;
const { fromCopilot, parseEvent, startedByCopilot, challengeProof } = createRequire(import.meta.url)(COPY) as {
  fromCopilot: (payload: unknown, event: string | null) => Payload | null;
  parseEvent: (argv: string[]) => string | null;
  startedByCopilot: (env: Record<string, string | undefined>) => boolean;
  challengeProof: (token: string, nonce: string) => string;
};

const ROOT_ID = "446e868c-0000-4000-8000-000000000001";
const CHILD_ID = "9f2e7872-0000-4000-8000-000000000002";
const GRANDCHILD_ID = "f7db0322-0000-4000-8000-000000000003";
const CWD = "/home/dev/project/sub";
const TRANSCRIPT = `/home/dev/.copilot/session-state/${ROOT_ID}/events.jsonl`;

const sessionStart = { hook_event_name: "SessionStart", session_id: ROOT_ID, timestamp: "2026-11-22T06:56:46.313Z", cwd: CWD, source: "new", initial_prompt: "hi" };
const prompt = { hook_event_name: "UserPromptSubmit", session_id: ROOT_ID, timestamp: "2026-11-22T06:56:46.329Z", cwd: CWD, prompt: "hi" };
const preTool = {
  hook_event_name: "PreToolUse", session_id: ROOT_ID, timestamp: "2026-11-22T06:52:25.939Z", cwd: CWD,
  tool_use_id: "call_1795330345927", tool_name: "Bash", tool_input: { command: "echo ran", description: "Print a word" },
};
const postTool = {
  ...preTool, hook_event_name: "PostToolUse", timestamp: "2026-11-22T06:52:26.308Z",
  tool_result: { result_type: "success", text_result_for_llm: "ran\n<shellId: 0 completed with exit code 0>" },
};
const stop = { hook_event_name: "Stop", session_id: ROOT_ID, timestamp: "2026-11-22T06:52:26.421Z", cwd: CWD, transcript_path: TRANSCRIPT, stop_reason: "end_turn", stop_hook_active: false };
const sessionEnd = { hook_event_name: "SessionEnd", session_id: ROOT_ID, timestamp: "2026-11-22T06:57:01.599Z", cwd: CWD, reason: "complete" };
// SubagentStart: no hook_event_name, and the session, transcript and name in camelCase.
const subagentStart = {
  sessionId: ROOT_ID, timestamp: 1795330436250, cwd: CWD, transcriptPath: TRANSCRIPT, agentName: "task",
  agent_id: CHILD_ID, agent_type: "task", parent_agent_id: ROOT_ID,
};
const subagentStop = {
  hook_event_name: "SubagentStop", session_id: ROOT_ID, timestamp: "2026-11-22T06:53:56.642Z", cwd: CWD,
  agent_id: CHILD_ID, agent_type: "task", parent_agent_id: ROOT_ID, transcript_path: TRANSCRIPT, agent_name: "task",
  last_assistant_message: "All done.", stop_reason: "end_turn", stop_hook_active: false,
};
// Inside the subagent, Copilot reports the subagent as the session.
const inSubagent = (event: Payload, child = CHILD_ID, parent = ROOT_ID) => ({ ...event, session_id: child, agent_id: child, parent_agent_id: parent });

describe("fromCopilot, per event", () => {
  it("passes SessionStart, UserPromptSubmit, PreToolUse, Stop and SessionEnd of the main agent through as they are", () => {
    for (const event of [sessionStart, prompt, preTool, stop, sessionEnd]) {
      expect(fromCopilot(event, event.hook_event_name)).toEqual(event);
    }
  });

  it("keeps the transcript path exactly as Copilot sent it", () => {
    const odd = `/home/it's "me" $(id) ünï/.copilot/session-state/${ROOT_ID}/events.jsonl`;
    expect(fromCopilot({ ...stop, transcript_path: odd }, "Stop")?.transcript_path).toBe(odd);
    expect(fromCopilot({ ...subagentStart, transcriptPath: odd }, "SubagentStart")?.transcript_path).toBe(odd);
  });

  it("moves PostToolUse's tool_result to tool_response, the field the deck reads", () => {
    const out = fromCopilot(postTool, "PostToolUse")!;
    expect(out.tool_response).toEqual(postTool.tool_result);
    expect(out).not.toHaveProperty("tool_result");
    const { tool_result: _dropped, ...rest } = postTool;
    expect(out).toEqual({ ...rest, tool_response: postTool.tool_result });
    const already = { ...preTool, hook_event_name: "PostToolUse", tool_response: "r" };
    expect(fromCopilot(already, "PostToolUse")).toEqual(already);
  });

  it("passes PostToolUseFailure through", () => {
    const failure = { ...preTool, hook_event_name: "PostToolUseFailure", error: "exit 3" };
    expect(fromCopilot(failure, "PostToolUseFailure")).toEqual(failure);
  });

  it("names SubagentStart from its entry and fills the snake_case fields, with the root as the session", () => {
    expect(fromCopilot(subagentStart, "SubagentStart")).toEqual({
      ...subagentStart, hook_event_name: "SubagentStart", session_id: ROOT_ID, transcript_path: TRANSCRIPT,
    });
    // An agent_type it lacks comes from the agent's name.
    const { agent_type: _t, ...unnamed } = subagentStart;
    expect(fromCopilot(unnamed, "SubagentStart")?.agent_type).toBe("task");
    const camel = { sessionId: ROOT_ID, cwd: CWD, agentId: CHILD_ID, agentType: "explore", parentAgentId: ROOT_ID };
    expect(fromCopilot(camel, "SubagentStart")).toMatchObject({
      hook_event_name: "SubagentStart", session_id: ROOT_ID, agent_id: CHILD_ID, agent_type: "explore", parent_agent_id: ROOT_ID,
    });
  });

  it("passes SubagentStop through with the root session it already carries", () => {
    expect(fromCopilot(subagentStop, "SubagentStop")).toEqual(subagentStop);
  });

  it("puts a subagent's tool calls on the session of the agent that started it", () => {
    for (const event of [preTool, postTool, { ...preTool, hook_event_name: "PostToolUseFailure" }]) {
      const out = fromCopilot(inSubagent(event), event.hook_event_name)!;
      expect(out.session_id).toBe(ROOT_ID);
      expect(out.agent_id).toBe(CHILD_ID);
    }
    // One level further down Copilot names only the immediate parent.
    const nested = fromCopilot(inSubagent(preTool, GRANDCHILD_ID, CHILD_ID), "PreToolUse")!;
    expect(nested).toMatchObject({ session_id: CHILD_ID, agent_id: GRANDCHILD_ID });
  });

  it("drops a subagent's own UserPromptSubmit and Stop, which are its task starting and ending", () => {
    expect(fromCopilot(inSubagent(prompt), "UserPromptSubmit")).toBeNull();
    expect(fromCopilot(inSubagent(stop), "Stop")).toBeNull();
  });

  it("says permission_prompt for a permission wait and for a question, with a message", () => {
    const base = { hook_event_name: "Notification", session_id: ROOT_ID, cwd: CWD };
    expect(fromCopilot({ ...base, notification_type: "permission_prompt", message: "Allow bash?" }, "Notification"))
      .toEqual({ ...base, notification_type: "permission_prompt", message: "Allow bash?" });
    expect(fromCopilot({ ...base, notification_type: "permission_prompt" }, "Notification"))
      .toEqual({ ...base, notification_type: "permission_prompt", message: "Copilot needs your permission" });
    expect(fromCopilot({ ...base, notification_type: "elicitation_dialog" }, "Notification"))
      .toEqual({ ...base, notification_type: "permission_prompt", message: "Copilot has a question for you" });
  });

  it("drops the notifications that are not a wait", () => {
    const base = { hook_event_name: "Notification", session_id: ROOT_ID, cwd: CWD, message: "done" };
    for (const kind of ["shell_completed", "shell_detached_completed", "agent_completed", "agent_idle", undefined]) {
      expect(fromCopilot({ ...base, notification_type: kind }, "Notification"), String(kind)).toBeNull();
    }
  });

  it("lets the payload's own event name win over the entry's", () => {
    expect(fromCopilot(stop, "SessionStart")?.hook_event_name).toBe("Stop");
  });

  it("changes nothing in what it was given, and passes a non-object on", () => {
    const input = structuredClone(postTool);
    fromCopilot(input, "PostToolUse");
    expect(input).toEqual(postTool);
    expect(fromCopilot(null, "Stop")).toBeNull();
    expect(fromCopilot([1], "Stop")).toEqual([1]);
  });
});

describe("parseEvent", () => {
  it("reads the deck's event names from --event and nothing else", () => {
    expect(parseEvent(["--provider", "copilot", "--event", "SubagentStart"])).toBe("SubagentStart");
    expect(parseEvent(["--event", "Notification", "--provider", "copilot"])).toBe("Notification");
    expect(parseEvent(["--provider", "copilot", "--event", "PermissionRequest"])).toBeNull();
    expect(parseEvent(["--provider", "copilot", "--event", "__proto__"])).toBeNull();
    expect(parseEvent(["--provider", "copilot", "--event"])).toBeNull();
    expect(parseEvent(["--provider", "copilot"])).toBeNull();
  });
});

describe("startedByCopilot", () => {
  it("is COPILOT_HOOK_DEPTH being set", () => {
    expect(startedByCopilot({ COPILOT_HOOK_DEPTH: "1" })).toBe(true);
    expect(startedByCopilot({ COPILOT_HOOK_DEPTH: "2" })).toBe(true);
    expect(startedByCopilot({})).toBe(false);
    expect(startedByCopilot({ COPILOT_HOOK_DEPTH: "" })).toBe(false);
    expect(startedByCopilot({ COPILOT_HOOK_DEPTH: "  " })).toBe(false);
    // A tool's shell inside a Copilot session gets these, and not the depth.
    expect(startedByCopilot({ COPILOT_CLI: "1", COPILOT_AGENT_SESSION_ID: ROOT_ID })).toBe(false);
  });
});

// The whole hook, run as Copilot runs it, against a deck that proves itself
// and records what it is posted.
describe("the hook against a deck", () => {
  async function deck() {
    const token = randomBytes(16).toString("hex");
    const posts: Payload[] = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/hook-challenge") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce") ?? "") }));
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", c => { body += c; });
      req.on("end", () => {
        if (url.pathname === "/api/event") posts.push(JSON.parse(body));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const home = mkdtempSync(join(DIR, "home-"));
    mkdirSync(join(home, "agent-dag"), { recursive: true });
    writeFileSync(join(home, "agent-dag", "1001.json"), JSON.stringify({
      pid: process.pid, port, workspace: "", token, persist: join(home, "events.jsonl"), claude: true, codex: true,
      startedAt: new Date().toISOString(),
    }));
    return {
      posts,
      async run(args: string[], payload: Payload, extraEnv: Record<string, string> = {}) {
        const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home, ...extraEnv };
        if (!("COPILOT_HOOK_DEPTH" in extraEnv)) delete env.COPILOT_HOOK_DEPTH;
        delete env.AGENTS_DECK_INTERNAL;
        const child = spawn(process.execPath, [COPY, ...args], { env, stdio: ["pipe", "ignore", "ignore"] });
        endStdin(child, JSON.stringify(payload));
        return new Promise<number | null>((done, fail) => { child.on("error", fail); child.on("exit", c => done(c)); });
      },
      close: () => new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); }),
    };
  }

  it("posts Copilot's SubagentStart as the deck's event, on the root session, transcript path untouched", async () => {
    const d = await deck();
    try {
      const transcript = join(DIR, "it's \"x\" $(id) ünï", ".copilot", "session-state", ROOT_ID, "events.jsonl");
      const code = await d.run(
        ["--provider", "copilot", "--event", "SubagentStart"],
        { ...subagentStart, cwd: DIR, transcriptPath: transcript },
        { COPILOT_HOOK_DEPTH: "1" },
      );
      expect(code).toBe(0);
      expect(d.posts).toHaveLength(1);
      expect(d.posts[0]).toMatchObject({
        hook_event_name: "SubagentStart", provider: "copilot", session_id: ROOT_ID, agent_id: CHILD_ID,
        agent_type: "task", transcript_path: transcript,
      });
    } finally {
      await d.close();
    }
  }, 30_000);

  it("posts nothing for a subagent's own Stop", async () => {
    const d = await deck();
    try {
      expect(await d.run(["--provider", "copilot", "--event", "Stop"], { ...inSubagent(stop), cwd: DIR }, { COPILOT_HOOK_DEPTH: "1" })).toBe(0);
      expect(d.posts).toEqual([]);
    } finally {
      await d.close();
    }
  }, 30_000);

  // Copilot runs a repository's .claude/settings.json hooks too, so a Claude
  // config dir inside a repository would report every Copilot event twice.
  it("has the Claude entry stand down when Copilot runs it, and only then", async () => {
    const d = await deck();
    try {
      const event = { ...preTool, cwd: DIR };
      expect(await d.run(["--provider", "claude"], event, { COPILOT_HOOK_DEPTH: "1" })).toBe(0);
      expect(await d.run([], event, { COPILOT_HOOK_DEPTH: "1" })).toBe(0);
      expect(d.posts).toEqual([]);
      expect(await d.run(["--provider", "claude"], event)).toBe(0);
      expect(d.posts).toHaveLength(1);
      expect(d.posts[0]).toMatchObject({ hook_event_name: "PreToolUse", provider: "claude", session_id: ROOT_ID });
      // Copilot's own entry, run by Copilot, still posts.
      expect(await d.run(["--provider", "copilot", "--event", "PreToolUse"], event, { COPILOT_HOOK_DEPTH: "1" })).toBe(0);
      expect(d.posts).toHaveLength(2);
      expect(d.posts[1]).toMatchObject({ hook_event_name: "PreToolUse", provider: "copilot" });
    } finally {
      await d.close();
    }
  }, 30_000);
});
