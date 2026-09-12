// A tool call whose result never reached the deck pulsed in-flight for ever.
//
// The hook POSTs are fire-and-forget. When a call finishes while this deck is
// not listening — restarted, or killed by the very command being reported — the
// PostToolUse goes into a dead socket and is gone. `sweepStaleTools` (#436) is
// the existing answer to a lost outcome and it cannot reach this one: its clock
// is the SESSION's silence, on the ninety-minute window the file defends as
// "presumed dead", and a session that carried on working after the lost event
// never goes silent at all. So the call sat in-flight until the tab was
// reloaded, on a card whose work had finished hours before.
//
// ── what the real log says ──────────────────────────────────────────────────
//
// 979 Claude calls with a PreToolUse on this machine's events.jsonl, 977 of them
// answered. All 7 unanswered were Bash, and 5 of those 7 were commands that had
// just stopped the deck themselves (`pkill -f bin/agent-dag.js`, `kill <pid>`);
// the other two spanned a restart. 0.7% of calls, and every one of them stuck.
//
// ── the evidence the clock could not supply ─────────────────────────────────
//
// `Stop` is the root's own turn boundary, so a call the ROOT made and is still
// holding cannot be running once it lands. Measured on the same log before the
// rule was written: 75 Stops, 6 root calls open across one of them, and 0 of
// those 6 ever answered afterwards. Six settle, nothing that was alive is
// touched, and there is no false positive to trade against.
//
// ── what it must not touch ──────────────────────────────────────────────────
//
// The comment this rule sits under records the case that makes a broader rule
// wrong: background subagents outlive the turn that dispatched them, 65 times
// out of 65 on that log, going on to emit their own Pre/PostToolUse for a
// median of 606s afterwards. Their calls are genuinely still running at `Stop`.
// They carry an agent id and live on their own node, so the rule walks the root
// node and nothing else — and the tests below pin that boundary from both
// sides.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-turn-end";
const CWD = "/repo";
const SEC = 1_000;
const T0 = 1_700_000_000_000;

let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: "hook",
    payload: { session_id: SESSION, cwd: CWD, ...payload },
  };
  return applyEvent(state, env);
}

/** A session that has started one root `Bash` and said nothing since — the
 *  shape every foreground command has while it runs. */
function running(tool = "Bash"): GraphState {
  seq = 0;
  let state = send(initialState(), T0 - 10 * SEC, { hook_event_name: "SessionStart", provider: "claude" });
  state = send(state, T0 - 5 * SEC, { hook_event_name: "UserPromptSubmit", prompt: "restart the deck", provider: "claude" });
  return send(state, T0, { hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: "t1", provider: "claude" });
}

const rootOf = (s: GraphState) => [...s.agents.values()].find(a => a.kind === "root")!;
const call = (s: GraphState, id = "t1") => rootOf(s).tools.find(t => t.id === id);

describe("a turn that ended is not still holding its own tool call", () => {
  it("leaves the call in flight while the turn is still going", () => {
    const state = running();
    expect(call(state)!.endedAt).toBeUndefined();
    expect(call(state)!.ok).toBeUndefined();
  });

  it("settles it when the turn ends without a result", () => {
    let state = running();
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    const t = call(state)!;
    expect(t.endedAt).toBe(T0 + 30 * SEC);
    expect(t.ok).toBe(false);
  });

  it("says what was seen and never why", () => {
    let state = running();
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    // The deck knows the turn ended with no result. It does not know whether
    // the tool failed or succeeded into a socket that had gone, and naming a
    // cause that never happened is the expensive kind of wrong.
    expect(call(state)!.errorPreview).toBe("the turn ended before this call returned");
    expect(call(state)!.errorPreview).not.toMatch(/fail|error|crash/i);
  });

  it("says the other thing when the deck knows it dropped events", () => {
    let state = running();
    const t = call(state)!;
    t.outcomeGap = true;
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(call(state)!.errorPreview).toMatch(/events were dropped/);
  });

  it("does the same at the end of a session", () => {
    let state = running();
    state = send(state, T0 + 30 * SEC, { hook_event_name: "SessionEnd", provider: "claude" });
    expect(call(state)!.endedAt).toBe(T0 + 30 * SEC);
  });

  it("never overwrites a call that already had its answer", () => {
    let state = running();
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1",
      tool_response: "done", provider: "claude",
    });
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    const t = call(state)!;
    expect(t.endedAt).toBe(T0 + 2 * SEC);
    expect(t.ok).toBe(true);
    expect(t.errorPreview).toBeUndefined();
  });

  it("lets a late answer un-say it", () => {
    // The sweep's own un-reap, which this must not break: the id is dropped
    // from the live index, and the PostToolUse handler finds the call by
    // scanning its owner instead.
    let state = running();
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(call(state)!.ok).toBe(false);
    state = send(state, T0 + 40 * SEC, {
      hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1",
      tool_response: "it did finish", provider: "claude",
    });
    const t = call(state)!;
    expect(t.ok).toBe(true);
    expect(t.errorPreview).toBeUndefined();
  });

  it("drops the settled id from the live index", () => {
    let state = running();
    expect(state.toolIndex.has("t1")).toBe(true);
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(state.toolIndex.has("t1")).toBe(false);
    expect(state.toolOwner.has("t1")).toBe(false);
  });

  it("settles every call the root was holding, not just the first", () => {
    let state = running();
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2", provider: "claude",
    });
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(call(state, "t1")!.endedAt).toBe(T0 + 30 * SEC);
    expect(call(state, "t2")!.endedAt).toBe(T0 + 30 * SEC);
  });
});

describe("a background subagent outlives the turn that dispatched it", () => {
  /** A root that dispatched a subagent, which is still working when the root's
   *  own turn ends — the 65-out-of-65 case the rule must not touch. */
  function withSubagent(): GraphState {
    seq = 0;
    let state = send(initialState(), T0 - 10 * SEC, { hook_event_name: "SessionStart", provider: "claude" });
    state = send(state, T0 - 5 * SEC, { hook_event_name: "UserPromptSubmit", prompt: "go", provider: "claude" });
    state = send(state, T0 - 4 * SEC, {
      hook_event_name: "SubagentStart", agent_id: "sub-1", parent_tool_use_id: "task-1", provider: "claude",
    });
    return send(state, T0, {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "s1",
      agent_id: "sub-1", parent_tool_use_id: "task-1", provider: "claude",
    });
  }

  const subCall = (s: GraphState) => {
    for (const a of s.agents.values()) {
      if (a.kind === "root") continue;
      const t = a.tools.find(x => x.id === "s1");
      if (t) return t;
    }
    return undefined;
  };

  it("keeps the subagent's own call running when the root's turn ends", () => {
    let state = withSubagent();
    expect(subCall(state)).toBeTruthy();
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    const t = subCall(state)!;
    expect(t.endedAt, "a background subagent's call is still genuinely running").toBeUndefined();
    expect(t.ok).toBeUndefined();
  });

  it("still answers that call normally afterwards", () => {
    let state = withSubagent();
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    state = send(state, T0 + 600 * SEC, {
      hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "s1",
      agent_id: "sub-1", parent_tool_use_id: "task-1", tool_response: "ok", provider: "claude",
    });
    const t = subCall(state)!;
    expect(t.endedAt).toBe(T0 + 600 * SEC);
    expect(t.ok).toBe(true);
  });
});
