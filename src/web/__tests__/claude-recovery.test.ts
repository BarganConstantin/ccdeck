import { afterAll, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";
import { applyEvent, initialState } from "../reducer";
// @ts-expect-error server module
import { createClaudeRecovery, claudeProcessStarts } from "../../server/claude-recovery.mjs";
// @ts-expect-error server module
import { ccProjectSlug } from "../../server/claude-dir.mjs";

const dir = mkdtempSync(join(tmpdir(), "ccdeck-claude-recovery-"));
const sessions = join(dir, "sessions"); mkdirSync(sessions);
const transcriptDir = join(dir, "projects", ccProjectSlug(dir)); mkdirSync(transcriptDir, { recursive: true });
afterAll(() => rmTempDir(dir));
const fingerprint = "Mon Oct 19 12:00:00 2026";
const rows = new Map<number, any>();
const events: any[] = [];
const enriched: any[] = [];
function register(pid: number, sessionId: string, extras = {}) {
  const row = { pid, sessionId, cwd: dir, procStart: fingerprint, pidDomain: process.platform, status: "busy", updatedAt: 10, ...extras };
  rows.set(pid, row);
  writeFileSync(join(sessions, `${pid}.json`), JSON.stringify(row));
}
const starts = async () => new Map([...rows].map(([pid]) => [pid, fingerprint]));
const make = (options = {}) => createClaudeRecovery({ home: dir, starts, enabled: () => true,
  emit: (payload: any) => events.push(payload), enrich: (raw: any) => enriched.push(raw), ...options });

it("discovers only verified busy processes, restores text rather than tool results, then reconciles idle", async () => {
  register(11, "busy"); register(12, "idle", { status: "idle" });
  register(13, "reused", { procStart: "old identity" }); register(14, "foreign", { pidDomain: "foreign" });
  register(15, "../../escape");
  writeFileSync(join(transcriptDir, "busy.jsonl"), [
    { type: "user", message: { content: [{ type: "text", text: "finish export" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "not a prompt" }] } },
    { type: "assistant", message: { model: "claude-test" } },
  ].map(r => JSON.stringify(r) + "\n").join(""));
  const recovery = make(); await recovery.scan();
  expect(events.filter(e => e.recovery_active)).toEqual([expect.objectContaining({ session_id: "busy", provider: "claude", recovery_active: true, prompt: "finish export", model: "claude-test" })]);
  expect(enriched).toEqual([expect.objectContaining({ session_id: "busy", transcript_path: join(transcriptDir, "busy.jsonl") })]);
  const state = initialState();
  const activeEvent = events.find(e => e.recovery_active);
  applyEvent(state, { seq: 1, receivedAt: Date.now(), source: "hook", payload: activeEvent });
  expect(state.agents.get("busy")).toMatchObject({ provider: "claude", state: "active", synthetic: true, restoredFromLog: true, toolCount: 0 });
  applyEvent(state, { seq: 2, receivedAt: Date.now() + 1, source: "hook", payload: { session_id: "busy", hook_event_name: "ModelObserved", model: "claude-new" } });
  expect(state.agents.get("busy")!.restoredFromLog).toBe(true);
  const beforeIdle = events.length;
  await recovery.scan(); expect(events).toHaveLength(beforeIdle);
  register(11, "busy", { status: "idle", updatedAt: 20 }); await recovery.scan();
  expect(events.at(-1)).toMatchObject({ session_id: "busy", recovery_active: false });
  applyEvent(state, { seq: 3, receivedAt: Date.now() + 1, source: "hook", payload: events.at(-1) });
  expect(state.agents.get("busy")!.state).toBe("done");
  recovery.stop();
});

it("honors opt-out, workspace scope, and shutdown", async () => {
  const before = events.length;
  await make({ enabled: () => false }).scan();
  await make({ workspace: join(dir, "different") }).scan();
  const stopped = make(); stopped.stop(); await stopped.scan();
  expect(events).toHaveLength(before);
});

it("reads the real POSIX process start fingerprint without assuming PID existence is identity", async () => {
  if (!["darwin", "linux"].includes(process.platform)) return;
  const found = await claudeProcessStarts([process.pid]);
  expect(found.get(process.pid)).toMatch(/\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}/);
});

it("retries startup candidates after a registry race or a transient process-probe failure", async () => {
  register(21, "racing");
  const captured: any[] = [];
  let calls = 0;
  const recovery = make({ emit: (e: any) => captured.push(e), starts: async () => {
    calls++;
    if (calls === 1) { register(21, "racing", { updatedAt: 99 }); return new Map(); }
    return starts();
  } });
  await recovery.scan();
  expect(captured.filter(e => e.session_id === "racing")).toHaveLength(0);
  await recovery.scan();
  expect(captured.filter(e => e.session_id === "racing" && e.recovery_active)).toHaveLength(1);
  recovery.stop();
});

it("captures the startup preference and reconciles verified idle and exited processes", async () => {
  register(31, "exit-test"); register(32, "idle-test", { status: "idle" });
  let enabled = false;
  const captured: any[] = [];
  const optedOut = make({ enabled: () => enabled, emit: (e: any) => captured.push(e) });
  await optedOut.scan(); enabled = true; await optedOut.scan();
  expect(captured).toHaveLength(0);
  let gone = false;
  const recovery = make({ enabled: () => enabled, emit: (e: any) => captured.push(e), starts: async () => {
    const map: any = await starts(); map.complete = true;
    if (gone) map.delete(31);
    return map;
  } });
  await recovery.scan();
  expect(captured.find(e => e.session_id === "idle-test")).toMatchObject({ recovery_active: false });
  enabled = false; gone = true; unlinkSync(join(sessions, "31.json"));
  await recovery.scan();
  expect(captured.filter(e => e.session_id === "exit-test").at(-1)).toMatchObject({ recovery_active: false, recovery_session_closed: true });
  const state = initialState();
  applyEvent(state, { seq: 1, receivedAt: 1, source: "hook", payload: { session_id: "idle-test", hook_event_name: "UserPromptSubmit", prompt: "old turn" } });
  applyEvent(state, { seq: 2, receivedAt: Date.now(), source: "hook", payload: captured.find(e => e.session_id === "idle-test") });
  expect(state.agents.get("idle-test")!.state).toBe("done");
  recovery.stop(); optedOut.stop();
});
