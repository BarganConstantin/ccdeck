import { afterAll, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";
import { initialState, applyEvent } from "../reducer";

const dir = mkdtempSync(join(tmpdir(), "ccdeck-thread-links-"));
const prior = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
process.env.CODEX_HOME = join(dir, "codex");
process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
const day = join(process.env.CODEX_HOME, "sessions", "2026", "10", "19");
mkdirSync(day, { recursive: true });
// @ts-expect-error server module
const { startCodexWatcher, scanCodexNow, eventsSince } = await import("../../server/index.mjs");
let timer: ReturnType<typeof setInterval>;
const line = (value: unknown) => JSON.stringify(value) + "\n";
afterAll(() => {
  clearInterval(timer);
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmTempDir(dir);
});

it("links a child arriving before its parent and preserves its own live calls and ending", async () => {
  timer = startCodexWatcher("");
  await scanCodexNow();
  const child = join(day, "rollout-2026-10-19T10-00-00-child.jsonl");
  writeFileSync(child, line({ type: "session_meta", payload: { id: "child", cwd: dir, source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_nickname: "Worker" } } } } }) +
    line({ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "cmd", arguments: '{"command":"echo hello"}' } }));
  await scanCodexNow();
  const parent = join(day, "rollout-2026-10-19T10-00-01-parent.jsonl");
  writeFileSync(parent, line({ type: "session_meta", payload: { id: "parent", cwd: dir } }) + line({ type: "event_msg", payload: { type: "user_message", message: "Work" } }));
  await scanCodexNow();
  appendFileSync(child, line({ type: "event_msg", payload: { type: "task_complete" } }));
  await scanCodexNow();
  const state = initialState();
  for (const event of eventsSince(0)) applyEvent(state, event);
  expect(state.agents.get("child")).toMatchObject({ parentId: "parent", label: "Worker", sessionId: "child", toolCount: 1, state: "done" });
  expect(state.agents.get("parent")).toMatchObject({ toolCount: 0, state: "active", childCount: 1 });
  expect(state.agents.size).toBe(2);
});
