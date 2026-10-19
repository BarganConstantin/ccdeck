import { afterAll, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";
import { applyEvent, initialState } from "../reducer";

const dir = mkdtempSync(join(tmpdir(), "ccdeck-recovery-watch-"));
const old = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CCDECK_HOME: process.env.CCDECK_HOME };
process.env.CODEX_HOME = join(dir, "codex"); process.env.CLAUDE_CONFIG_DIR = join(dir, "claude"); process.env.CCDECK_HOME = join(dir, "deck");
const day = join(process.env.CODEX_HOME, "sessions", "2026", "10", "19");
const oldDay = join(process.env.CODEX_HOME, "sessions", "2026", "09", "01");
const middleDay = join(process.env.CODEX_HOME, "sessions", "2026", "10", "18");
for (const d of [day, middleDay, oldDay]) mkdirSync(d, { recursive: true });
const line = (r: unknown) => JSON.stringify(r) + "\n";
const record = (type: string, extras = {}, timestamp = "2026-10-19T10:00:00Z") => ({ type: "event_msg", timestamp, payload: { type, turn_id: "turn", ...extras } });
const pathOf = (id: string, directory = day) => join(directory, `rollout-2026-10-19T10-00-00-${id}.jsonl`);
function rollout(file: string, id: string, rows: unknown[], parent?: string) {
  writeFileSync(file, line({ type: "session_meta", payload: { id, cwd: dir, ...(parent ? { parent_thread_id: parent, agent_nickname: "Child" } : {}) } }) + rows.map(line).join(""));
}
rollout(pathOf("a-parent"), "a-parent", [record("task_started"), record("user_message", { message: "continue my task" }), record("sub_agent_activity", { kind: "started", agent_thread_id: "activity-child" }), record("sub_agent_activity", { kind: "started", agent_thread_id: "done" }), { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "past-call", arguments: '{"command":"echo past"}' } }]);
rollout(pathOf("z-child"), "z-child", [record("task_started"), record("user_message", { message: "child task snapshot" }), { type: "turn_context", payload: { model: "gpt-child" } }, record("token_count", { info: { total_token_usage: { input_tokens: 99 } } })], "a-parent");
rollout(pathOf("activity-child"), "activity-child", [record("task_started")]);
rollout(pathOf("done"), "done", [record("task_started"), record("task_complete")]);
rollout(pathOf("aborted"), "aborted", [record("task_started"), record("turn_aborted")]);
rollout(pathOf("old-open"), "resumed", [record("task_started")]);
rollout(pathOf("new-closed"), "resumed", [record("task_complete", {}, "2026-10-19T10:05:00Z")]);
rollout(pathOf("old-folder", oldDay), "old-folder", [record("task_started")]);
rollout(pathOf("padding", middleDay), "padding", [record("task_complete")]);
rollout(pathOf("partial"), "partial", [record("task_started")]);
rollout(pathOf("unstable-active"), "unstable-active", [record("task_started"), record("user_message", { message: "keep this prompt" })]);
const unfinished = line(record("token_count", { info: { total_token_usage: { input_tokens: 42 } } }));
appendFileSync(pathOf("unstable-active"), unfinished.slice(0, 15));
for (let i = 0; i < 17; i++) {
  rollout(pathOf(`deferred-${i}`), `deferred-${i}`, [record("task_started"), record("user_message", { message: `restore deferred ${i}` })]);
  appendFileSync(pathOf(`deferred-${i}`), unfinished.slice(0, 15));
}
const ending = line(record("task_complete"));
appendFileSync(pathOf("partial"), ending.slice(0, 15));

// @ts-expect-error server module
const { startCodexWatcher, scanCodexNow, eventsSince } = await import("../../server/index.mjs");
let timer: ReturnType<typeof setInterval>;
afterAll(() => {
  clearInterval(timer);
  for (const [k, value] of Object.entries(old)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
  rmTempDir(dir);
});

it("restores only unfinished threads, including a recently used old directory, without replaying calls", async () => {
  timer = startCodexWatcher(""); await scanCodexNow();
  const recovered = eventsSince(0).filter((e: any) => e.payload?.hook_event_name === "CodexSessionRecovered" && e.payload.recovery_active !== false);
  expect(recovered.map((e: any) => e.payload.session_id).sort()).toEqual(["a-parent", "activity-child", "old-folder", "z-child"]);
  expect(eventsSince(0).filter((e: any) => e.payload?.hook_event_name === "PreToolUse")).toHaveLength(0);
  const state = initialState(); for (const e of eventsSince(0)) applyEvent(state, e);
  expect(state.agents.get("a-parent")).toMatchObject({ synthetic: true, restoredFromLog: true, toolCount: 0, prompts: [{ text: "continue my task" }] });
  expect(state.agents.get("z-child")).toMatchObject({ parentId: "a-parent", restoredFromLog: true, model: "gpt-child", prompts: [{ text: "child task snapshot" }], usage: { inputTokens: 99 } });
  expect(state.agents.get("activity-child")!.parentId).toBe("a-parent");
  expect(state.agents.has("done")).toBe(false);
});

it("hands partial records and future appends to the live cursor exactly once", async () => {
  const before = eventsSince(0).at(-1)?.seq ?? 0;
  appendFileSync(pathOf("partial"), ending.slice(15));
  appendFileSync(pathOf("unstable-active"), unfinished.slice(15) + line({ type: "response_item", payload: { type: "function_call", call_id: "retry-live", name: "shell_command", arguments: '{"command":"echo retry live"}' } }) + line(record("user_message", { message: "new prompt after startup" })));
  appendFileSync(pathOf("a-parent"), line({ type: "response_item", payload: { type: "function_call", call_id: "live", name: "shell_command", arguments: '{"command":"echo live"}' } }) + line(record("task_complete")));
  await scanCodexNow(); await scanCodexNow();
  const fresh = eventsSince(before);
  expect(fresh.filter((e: any) => e.payload?.session_id === "unstable-active" && e.payload.hook_event_name === "CodexSessionRecovered")).toEqual([expect.objectContaining({ payload: expect.objectContaining({ prompt: "keep this prompt", recovery_active: true }) })]);
  expect(fresh.filter((e: any) => e.payload?.tool_use_id === "retry-live" && e.payload.hook_event_name === "PreToolUse")).toHaveLength(1);
  const recoveredState = initialState();
  for (const e of eventsSince(0)) applyEvent(recoveredState, e);
  expect(recoveredState.agents.get("unstable-active")!.prompts.map(p => p.text)).toEqual(["keep this prompt", "new prompt after startup"]);
  expect(fresh.filter((e: any) => e.payload?.hook_event_name === "PreToolUse" && e.payload.tool_use_id === "live")).toHaveLength(1);
  expect(fresh.filter((e: any) => e.payload?.session_id === "partial" && e.payload.hook_event_name === "CodexSessionRecovered" && e.payload.recovery_active === false)).toHaveLength(1);
});

it("retries candidates deferred by the per-tick budget even when their files stop growing", async () => {
  const before = eventsSince(0).at(-1)?.seq ?? 0;
  for (let i = 0; i < 17; i++) appendFileSync(pathOf(`deferred-${i}`), unfinished.slice(15));
  await scanCodexNow(); await scanCodexNow();
  const recovered = eventsSince(before).filter((e: any) => e.payload?.hook_event_name === "CodexSessionRecovered" && e.payload.session_id.startsWith("deferred-"));
  expect(new Set(recovered.map((e: any) => e.payload.session_id)).size).toBe(17);
  expect(recovered.every((e: any) => e.payload.prompt?.startsWith("restore deferred "))).toBe(true);
});
