import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState, STALE_SESSION_MS, sweepStaleSessions } from "../reducer";
import { sessionNoteShown } from "../session-note";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-startup-"));
const CODEX_HOME = join(DIR, "codex-home");
const DAY = join(CODEX_HOME, "sessions", "2021", "01", "02");
const OUTSIDE = mkdtempSync(join(tmpdir(), "ccdeck-codex-outside-"));
const previous = Object.fromEntries(["HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].map(key => [key, process.env[key]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
mkdirSync(DAY, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

// @ts-expect-error — server is JavaScript; set CODEX_HOME before its constants load.
const { canonicalWorkspace, eventsSince, scanCodexNow, startCodexWatcher } = await import("../../server/index.mjs");
// @ts-expect-error — internal event ring is JavaScript.
const { clearEventBuffer } = await import("../../server/event-ring.mjs");
// @ts-expect-error — server is JavaScript.
const { noteCodexLiveRecord, setCodexStartupDiscovery, startCodexStartupDiscovery, stopCodexStartupDiscovery, waitForCodexStartupBoundary } = await import("../../server/codex-startup.mjs");
// @ts-expect-error — internal event sink is JavaScript.
const { pushEvent } = await import("../../server/event-sink.mjs");
// @ts-expect-error — server is JavaScript.
const { CODEX_SESSIONS_DIR } = await import("../../server/codex-dir.mjs");
if (!String(CODEX_SESSIONS_DIR).startsWith(DIR)) throw new Error("startup scan escaped its synthetic Codex home");
const WORKSPACE = canonicalWorkspace(DIR);

const line = (record: unknown): string => JSON.stringify(record) + "\n";
const pathFor = (id: string, suffix = ""): string => join(DAY, `rollout-2021-01-02T03-04-05-${id}${suffix}.jsonl`);
const header = (id: string, cwd = DIR, parent?: string) => ({
  type: "session_meta",
  timestamp: "2021-01-02T03:04:05.000Z",
  payload: { id, cwd, ...(parent ? { parent_thread_id: parent } : {}) },
});
const start = (timestamp = "2021-01-02T03:10:00.000Z", turnId?: string) => ({
  type: "event_msg", timestamp, payload: { type: "task_started", model_context_window: 128000, ...(turnId ? { turn_id: turnId } : {}) },
});
const finish = (type: "task_complete" | "turn_aborted", turnId?: string, timestamp?: string) => ({
  type: "event_msg", ...(timestamp ? { timestamp } : {}), payload: { type, ...(turnId ? { turn_id: turnId } : {}) },
});
const payloads = () => eventsSince(0)
  .filter((event: { source: string }) => event.source === "codex")
  .map((event: { payload: Record<string, unknown> }) => event.payload);

function writeRollout(id: string, records: unknown[]) {
  writeFileSync(pathFor(id), records.map(line).join(""), "utf8");
}
function writeDuplicateRollout(id: string, suffix: string, records: unknown[]) {
  writeFileSync(pathFor(id, suffix), records.map(line).join(""), "utf8");
}

beforeAll(() => clearEventBuffer());
afterAll(async () => {
  await stopCodexStartupDiscovery();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("Codex startup discovery", () => {
  it("loads only recorded open turns, preserves old start times, and links only eligible nested families", async () => {
    const root = "root-old-active";
    const child = "child-active";
    const grandchild = "grandchild-active";
    const finished = "finished-recent";
    const aborted = "aborted-recent";
    const unknown = "unknown-state";
    const deadParent = "finished-parent";
    const liveChild = "child-with-finished-parent";
    const wrongWorkspace = "wrong-workspace";
    const mismatchedTerminal = "mismatched-old-terminal";
    const corrupt = "corrupt-after-start";
    const duplicateFinished = "duplicate-finished";
    const duplicateResumed = "duplicate-resumed";

    writeRollout(root, [header(root), start(), {
      type: "event_msg", timestamp: "2021-01-02T03:11:00.000Z",
      payload: { type: "item_completed", item: { type: "SubAgentActivity", kind: "started", agent_thread_id: child } },
    }]);
    writeRollout(child, [header(child, DIR, root), start("2021-01-02T03:12:00.000Z"), {
      type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", kind: "started", agent_thread_id: grandchild } },
    }]);
    writeRollout(grandchild, [header(grandchild, DIR, child), start("2021-01-02T03:13:00.000Z")]);
    writeRollout(finished, [header(finished), start(), finish("task_complete")]);
    writeRollout(aborted, [header(aborted), start(), finish("turn_aborted")]);
    writeRollout(unknown, [header(unknown), { type: "event_msg", payload: { type: "user_message" } }]);
    writeRollout(deadParent, [header(deadParent), start(), finish("task_complete")]);
    writeRollout(liveChild, [header(liveChild, DIR, deadParent), start()]);
    writeRollout(wrongWorkspace, [header(wrongWorkspace, OUTSIDE), start()]);
    writeRollout(mismatchedTerminal, [header(mismatchedTerminal), start(undefined, "turn-2"), finish("task_complete", "turn-1")]);
    writeFileSync(pathFor(corrupt), [line(header(corrupt)), line(start()), "{malformed complete line}\n"].join(""), "utf8");
    writeDuplicateRollout(duplicateFinished, "-old", [header(duplicateFinished), start("2021-01-02T03:10:00.000Z", "turn-1")]);
    writeDuplicateRollout(duplicateFinished, "-new", [header(duplicateFinished), start("2021-01-02T03:10:00.000Z", "turn-1"), finish("task_complete", "turn-1", "2021-01-02T03:20:00.000Z")]);
    writeDuplicateRollout(duplicateResumed, "-old", [header(duplicateResumed), start("2021-01-02T03:10:00.000Z", "turn-1"), finish("task_complete", "turn-1", "2021-01-02T03:20:00.000Z")]);
    writeDuplicateRollout(duplicateResumed, "-new", [header(duplicateResumed), start("2021-01-02T03:30:00.000Z", "turn-2")]);

    await startCodexStartupDiscovery(WORKSPACE, true);
    const events = payloads();
    const roots = events.filter(event => event.hook_event_name === "SessionStart");
    const edges = events.filter(event => event.hook_event_name === "CodexSubagentStart");
    expect(roots.map(event => event.session_id).sort()).toEqual([root, child, grandchild, liveChild, mismatchedTerminal, duplicateResumed].sort());
    expect(roots.find(event => event.session_id === root)).toMatchObject({
      timestamp: "2021-01-02T03:04:05.000Z", startup_discovery: true, model_context_window: 128000,
    });
    expect(events.some(event => [finished, aborted, unknown, deadParent, wrongWorkspace, corrupt, duplicateFinished].includes(String(event.session_id)))).toBe(false);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual(expect.objectContaining({ session_id: child, parent_session_id: root }));
    expect(edges).toContainEqual(expect.objectContaining({ session_id: grandchild, parent_session_id: child }));
    expect(edges.some(event => event.parent_session_id === deadParent || event.session_id === liveChild)).toBe(false);
    expect(events.some(event => event.hook_event_name === "PreToolUse" || event.hook_event_name === "UsageObserved")).toBe(false);

    const rootEnvelope = eventsSince(0).find((event: { payload: Record<string, unknown> }) =>
      event.payload.session_id === root && event.payload.hook_event_name === "SessionStart");
    expect(rootEnvelope.receivedAt).toBeGreaterThan(Date.now() - 5_000);
    const graph = initialState();
    const active = (await import("../reducer")).applyEvent(graph, rootEnvelope);
    expect(sweepStaleSessions(active, Date.now() + 60_000, STALE_SESSION_MS)).toBe(false);
  });

  it("restores only the input for an unfinished turn without calling it history", async () => {
    clearEventBuffer();
    const beforeStart = "input-before-task-start";
    const afterStart = "input-after-task-start";
    const empty = "empty-input";
    const complete = "completed-input";
    const aborted = "aborted-input";
    const longInput = `restore this line ${"x".repeat(220)}\nsecond line is not part of the compact note`;

    writeRollout(beforeStart, [
      header(beforeStart),
      { type: "event_msg", timestamp: "2021-01-02T03:09:00.000Z", payload: { type: "user_message", message: "an earlier request" } },
      start("2021-01-02T03:10:00.000Z", "turn-1"),
      finish("task_complete", "turn-1", "2021-01-02T03:11:00.000Z"),
      { type: "event_msg", timestamp: "2021-01-02T03:12:00.000Z", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: longInput }] } } },
      start("2021-01-02T03:13:00.000Z", "turn-2"),
    ]);
    writeRollout(afterStart, [
      header(afterStart),
      start("2021-01-02T03:10:00.000Z", "turn-3"),
      { type: "event_msg", timestamp: "2021-01-02T03:11:00.000Z", payload: { type: "user_message", message: "input after task start" } },
    ]);
    writeRollout(empty, [header(empty), start("2021-01-02T03:10:00.000Z"), {
      type: "event_msg", timestamp: "2021-01-02T03:11:00.000Z", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "image", data: "fixture" }] } },
    }]);
    writeRollout(complete, [header(complete), start(), { type: "event_msg", payload: { type: "user_message", message: "not current" } }, finish("task_complete")]);
    writeRollout(aborted, [header(aborted), start(), { type: "event_msg", payload: { type: "user_message", message: "not current" } }, finish("turn_aborted")]);

    await stopCodexStartupDiscovery();
    await startCodexStartupDiscovery(WORKSPACE, true);
    const events = eventsSince(0);
    const seeds = (id: string) => events.find((event: { payload: Record<string, unknown> }) =>
      event.payload.session_id === id && event.payload.hook_event_name === "SessionStart");
    const before = seeds(beforeStart);
    const after = seeds(afterStart);
    expect(before.payload).toMatchObject({ startup_prompt: longInput, startup_prompt_timestamp: "2021-01-02T03:12:00.000Z" });
    expect(after.payload).toMatchObject({ startup_prompt: "input after task start", startup_prompt_timestamp: "2021-01-02T03:11:00.000Z" });
    expect(seeds(empty)?.payload).not.toHaveProperty("startup_prompt");
    expect(seeds(complete)).toBeUndefined();
    expect(seeds(aborted)).toBeUndefined();

    const { applyEvent } = await import("../reducer");
    const graph = applyEvent(initialState(), before);
    const root = graph.agents.get(beforeStart)!;
    expect(root.startupPrompt).toEqual({ at: Date.parse("2021-01-02T03:12:00.000Z"), text: longInput });
    expect(root.prompts).toEqual([]);
    expect(root.firstPrompt).toBeUndefined();
    expect(root.synthetic).toBe(true);
    expect(root.promptHistoryPartial).toBe(true);
    expect(root.startedAt).toBeGreaterThan(Date.now() - 5_000);
    const compactNote = sessionNoteShown(root);
    expect(compactNote?.source).toBe("startup-input");
    expect(compactNote?.text).toBe("restore this line " + "x".repeat(141) + "…");
    expect(compactNote?.text).not.toContain("\n");
    expect(root.startupPrompt?.text).toContain("second line is not part of the compact note");
    expect(sweepStaleSessions(graph, Date.now() + 60_000, STALE_SESSION_MS)).toBe(false);

    applyEvent(graph, {
      seq: before.seq + 1, receivedAt: Date.now(), source: "codex",
      payload: { session_id: beforeStart, hook_event_name: "Stop", provider: "codex" },
    });
    expect(root.startupPrompt).toBeDefined();
    expect(sessionNoteShown(root)).toBeNull();

    // Older/duplicate rollout lines may arrive after the startup scan's
    // current-turn snapshot. They must not reopen a stopped root or replace it.
    const { codexObjToPayload } = await import("../../server/codex-translate.mjs");
    const delayedOldInput = codexObjToPayload({
      type: "event_msg", timestamp: "2021-01-02T03:11:00.000Z",
      payload: { type: "user_message", message: "an earlier request" },
    }, beforeStart, DIR);
    expect(delayedOldInput).toMatchObject({ prompt_timestamp: "2021-01-02T03:11:00.000Z" });
    applyEvent(graph, {
      seq: before.seq + 2, receivedAt: Date.now(), source: "codex", payload: delayedOldInput,
    });
    expect(root.state).toBe("done");
    expect(root.startupPrompt?.text).toBe(longInput);
    expect(root.prompts).toEqual([]);

    const duplicateStartupInput = codexObjToPayload({
      type: "event_msg", timestamp: "2021-01-02T03:12:00.000Z",
      payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: longInput }] } },
    }, beforeStart, DIR);
    expect(duplicateStartupInput).toMatchObject({ prompt_timestamp: "2021-01-02T03:12:00.000Z", prompt: longInput });
    applyEvent(graph, {
      seq: before.seq + 3, receivedAt: Date.now(), source: "codex", payload: duplicateStartupInput,
    });
    expect(root.state).toBe("done");
    expect(root.startupPrompt?.text).toBe(longInput);
    expect(root.prompts).toEqual([]);

    const newerInput = codexObjToPayload({
      type: "event_msg", timestamp: "2021-01-02T03:14:00.000Z",
      payload: { type: "user_message", message: "next live input" },
    }, beforeStart, DIR);
    applyEvent(graph, {
      seq: before.seq + 4, receivedAt: Date.now(), source: "codex", payload: newerInput,
    });
    expect(root.startupPrompt).toBeUndefined();
    expect(root.startupPromptSourceAt).toBe(Date.parse("2021-01-02T03:14:00.000Z"));
    expect(root.prompts).toHaveLength(1);
    expect(root.firstPrompt).toBe("next live input");
    expect(sessionNoteShown(root)).toMatchObject({ source: "prompt", text: "next live input" });

    const latePrompt = (timestamp: string, text: string) => codexObjToPayload({
      type: "event_msg", timestamp,
      payload: { type: "user_message", message: text },
    }, beforeStart, DIR);
    let lateSeq = before.seq + 5;
    for (const [timestamp, text] of [
      ["2021-01-02T03:13:00.000Z", "late older input"],
      ["2021-01-02T03:14:00.000Z", "duplicate next live input"],
    ]) {
      applyEvent(graph, { seq: lateSeq++, receivedAt: Date.now(), source: "codex", payload: latePrompt(timestamp, text) });
      expect(root.state).toBe("active");
      expect(root.prompts).toHaveLength(1);
      expect(root.firstPrompt).toBe("next live input");
    }

    applyEvent(graph, {
      seq: lateSeq++, receivedAt: Date.now() + 120_000, source: "codex",
      payload: { session_id: beforeStart, hook_event_name: "Stop", provider: "codex" },
    });
    applyEvent(graph, {
      seq: lateSeq++, receivedAt: Date.now() + 120_001, source: "codex",
      payload: latePrompt("2021-01-02T03:13:00.000Z", "late input after stop"),
    });
    expect(root.state).toBe("done");
    expect(root.prompts).toHaveLength(1);
    expect(root.firstPrompt).toBe("next live input");
  });

  it("does not compare live source time with a receipt-time fallback when the snapshot has no source time", async () => {
    const { applyEvent } = await import("../reducer");
    const { codexObjToPayload } = await import("../../server/codex-translate.mjs");
    for (const startupTimestamp of [undefined, "not-a-timestamp"]) {
      const id = `snapshot-without-source-time-${startupTimestamp ?? "missing"}`;
      const now = Date.now();
      const graph = applyEvent(initialState(), {
        seq: now, receivedAt: now, source: "codex",
        payload: {
          session_id: id, hook_event_name: "SessionStart", startup_discovery: true,
          startup_prompt: "captured unfinished input", ...(startupTimestamp ? { startup_prompt_timestamp: startupTimestamp } : {}),
          provider: "codex",
        },
      });
      const root = graph.agents.get(id)!;
      expect(root.startupPrompt?.at).toBe(now);
      expect(root.startupPromptSourceAt).toBeUndefined();

      const live = codexObjToPayload({
        type: "event_msg", timestamp: new Date(now - 1_000).toISOString(),
        payload: { type: "user_message", message: "new live input" },
      }, id, DIR);
      applyEvent(graph, { seq: now + 1, receivedAt: now + 1, source: "codex", payload: live });
      expect(root.startupPrompt).toBeUndefined();
      expect(root.prompts).toHaveLength(1);
      expect(root.firstPrompt).toBe("new live input");
    }
  });

  it("links only started SubAgentActivity records when child headers do not declare a parent", async () => {
    clearEventBuffer();
    await stopCodexStartupDiscovery();
    const parent = "activity-kind-parent";
    const started = "activity-started-child";
    const completed = "activity-completed-child";
    const interacted = "activity-interacted-child";
    const unknown = "activity-unknown-child";
    const missing = "activity-kindless-child";
    const legacyStarted = "legacy-activity-started-child";
    const legacyCompleted = "legacy-activity-completed-child";
    const legacyInteracted = "legacy-activity-interacted-child";
    const legacyUnknown = "legacy-activity-unknown-child";
    const legacyMissing = "legacy-activity-kindless-child";
    const activity = (kind: string | undefined, child: string) => ({
      type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", ...(kind ? { kind } : {}), agent_thread_id: child } },
    });
    const legacyActivity = (kind: string | undefined, child: string) => ({
      type: "event_msg", payload: { type: "sub_agent_activity", ...(kind ? { kind } : {}), agent_thread_id: child },
    });
    writeRollout(parent, [
      header(parent), start(),
      activity("started", started), activity("completed", completed), activity("interacted", interacted),
      activity("unknown", unknown), activity(undefined, missing),
      legacyActivity("started", legacyStarted), legacyActivity("completed", legacyCompleted),
      legacyActivity("interacted", legacyInteracted), legacyActivity("unknown", legacyUnknown),
      legacyActivity(undefined, legacyMissing),
    ]);
    for (const child of [started, completed, interacted, unknown, missing, legacyStarted, legacyCompleted, legacyInteracted, legacyUnknown, legacyMissing]) {
      writeRollout(child, [header(child), start()]);
    }

    await startCodexStartupDiscovery(WORKSPACE, true);
    const edges = payloads().filter(event => event.hook_event_name === "CodexSubagentStart");
    expect(edges.map(event => event.session_id).sort()).toEqual([started, legacyStarted].sort());
  });

  it("cancels an in-flight scan on OFF, scans immediately on ON, and deduplicates repeated enablement", async () => {
    clearEventBuffer();
    const id = "toggle-active";
    writeRollout(id, [header(id), start()]);
    const interrupted = startCodexStartupDiscovery(WORKSPACE, true);
    await setCodexStartupDiscovery(false);
    await interrupted;
    expect(payloads()).toHaveLength(0);

    await setCodexStartupDiscovery(true);
    expect(payloads().filter(event => event.hook_event_name === "SessionStart" && event.session_id === id)).toHaveLength(1);
    await setCodexStartupDiscovery(true);
    expect(payloads().filter(event => event.hook_event_name === "SessionStart" && event.session_id === id)).toHaveLength(1);
  });

  it("does not let a stale open-turn snapshot reactivate a session after the live tail emitted Stop", async () => {
    clearEventBuffer();
    const id = "live-stop-before-startup-seed";
    writeRollout(id, [header(id), start()]);
    const scanning = startCodexStartupDiscovery(WORKSPACE, true);
    const boundary = await waitForCodexStartupBoundary();
    expect(boundary).not.toBeNull();

    // Model the live tail consuming a completion after inventory but while
    // the one-shot reader is still inspecting its captured prefix.
    noteCodexLiveRecord(finish("task_complete"), id);
    pushEvent({ session_id: id, cwd: WORKSPACE, provider: "codex", hook_event_name: "Stop" }, "codex");
    await scanning;

    const events = payloads().filter(event => event.session_id === id);
    expect(events.map(event => event.hook_event_name)).toEqual(["Stop"]);
  });

  it("starts the live cursor at the captured boundary and consumes a later completion", async () => {
    clearEventBuffer();
    const id = "append-between-history-and-live";
    const path = pathFor(id);
    writeRollout(id, [header(id), start()]);
    await stopCodexStartupDiscovery();
    await startCodexStartupDiscovery(WORKSPACE, true);
    expect(payloads()).toContainEqual(expect.objectContaining({ session_id: id, hook_event_name: "SessionStart" }));

    const timer = startCodexWatcher("");
    appendFileSync(path, line(finish("task_complete")), "utf8");
    await scanCodexNow();
    clearInterval(timer);

    expect(payloads().filter(event => event.session_id === id).map(event => event.hook_event_name)).toEqual(["SessionStart", "Stop"]);
  });

  it("keeps the captured open-turn snapshot when only later complete lines are appended", async () => {
    clearEventBuffer();
    const id = "append-keeps-startup-snapshot";
    const path = pathFor(id);
    writeRollout(id, [header(id), start("2021-01-02T03:10:00.000Z", "turn-append"), {
      type: "event_msg", timestamp: "2021-01-02T03:11:00.000Z", payload: { type: "user_message", message: "captured prompt" },
    }]);
    await stopCodexStartupDiscovery();
    const scanning = startCodexStartupDiscovery(WORKSPACE, true);
    const boundary = await waitForCodexStartupBoundary();
    expect(boundary).not.toBeNull();
    appendFileSync(path, line({ type: "event_msg", payload: { type: "unrelated_append" } }), "utf8");
    await scanning;

    expect(payloads()).toContainEqual(expect.objectContaining({
      session_id: id, hook_event_name: "SessionStart", startup_prompt: "captured prompt",
    }));
  });

  it("rejects a truncated or replaced rollout while allowing append-only growth", async () => {
    clearEventBuffer();
    const truncated = "truncate-during-startup-scan";
    const replaced = "replace-during-startup-scan";
    const padding = Array.from({ length: 12 }, (_, i) => ({ type: "event_msg", payload: { type: `ignored-${i}` } }));
    const fullTruncated = [header(truncated), start("2021-01-02T03:10:00.000Z", "turn-truncate"), ...padding];
    const shortTruncated = [header(truncated), start("2021-01-02T03:10:00.000Z", "turn-truncate")];
    writeRollout(truncated, fullTruncated);
    writeRollout(replaced, [header(replaced), start("2021-01-02T03:10:00.000Z", "turn-replace")]);
    const replacementPath = `${pathFor(replaced)}.replacement`;
    writeFileSync(replacementPath, [header(replaced), start("2021-01-02T03:10:00.000Z", "turn-replace")].map(line).join(""), "utf8");

    await stopCodexStartupDiscovery();
    const scanning = startCodexStartupDiscovery(WORKSPACE, true);
    const boundary = await waitForCodexStartupBoundary();
    expect(boundary).not.toBeNull();
    writeFileSync(pathFor(truncated), shortTruncated.map(line).join(""), "utf8");
    rmSync(pathFor(replaced));
    renameSync(replacementPath, pathFor(replaced));
    await scanning;

    expect(payloads().some(event => [truncated, replaced].includes(String(event.session_id)) && event.hook_event_name === "SessionStart")).toBe(false);
  });

  it("does not let startup snapshots replace live input across receipt/source clock skew", async () => {
    const { applyEvent } = await import("../reducer");
    const id = "live-prompt-before-old-startup-seed";
    const graph = initialState();
    const receivedAt = Date.parse("2020-01-02T03:12:00.000Z");
    const liveSourceAt = "2021-01-02T03:12:00.000Z";
    applyEvent(graph, {
      seq: 1, receivedAt, source: "codex",
      payload: { session_id: id, provider: "codex", hook_event_name: "UserPromptSubmit", prompt: "new live input", prompt_timestamp: liveSourceAt },
    });
    const root = graph.agents.get(id)!;
    applyEvent(graph, {
      // A later source timestamp must still not beat a prompt already seen on
      // the live tail: its receipt clock is deliberately far behind source time.
      seq: 2, receivedAt: receivedAt + 1, source: "codex",
      payload: {
        session_id: id, provider: "codex", hook_event_name: "SessionStart", startup_discovery: true,
        startup_prompt: "snapshot input must not replace live input", startup_prompt_timestamp: "2021-01-02T03:13:00.000Z",
      },
    });
    expect(root.startupPrompt).toBeUndefined();
    expect(root.prompts).toHaveLength(1);
    expect(root.firstPrompt).toBe("new live input");
    expect(sessionNoteShown(root)).toMatchObject({ source: "prompt", text: "new live input" });

    applyEvent(graph, {
      seq: 3, receivedAt: receivedAt + 2, source: "codex",
      payload: { session_id: id, provider: "codex", hook_event_name: "SessionStart", startup_discovery: true, startup_prompt: "unknown-time snapshot" },
    });
    expect(root.startupPrompt).toBeUndefined();
    expect(root.prompts).toHaveLength(1);
    expect(root.firstPrompt).toBe("new live input");

    const sourceOnlyId = "startup-source-watermark-only";
    applyEvent(graph, {
      seq: 4, receivedAt: receivedAt + 3, source: "codex",
      payload: {
        session_id: sourceOnlyId, provider: "codex", hook_event_name: "SessionStart", startup_discovery: true,
        startup_prompt: "newer source snapshot", startup_prompt_timestamp: "2021-01-02T03:14:00.000Z",
      },
    });
    applyEvent(graph, {
      seq: 5, receivedAt: receivedAt + 4, source: "codex",
      payload: {
        session_id: sourceOnlyId, provider: "codex", hook_event_name: "SessionStart", startup_discovery: true,
        startup_prompt: "older source snapshot", startup_prompt_timestamp: "2021-01-02T03:13:00.000Z",
      },
    });
    expect(graph.agents.get(sourceOnlyId)?.startupPrompt?.text).toBe("newer source snapshot");
  });

  it("keeps input across a repeated explicit turn start, but clears it for a new or unidentified turn", async () => {
    clearEventBuffer();
    const repeated = "duplicate-explicit-start";
    const newTurn = "new-turn-clears-input";
    const missingTurn = "missing-turn-id-clears-input";
    const userInput = (message: string) => ({
      type: "event_msg", timestamp: "2021-01-02T03:09:00.000Z",
      payload: { type: "user_message", message },
    });
    writeRollout(repeated, [
      header(repeated), userInput("keep this current input"),
      start("2021-01-02T03:10:00.000Z", "turn-repeat"),
      start("2021-01-02T03:10:01.000Z", "turn-repeat"),
    ]);
    writeRollout(newTurn, [
      header(newTurn), userInput("do not carry into a different turn"),
      start("2021-01-02T03:10:00.000Z", "turn-old"),
      start("2021-01-02T03:11:00.000Z", "turn-new"),
    ]);
    writeRollout(missingTurn, [
      header(missingTurn), userInput("do not infer a duplicate without an id"), start(), start(),
    ]);

    await stopCodexStartupDiscovery();
    await startCodexStartupDiscovery(WORKSPACE, true);
    const events = payloads();
    const seed = (id: string) => events.find(event => event.session_id === id && event.hook_event_name === "SessionStart");
    expect(seed(repeated)).toMatchObject({ startup_prompt: "keep this current input" });
    expect(seed(newTurn)).not.toHaveProperty("startup_prompt");
    expect(seed(missingTurn)).not.toHaveProperty("startup_prompt");
  });

  it("does not seed an open turn behind a partial terminal and reads the completed record from its start", async () => {
    clearEventBuffer();
    const id = "partial-terminal-at-startup";
    const path = pathFor(id);
    const terminal = line(finish("task_complete"));
    writeFileSync(path, line(header(id)) + line(start()) + terminal.slice(0, 24), "utf8");
    await stopCodexStartupDiscovery();
    await startCodexStartupDiscovery(WORKSPACE, true);
    expect(payloads().some(event => event.session_id === id && event.hook_event_name === "SessionStart")).toBe(false);

    const timer = startCodexWatcher("");
    appendFileSync(path, terminal.slice(24), "utf8");
    await scanCodexNow();
    clearInterval(timer);
    expect(payloads().filter(event => event.session_id === id).map(event => event.hook_event_name)).toEqual(["Stop"]);
  });
});
