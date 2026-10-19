import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";
import { applyEvent, initialState } from "../reducer";
// @ts-expect-error server module
import { latestCodexRecovery, readCodexRecovery } from "../../server/codex-recovery.mjs";

const dir = mkdtempSync(join(tmpdir(), "ccdeck-recovery-read-"));
afterAll(() => rmTempDir(dir));
let file = 0;
const event = (type: string, extras = {}, timestamp = "2026-10-19T10:00:00Z") => ({ type: "event_msg", timestamp, payload: { type, ...extras } });
async function scan(rows: unknown[], suffix = "") {
  const path = join(dir, `${++file}.jsonl`);
  writeFileSync(path, rows.map(r => JSON.stringify(r) + "\n").join("") + suffix);
  return readCodexRecovery(path, statSync(path));
}

describe("bounded Codex recovery evidence", () => {
  it("recovers current prompt, model and cumulative usage without replaying tools", async () => {
    const r = await scan([
      event("user_message", { message: "implement search" }),
      event("task_started", { turn_id: "a", model_context_window: 200_000 }),
      { type: "turn_context", payload: { model: "gpt-test", effort: "high", approval_policy: "on-request" } },
      event("token_count", { info: { total_token_usage: { input_tokens: 150, output_tokens: 20 }, last_token_usage: { total_tokens: 60 } } }),
    ]);
    expect(r).toMatchObject({ active: true, certain: true, prompt: "implement search", model: "gpt-test", contextTokens: 60, window: 200_000, effort: "high", usage: { input_tokens: 150 } });
  });
  it.each(["task_complete", "turn_aborted"])("excludes a thread ending in %s", async type => {
    expect(await scan([event("task_started", { turn_id: "a" }), event(type, { turn_id: "a" })])).toMatchObject({ active: false });
  });
  it("accepts a new turn after completion and ignores another turn's delayed ending", async () => {
    const r = await scan([event("task_started", { turn_id: "old" }), event("task_complete", { turn_id: "old" }), event("task_started", { turn_id: "new" }), event("item_completed", { item: { type: "UserMessage", content: [{ text: "new task" }] } }), event("task_complete", { turn_id: "old" })]);
    expect(r).toMatchObject({ active: true, turnId: "new", prompt: "new task" });
  });
  it("does not classify a partial or malformed ending as a running process", async () => {
    const r = await scan([event("task_started")], '{"type":"event_msg"');
    expect(r.certain).toBe(false);
    expect(await scan([event("task_started")], "not json\n")).toMatchObject({ certain: false });
  });
  it("shares the live translator's fallback effort and explicit activity links", async () => {
    const r = await scan([{ type: "turn_context", payload: { collaboration_mode: { settings: { reasoning_effort: "xhigh" } } } }, event("task_started")]);
    expect(r.effort).toBe("xhigh");
  });
  it("retains a prompt whose final newline is exactly at the boot boundary", async () => {
    const path = join(dir, `${++file}.jsonl`);
    const boot = [event("task_started"), event("user_message", { message: "last complete boot record" })].map(r => JSON.stringify(r) + "\n").join("");
    writeFileSync(path, boot + JSON.stringify(event("token_count")) + "\n");
    const r = await readCodexRecovery(path, statSync(path), "s", "/project", Buffer.byteLength(boot));
    expect(r).toMatchObject({ certain: true, active: true, prompt: "last complete boot record" });
  });
  it("does not use an older resumed rollout when a newer one is completed", () => {
    const old = { snapshot: { certain: true, active: true, at: 10 } };
    const ended = { snapshot: { certain: true, active: false, at: 20 } };
    expect(latestCodexRecovery([old, ended])).toBe(ended);
    expect(latestCodexRecovery([old, { snapshot: { certain: true, active: false, at: 10 } }])).toBeNull();
  });
});

describe("recovered client sessions", () => {
  it("keeps history partial, attaches a prompt once, and clears the restoration marker on live traffic", () => {
    const state = initialState();
    const payload = { hook_event_name: "CodexSessionRecovered", provider: "codex" as const, session_id: "s", cwd: "/demo", snapshot_observed_at: 1000, turn_started_at: 100, prompt: "task", model: "gpt-test", usage: { input_tokens: 20 } };
    applyEvent(state, { seq: 1, receivedAt: 2000, source: "codex", payload });
    applyEvent(state, { seq: 2, receivedAt: 2001, source: "codex", payload });
    expect(state.agents.get("s")).toMatchObject({ synthetic: true, restoredFromLog: true, startedAt: 100, state: "active", toolCount: 0, prompts: [{ text: "task" }], usage: { inputTokens: 20 } });
    applyEvent(state, { seq: 3, receivedAt: 3000, source: "codex", payload: { provider: "codex", session_id: "s", hook_event_name: "Stop" } });
    expect(state.agents.get("s")).toMatchObject({ state: "done", restoredFromLog: undefined });
  });
  it("does not overwrite a live event which overtook the disk scan", () => {
    const state = initialState();
    applyEvent(state, { seq: 1, receivedAt: 2000, source: "codex", payload: { session_id: "s", provider: "codex", hook_event_name: "Stop" } });
    applyEvent(state, { seq: 2, receivedAt: 3000, source: "codex", payload: { session_id: "s", provider: "codex", hook_event_name: "CodexSessionRecovered", snapshot_observed_at: 1000 } });
    expect(state.agents.get("s")!.state).toBe("done");
  });  it("reconciles an offline completion without creating terminal-only sessions", () => {
    const state = initialState();
    applyEvent(state, { seq: 1, receivedAt: 100, source: "codex", payload: { session_id: "s", provider: "codex", hook_event_name: "UserPromptSubmit", prompt: "work" } });
    for (const [seq, session_id] of [[2, "s"], [3, "absent"]] as const) {
      applyEvent(state, { seq, receivedAt: 3000, source: "codex", payload: { session_id, provider: "codex", hook_event_name: "CodexSessionRecovered", snapshot_observed_at: 1000, recovery_active: false } });
    }
    expect(state.agents.get("s")!.state).toBe("done");
    expect(state.agents.has("absent")).toBe(false);
  });

});
