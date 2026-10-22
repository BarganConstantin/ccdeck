// `ccdeck sessions` (#2183) says which session waits on a human. The canvas
// already decides that, in src/web/waiting-block.ts, and the server cannot
// import TypeScript bundled for the browser — so session-summary.mjs holds a
// MIRROR of the rule, the way block-notify.mjs mirrors sound.ts.
//
// A mirror is only one as long as something checks it. This drives the real
// reducer and the summary over the same streams, event by event, and asserts
// they agree on the block after every one: raised, kept, cleared, and by whom.
// The streams are the cases waiting-block.ts was written for — a subagent's
// traffic that must NOT clear the root's prompt (#361), the transcript scans
// that arrive while a badge is up (#1444), idle that any traffic falsifies.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
// @ts-expect-error — plain .mjs module, no types
const { summarizeSessions, STALE_SESSION_MS: SERVER_STALE } = await import("../../server/session-summary.mjs");
import { STALE_SESSION_MS } from "../board-sweeps";

const SID = "sess-mirror";
const T0 = 2_000_000;

// `at` is when the event reached the deck, as an offset from T0, for streams
// whose order on the wire is the point; otherwise one a second.
type Step = Partial<HookPayload> & { hook_event_name: string; at?: number };

/** Fold `steps` through both, asserting after every event that the kind of
 *  block — or its absence — is the same, and with `turns` that the session is
 *  working or not by both readings. */
function agreeThroughout(steps: Step[], { turns = false } = {}): string[] {
  let state = initialState();
  const envs: HookEnvelope[] = [];
  const kinds: string[] = [];
  steps.forEach(({ at, ...step }, i) => {
    const receivedAt = T0 + (at ?? i * 1000);
    const env = { seq: i + 1, receivedAt, source: "hook", payload: { session_id: SID, cwd: "/r/proj", ...step } } as HookEnvelope;
    envs.push(env);
    state = applyEvent(state, env);
    const root = state.agents.get(SID);
    const row = summarizeSessions(envs, { now: receivedAt }).find((s: { id: string }) => s.id === SID);
    const server = row?.waiting?.kind ?? null;
    expect(server, `after #${i + 1} ${step.hook_event_name}`).toBe(root?.waiting?.kind ?? null);
    if (turns) expect(row?.state, `turn after #${i + 1} ${step.hook_event_name}`).toBe(root?.state === "active" ? "working" : "idle");
    kinds.push(String(server));
  });
  return kinds;
}

const PERMISSION = { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" };
const ASKED = { hook_event_name: "Notification", notification_type: "agent_needs_input", message: "Claude needs your input: which one?" };
const IDLE = { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" };

describe("the waiting rule is the canvas's own", () => {
  it("a root's permission prompt, answered by its own tool result", () => {
    expect(agreeThroughout([
      { hook_event_name: "SessionStart" },
      { hook_event_name: "UserPromptSubmit", prompt: "go" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
      PERMISSION,
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" },
    ])).toEqual(["null", "null", "null", "permission", "null"]);
  });

  it("a subagent's prompt, left standing by a sibling and cleared by the subagent itself (#361)", () => {
    expect(agreeThroughout([
      { hook_event_name: "UserPromptSubmit", prompt: "fan out" },
      { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "task-a" },
      { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "task-b" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a-1", agent_id: "agent-a" },
      PERMISSION,
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "b-1", agent_id: "agent-b" },
      { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "b-1", agent_id: "agent-b" },
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "a-1", agent_id: "agent-a" },
    ])).toEqual(["null", "null", "null", "null", "permission", "permission", "permission", "null"]);
  });

  it("a question, kept through the transcript scans and answered by the next prompt (#1444)", () => {
    expect(agreeThroughout([
      { hook_event_name: "UserPromptSubmit", prompt: "plan it" },
      ASKED,
      { hook_event_name: "ModelObserved", model: "claude-opus-4-1" },
      { hook_event_name: "OutputObserved" },
      { hook_event_name: "SessionNamed", sessionTitle: "Plan" },
      { hook_event_name: "UserPromptSubmit", prompt: "all three" },
    ])).toEqual(["null", "asked", "asked", "asked", "asked", "null"]);
  });

  it("idle, which any traffic falsifies — a subagent's included", () => {
    expect(agreeThroughout([
      { hook_event_name: "UserPromptSubmit", prompt: "go" },
      { hook_event_name: "Stop" },
      IDLE,
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "x", agent_id: "late-agent" },
    ])).toEqual(["null", "null", "idle", "null"]);
  });

  it("a background subagent's prompt, raised after the root's turn ended and cleared by its own result", () => {
    // The root's `Stop` settles the root's calls and leaves the subagent's in
    // flight, so the prompt that follows is the subagent's — and only its own
    // traffic answers it.
    expect(agreeThroughout([
      { hook_event_name: "UserPromptSubmit", prompt: "fan out" },
      { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "task-a" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a-1", agent_id: "agent-a" },
      { hook_event_name: "Stop" },
      PERMISSION,
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "a-1", agent_id: "agent-a" },
    ])).toEqual(["null", "null", "null", "null", "permission", "null"]);
  });

  it("a block the recovery scan finds standing after a restart, left standing", () => {
    expect(agreeThroughout([
      { hook_event_name: "UserPromptSubmit", prompt: "go" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
      PERMISSION,
      { hook_event_name: "ClaudeSessionRecovered", provider: "claude", recovery_active: true, snapshot_observed_at: T0 + 60_000 },
      { hook_event_name: "ClaudeSessionRecovered", provider: "claude", recovery_active: true, snapshot_observed_at: T0 + 61_000 },
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" },
    ])).toEqual(["null", "null", "permission", "permission", "permission", "null"]);
  });

  it("a session the recovery scan finds closed, ended", () => {
    const envs = [
      { hook_event_name: "UserPromptSubmit", prompt: "go" },
      { hook_event_name: "ClaudeSessionRecovered", provider: "claude", recovery_active: false, recovery_session_closed: true, snapshot_observed_at: T0 + 60_000 },
    ].map((payload, i) => ({ seq: i + 1, receivedAt: T0 + i * 1000, source: "hook", payload: { session_id: SID, ...payload } }) as HookEnvelope);
    const state = envs.reduce((s, e) => applyEvent(s, e), initialState());
    expect(state.agents.get(SID)?.closedAt).toBeDefined();
    expect(summarizeSessions(envs, { now: T0 + 2000 })[0].state).toBe("ended");
  });

  it("a Stop that is a copy of the last one, or older than the turn now running, ends nothing", () => {
    agreeThroughout([
      { hook_event_name: "UserPromptSubmit", prompt: "one", at: 0 },
      { hook_event_name: "Stop", at: 5000 },
      { hook_event_name: "UserPromptSubmit", prompt: "two", at: 6000 },
      // a fresh copy of turn one's ending, inside the re-delivery window
      { hook_event_name: "Stop", at: 6500 },
      // a replayed copy, stamped when the original was
      { hook_event_name: "Stop", at: 5000 },
      // turn two's own
      { hook_event_name: "Stop", at: 20_000 },
    ], { turns: true });
  });

  it("a copy of the same prompt, and a kind nobody has seen", () => {
    expect(agreeThroughout([
      { hook_event_name: "UserPromptSubmit", prompt: "go" },
      PERMISSION,
      PERMISSION,
      { hook_event_name: "Notification", notification_type: "something_new", message: "?" },
      { hook_event_name: "Stop" },
    ])).toEqual(["null", "permission", "permission", "permission", "null"]);
  });
});

describe("what the summary adds", () => {
  const env = (i: number, payload: Record<string, unknown>, at = T0 + i * 1000) =>
    ({ seq: i, receivedAt: at, source: "hook", payload });

  it("one word per session, waiting first", () => {
    const rows = summarizeSessions([
      env(1, { session_id: "a", cwd: "/r/a", hook_event_name: "UserPromptSubmit" }),
      env(2, { session_id: "b", cwd: "/r/b", hook_event_name: "UserPromptSubmit" }),
      env(3, { session_id: "b", hook_event_name: "Stop" }),
      env(4, { session_id: "c", cwd: "/r/c", hook_event_name: "UserPromptSubmit", provider: "codex" }),
      env(5, { session_id: "d", cwd: "/r/d", hook_event_name: "UserPromptSubmit" }),
      env(6, { session_id: "d", ...PERMISSION }),
      env(7, { session_id: "e", cwd: "/r/e", hook_event_name: "SessionStart" }),
      env(8, { session_id: "e", hook_event_name: "SessionEnd" }),
    ], { now: T0 + 9000 });
    expect(rows.map((r: { id: string; state: string }) => `${r.id}:${r.state}`))
      .toEqual(["d:waiting", "c:working", "a:working", "b:idle", "e:ended"]);
    expect(rows.find((r: { id: string }) => r.id === "c").provider).toBe("codex");
    expect(rows[0]).toMatchObject({ project: "d", waiting: { kind: "permission", message: PERMISSION.message } });
  });

  it("takes a session silent for the canvas's stale window to be gone, block and all", () => {
    expect(SERVER_STALE).toBe(STALE_SESSION_MS);
    const rows = summarizeSessions([
      env(1, { session_id: "a", cwd: "/r/a", hook_event_name: "UserPromptSubmit" }, T0),
      env(2, { session_id: "a", ...PERMISSION }, T0 + 1),
    ], { now: T0 + STALE_SESSION_MS + 10 });
    expect(rows[0]).toMatchObject({ state: "ended", waiting: null });
  });

  it("starts over at a clear, as the canvas does", () => {
    const rows = summarizeSessions([
      env(1, { session_id: "a", hook_event_name: "UserPromptSubmit" }),
      env(2, { hook_event_name: "__clear" }),
      env(3, { session_id: "b", hook_event_name: "SessionStart" }),
    ], { now: T0 + 4000 });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["b"]);
  });

  it("names a session by its title once the deck has read one, and by its folder until then", () => {
    const rows = summarizeSessions([
      env(1, { session_id: "a", cwd: "C:\\src\\shop", hook_event_name: "UserPromptSubmit", model: "claude-sonnet-4-5" }),
      env(2, { session_id: "a", hook_event_name: "SessionNamed", sessionTitle: "Fix the cart", sessionName: null }),
    ], { now: T0 + 3000 });
    expect(rows[0]).toMatchObject({ project: "shop", name: "Fix the cart", model: "claude-sonnet-4-5" });
  });
});
