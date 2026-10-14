import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";

// Isolate the watcher from the developer's Codex home before importing server.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-subagent-"));
const CODEX_HOME = join(DIR, "codex-home");
const DAY = join(CODEX_HOME, "sessions", "2026", "10", "13");
const CLAUDE = join(DIR, "claude");
const previous = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
mkdirSync(DAY, { recursive: true });
mkdirSync(CLAUDE, { recursive: true });

// @ts-expect-error — .mjs server module, no types
const { startCodexWatcher, scanCodexNow, eventsSince, CODEX_SESSIONS_DIR } = await import("../../server/index.mjs");
if (!String(CODEX_SESSIONS_DIR).startsWith(DIR)) {
  throw new Error(`refusing to run: the watcher resolved ${CODEX_SESSIONS_DIR}, outside ${DIR}`);
}

const ROOT = "root-thread";
const CHILD = "child-thread";
const line = (record: unknown): string => JSON.stringify(record) + "\n";
const rollout = (id: string) => join(DAY, `rollout-2026-10-13T10-00-00-${id}.jsonl`);
const codexPayloads = () => eventsSince(0)
  .filter((event: { source: string }) => event.source === "codex")
  .map((event: { payload: Record<string, unknown> }) => event.payload);

let timer: ReturnType<typeof setInterval> | null = null;
beforeAll(async () => {
  timer = startCodexWatcher("");
  await scanCodexNow();
});
afterAll(() => {
  if (timer) clearInterval(timer);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmTempDir(DIR);
});

describe("Codex subagent rollout watching", () => {
  it("translates legacy flat started activity and ignores its non-start variants", async () => {
    const parentPath = rollout(ROOT);
    writeFileSync(parentPath, line({ type: "session_meta", payload: { id: ROOT, cwd: DIR } }), "utf8");
    await scanCodexNow();

    for (const [kind, childId] of [["started", "flat-started-child"], ["completed", "flat-finished-child"], ["interacted", "flat-interacted-child"], ["future-kind", "flat-unknown-child"], [undefined, "flat-kindless-child"]]) {
      appendFileSync(parentPath, line({
        type: "event_msg",
        payload: { type: "sub_agent_activity", ...(kind ? { kind } : {}), agent_thread_id: childId },
      }), "utf8");
    }
    await scanCodexNow();
    const flatRelations = codexPayloads().filter((event: Record<string, unknown>) =>
      event.hook_event_name === "CodexSubagentStart" && String(event.session_id).startsWith("flat-"));
    expect(flatRelations).toHaveLength(1);
    expect(flatRelations[0]).toMatchObject({ session_id: "flat-started-child", parent_session_id: ROOT });
  });

  it("creates a relation from the parent activity before the child rollout exists, then merges the child by its own ID", async () => {
    const parentPath = rollout(ROOT);
    writeFileSync(parentPath, line({ type: "session_meta", payload: { id: ROOT, cwd: DIR } }), "utf8");
    await scanCodexNow();

    appendFileSync(parentPath, line({
      type: "event_msg",
      timestamp: "2026-10-13T10:00:01Z",
      payload: { type: "item_completed", item: { type: "SubAgentActivity", kind: "started", agent_thread_id: CHILD } },
    }), "utf8");
    await scanCodexNow();
    const first = codexPayloads().filter((event: Record<string, unknown>) => event.hook_event_name === "CodexSubagentStart" && event.session_id === CHILD);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      session_id: CHILD,
      parent_session_id: ROOT,
      provider: "codex",
      runtime: "codex",
      hook_event_name: "CodexSubagentStart",
      timestamp: "2026-10-13T10:00:01Z",
    });
    expect(first[0]).not.toHaveProperty("status");

    // Terminal / non-start activity records must not create more child nodes.
    for (const [kind, childId] of [["completed", "finished-child"], ["interacted", "other-child"], ["future-kind", "unknown-child"]]) {
      appendFileSync(parentPath, line({
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "SubAgentActivity", kind, agent_thread_id: childId } },
      }), "utf8");
    }
    await scanCodexNow();
    expect(codexPayloads().filter((event: Record<string, unknown>) => event.hook_event_name === "CodexSubagentStart" && event.session_id === CHILD)).toHaveLength(1);

    // The rollout header has its own thread ID; session_id is the parent and
    // must never be used as the child's node key.
    writeFileSync(rollout(CHILD), line({
      type: "session_meta",
      payload: {
        id: CHILD,
        session_id: ROOT,
        parent_thread_id: ROOT,
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: ROOT } } },
        agent_nickname: "Scout",
      },
    }) + line({ type: "event_msg", payload: { type: "user_message", message: "ignored in assertion" } }), "utf8");
    await scanCodexNow();
    const merged = codexPayloads();
    const relations = merged.filter((event: Record<string, unknown>) => event.hook_event_name === "CodexSubagentStart" && event.session_id === CHILD);
    expect(relations).toHaveLength(2); // two independent records, reducer merges by child ID
    expect(relations.every((event: Record<string, unknown>) => event.session_id === CHILD && event.parent_session_id === ROOT)).toBe(true);
    expect(merged.some((event: Record<string, unknown>) => event.session_id === ROOT && event.hook_event_name === "UserPromptSubmit")).toBe(false);

    appendFileSync(rollout(CHILD), line({ type: "event_msg", payload: { type: "user_message", message: "child follow-up" } }), "utf8");
    await scanCodexNow();
    expect(codexPayloads()).toContainEqual(expect.objectContaining({
      session_id: CHILD, hook_event_name: "UserPromptSubmit", prompt: "child follow-up",
    }));
    await scanCodexNow();
    expect(codexPayloads().filter((event: Record<string, unknown>) => event.hook_event_name === "CodexSubagentStart" && event.session_id === CHILD)).toHaveLength(2);
  });

  it("keeps ordinary Codex tool records on the existing translation path", async () => {
    const ordinary = "ordinary-thread";
    writeFileSync(rollout(ordinary), [
      { type: "session_meta", payload: { id: ordinary, cwd: DIR } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call-1", arguments: "{}" } },
    ].map(line).join(""), "utf8");
    await scanCodexNow();
    expect(codexPayloads()).toContainEqual(expect.objectContaining({
      session_id: ordinary, hook_event_name: "PreToolUse", tool_name: "shell", tool_use_id: "call-1",
    }));
    expect(codexPayloads().filter((event: Record<string, unknown>) => event.session_id === ordinary && event.hook_event_name === "CodexSubagentStart")).toHaveLength(0);
  });
});
