// The server's session counts against the page's, over the same recorded logs.
//
// The page counts waiting and running sessions from its reducer
// (ambient-counts.ts blockedSessions, runningSessionCount); the status frame
// counts them on the server, where a fleet machine usually has no tab
// (session-counts.mjs). The two must agree, so both are run over the same
// event logs and compared after EVERY event: waiting is blockedSessions, and
// running is the sessions with an agent active that are not waiting.
//
// The documented difference is the clocks: the server stops counting a block
// after two hours and a running session after 30 minutes of silence, and the
// page's own sweep runs on its tick, not on events. These logs are minutes
// long, so neither applies; session-counts.test.ts holds the clocks.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { blockedSessions } from "../ambient-counts";
import type { HookEnvelope } from "../types";
// @ts-expect-error — plain .mjs server module, no types
import { createSessionCounts } from "../../server/session-counts.mjs";

type P = Record<string, unknown>;
const T0 = Date.parse("2026-10-18T09:00:00Z");

/** A log: payloads three seconds apart, past every re-delivery window. */
function log(...payloads: P[]): { at: number; payload: P }[] {
  return payloads.map((payload, i) => ({ at: T0 + i * 3_000, payload }));
}

const ev = (session: string, name: string, extra: P = {}): P => ({ session_id: session, hook_event_name: name, cwd: "/work/repo", ...extra });

/** The page's two numbers, the way the frame means them. */
function pageCounts(state: GraphState) {
  const blocked = blockedSessions(state.agents.values());
  const waitingIds = new Set(blocked.map(b => state.agents.get(b.id)!.sessionId));
  const active = new Set<string>();
  for (const a of state.agents.values()) if (a.state === "active") active.add(a.sessionId);
  return { running: [...active].filter(s => !waitingIds.has(s)).length, waiting: blocked.length };
}

function mirror(events: { at: number; payload: P }[]) {
  let state = initialState();
  const counts = createSessionCounts();
  counts.markReady();
  const seen: { page: unknown; server: unknown; name: unknown }[] = [];
  events.forEach(({ at, payload }, i) => {
    const env: HookEnvelope = { seq: i + 1, receivedAt: at, source: "hook", payload } as HookEnvelope;
    state = applyEvent(state, env);
    counts.note(payload, at);
    const { running, waiting } = counts.reading(at);
    seen.push({ page: pageCounts(state), server: { running, waiting }, name: `${i}: ${payload.session_id} ${payload.hook_event_name}` });
  });
  for (const s of seen) expect(s.server, String(s.name)).toEqual(s.page);
  return seen.map(s => s.server);
}

const LOGS: Record<string, { at: number; payload: P }[]> = {
  "a turn with a permission prompt, the scans that follow it, and the idle prompt after": log(
    ev("s1", "SessionStart", { source: "startup" }),
    ev("s1", "UserPromptSubmit", { prompt: "fix the build" }),
    ev("s1", "PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm test" } }),
    ev("s1", "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }),
    ev("s1", "ModelObserved", { model: "claude-opus" }),
    ev("s1", "OutputObserved", { text: "running the tests" }),
    ev("s1", "PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_response: "ok" }),
    ev("s1", "Stop"),
    ev("s1", "Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }),
    ev("s1", "UserPromptSubmit", { prompt: "and the lint" }),
    ev("s1", "Stop"),
  ),
  "a subagent asks while its sibling keeps working": log(
    ev("s2", "UserPromptSubmit", { prompt: "review both" }),
    ev("s2", "PreToolUse", { tool_name: "Task", tool_use_id: "task1" }),
    ev("s2", "SubagentStart", { agent_id: "a1", agent_type: "reviewer" }),
    ev("s2", "PreToolUse", { tool_name: "Task", tool_use_id: "task2" }),
    ev("s2", "SubagentStart", { agent_id: "a2", agent_type: "tester" }),
    ev("s2", "PreToolUse", { agent_id: "a1", tool_name: "Bash", tool_use_id: "c1" }),
    ev("s2", "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }),
    ev("s2", "PreToolUse", { agent_id: "a2", tool_name: "Read", tool_use_id: "c2" }),
    ev("s2", "PostToolUse", { agent_id: "a2", tool_name: "Read", tool_use_id: "c2" }),
    ev("s2", "PostToolUse", { agent_id: "a1", tool_name: "Bash", tool_use_id: "c1" }),
    ev("s2", "SubagentStop", { agent_id: "a1" }),
    ev("s2", "SubagentStop", { agent_id: "a2" }),
    ev("s2", "PostToolUse", { tool_name: "Task", tool_use_id: "task1" }),
    ev("s2", "PostToolUse", { tool_name: "Task", tool_use_id: "task2" }),
    ev("s2", "Stop"),
  ),
  "a question, which a subagent's traffic does not answer and the human's next prompt does": log(
    ev("s3", "UserPromptSubmit", { prompt: "plan it" }),
    ev("s3", "PreToolUse", { tool_name: "Task", tool_use_id: "k1" }),
    ev("s3", "SubagentStart", { agent_id: "q1" }),
    ev("s3", "Notification", { notification_type: "agent_needs_input", message: "which of the three?" }),
    ev("s3", "PreToolUse", { agent_id: "q1", tool_name: "Grep", tool_use_id: "g1" }),
    ev("s3", "SessionNamed", { name: "planning" }),
    ev("s3", "UserPromptSubmit", { prompt: "all three" }),
    ev("s3", "PostToolUse", { agent_id: "q1", tool_name: "Grep", tool_use_id: "g1" }),
    ev("s3", "SubagentStop", { agent_id: "q1" }),
    ev("s3", "Stop"),
  ),
  "a background subagent outlives the turn that started it": log(
    ev("s4", "UserPromptSubmit", { prompt: "start the watcher" }),
    ev("s4", "PreToolUse", { tool_name: "Task", tool_use_id: "bg" }),
    ev("s4", "SubagentStart", { agent_id: "b1" }),
    ev("s4", "PostToolUse", { tool_name: "Task", tool_use_id: "bg" }),
    ev("s4", "Stop"),
    ev("s4", "PreToolUse", { agent_id: "b1", tool_name: "Bash", tool_use_id: "w1" }),
    ev("s4", "PostToolUse", { agent_id: "b1", tool_name: "Bash", tool_use_id: "w1" }),
    ev("s4", "SubagentStop", { agent_id: "b1" }),
  ),
  "two sessions at once, one of them Codex, and a clear between": log(
    ev("s5", "SessionStart"),
    ev("cx", "SessionStart", { provider: "codex" }),
    ev("s5", "UserPromptSubmit", { prompt: "a" }),
    ev("cx", "UserPromptSubmit", { provider: "codex", prompt: "b" }),
    ev("cx", "PreToolUse", { provider: "codex", tool_name: "shell", tool_use_id: "x1" }),
    ev("s5", "PreToolUse", { tool_name: "Edit", tool_use_id: "e1" }),
    ev("s5", "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Edit" }),
    ev("cx", "Stop", { provider: "codex" }),
    { hook_event_name: "__clear" },
    ev("s5", "PostToolUse", { tool_name: "Edit", tool_use_id: "e1" }),
    ev("s5", "Stop"),
  ),
  "a deck that joined mid-session: the first thing it hears is the prompt": log(
    ev("s6", "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Write" }),
    ev("s6", "PostToolUse", { tool_name: "Write", tool_use_id: "late" }),
    ev("s6", "Stop"),
  ),
};

describe("the server's counts and the page's, event by event", () => {
  for (const [name, events] of Object.entries(LOGS)) {
    it(name, () => { mirror(events); });
  }

  it("move the way a reader expects on the permission log", () => {
    const steps = mirror(LOGS["a turn with a permission prompt, the scans that follow it, and the idle prompt after"]);
    expect(steps.map(s => `${(s as any).running}/${(s as any).waiting}`)).toEqual([
      "1/0", "1/0", "1/0", "0/1", "0/1", "0/1", "1/0", "0/0", "0/0", "1/0", "0/0",
    ]);
  });

  it("agree on all the logs replayed at once, as a ring holds them", () => {
    const all = Object.values(LOGS).flat().map(e => ({ ...e })).sort((a, b) => a.at - b.at);
    // Interleaved by time, as several sessions arrive at one deck.
    let state = initialState();
    const counts = createSessionCounts();
    counts.seed(all.map((e, i) => ({ seq: i + 1, receivedAt: e.at, payload: e.payload })));
    counts.markReady();
    all.forEach((e, i) => { state = applyEvent(state, { seq: i + 1, receivedAt: e.at, source: "hook", payload: e.payload } as HookEnvelope); });
    const last = all[all.length - 1].at;
    const { running, waiting } = counts.reading(last);
    expect({ running, waiting }).toEqual(pageCounts(state));
  });
});
