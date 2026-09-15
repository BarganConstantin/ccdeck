// #1009. `toolIndex` and `toolOwner` were keyed on the bare `tool_use_id`, and
// a `tool_use_id` is not unique on this board.
//
// It is unique within ONE session, because within a session one process hands
// the ids out. The deck holds every session on the machine at once, and those
// processes have nothing in common. Codex is the plain case — the watcher
// forwards the rollout's own `call_id` straight through as `tool_use_id`, and
// two Codex sessions each start counting from `call_1` — but nothing makes a
// Claude session's ids disjoint from a Codex session's either. Uniqueness was
// being assumed of two independent upstream allocators; nothing in the deck
// enforced it and nothing upstream promised it.
//
// WHAT THAT DID, driven through the shipped reducer with the issue's exact
// sequence — two sessions, both opening a call under `call_1`, then ONE
// `PostToolUse` addressed to the second:
//
//   root X-alpha state=active tools=1
//      call_1 Bash ended=true resp={"beta":"done"}
//   root X-beta  state=active tools=0
//
// Two separate wrongs in three events. Beta's `Write` is not on the board at
// all: the second `PreToolUse` looked its id up through `findTool`, found
// ALPHA's in-flight call in the global index, concluded it was seeing a
// re-delivery of a call it already had, and refreshed that call in place —
// which is the #444 rule doing exactly what it should, on a premise that was
// false. The push that would have drawn beta's call never happened, so beta's
// card showed nothing and its `toolCount` never moved. And then beta's result
// settled ALPHA's bubble: alpha's `Bash` went green, `endedAt` stamped, with
// beta's `{"beta":"done"}` in the modal as the output of a command alpha ran.
//
// No surface anywhere says either happened. A user reading the deck sees one
// session that ran a command it did not run, and another that ran nothing.
//
// THE FIX is that both maps are keyed on the session joined to the tool id, so
// the two sessions file under two keys and neither can reach the other's call.
// The `PostToolUse` resurrection scan is scoped the same way: it used to walk
// every agent on the board and settle the first `tools` entry whose bare id
// matched, which is the same collision arriving by a second door — keying the
// map alone would have left the scan as a slower path to the same wrong call.
//
// The scoping is by SESSION and not by agent, and that is deliberate. Within a
// session the index has to answer across agents: `resolveOwner` can hand a
// re-delivered `PreToolUse` to a different agent than the one that opened the
// call (#443), a root's late outcome has to find a call drawn under a subagent,
// and `blockedCall` reads the whole session's in-flight set to decide which
// subagent a permission prompt is about (#361). A subagent carries its root's
// `sessionId`, so all of that still works and only the cross-session reach is
// gone.
//
// The separator is NUL because it is the one byte neither half can carry. `:`
// and `::` are the ambiguous choices rather than the safe ones: `::` is already
// how an agent id is built, and the id the reducer synthesises for a payload
// with no `tool_use_id` puts a `:` inside the second half on purpose. The last
// case below drives a pair that `:` would have collapsed into one key.
//
// No DOM — plain node, vitest — so this drives the reducer directly.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  settlesInFlightCall,
  STALE_SESSION_MS,
  sweepStaleTools,
  toolKey,
  type GraphState,
} from "../reducer";
import type { HookEnvelope, HookPayload, ToolCall } from "../types";

const SEC = 1_000;
const MIN = 60_000;
/** Where every scenario starts, so "T0 + 5 minutes" reads as a number. */
const T0 = 1_700_000_000_000;

let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: payload.provider === "codex" ? "codex" : "hook",
    payload,
  };
  return applyEvent(state, env);
}

function fresh(): GraphState {
  seq = 0;
  return initialState();
}

/** The call this session drew under this id, or undefined. Read off the agent's
 *  own list rather than off either map, because "is it on the board" is the
 *  question the issue is about and the maps are what was wrong. */
function callOf(state: GraphState, agentId: string, toolId: string): ToolCall | undefined {
  return state.agents.get(agentId)?.tools.find(t => t.id === toolId);
}

/** The issue's sequence, to the event: two unrelated sessions, both naming
 *  their first call `call_1`, which is what two Codex rollouts do. */
function twoSessionsOneId(): GraphState {
  let state = fresh();
  state = send(state, T0, { hook_event_name: "SessionStart", session_id: "X-alpha", cwd: "/tmp/alpha" });
  state = send(state, T0 + SEC, { hook_event_name: "SessionStart", session_id: "X-beta", cwd: "/tmp/beta" });
  state = send(state, T0 + 2 * SEC, {
    hook_event_name: "PreToolUse", session_id: "X-alpha",
    tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "npm test" },
  });
  state = send(state, T0 + 3 * SEC, {
    hook_event_name: "PreToolUse", session_id: "X-beta",
    tool_name: "Write", tool_use_id: "call_1", tool_input: { file_path: "/tmp/beta/out.txt" },
  });
  return state;
}

describe("#1009 — one tool_use_id in two sessions is two calls", () => {
  it("draws both calls, because the second is not a re-delivery of the first", () => {
    const state = twoSessionsOneId();

    const alpha = callOf(state, "X-alpha", "call_1");
    const beta = callOf(state, "X-beta", "call_1");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha).not.toBe(beta);
    // The half the user loses first: beta's card had nothing on it at all, and
    // its counter agreed with the card rather than with the traffic.
    expect(state.agents.get("X-beta")!.tools.length).toBe(1);
    expect(state.agents.get("X-beta")!.toolCount).toBe(1);
    // ...and alpha's `Bash` was not quietly renamed to beta's tool by the
    // in-place refresh the #444 rule performs on a call it thinks it knows.
    expect(alpha!.name).toBe("Bash");
    expect(beta!.name).toBe("Write");
    expect(alpha!.input).toEqual({ command: "npm test" });
    expect(beta!.input).toEqual({ file_path: "/tmp/beta/out.txt" });
  });

  it("files the two under two keys, both in flight at once", () => {
    const state = twoSessionsOneId();

    expect(state.toolIndex.get(toolKey("X-alpha", "call_1"))).toBe(callOf(state, "X-alpha", "call_1"));
    expect(state.toolIndex.get(toolKey("X-beta", "call_1"))).toBe(callOf(state, "X-beta", "call_1"));
    expect(state.toolOwner.get(toolKey("X-alpha", "call_1"))).toBe("X-alpha");
    expect(state.toolOwner.get(toolKey("X-beta", "call_1"))).toBe("X-beta");
    // Two entries where the bare-id map could only ever hold one, which is the
    // arithmetic of the whole bug: the second write overwrote the first.
    expect(state.toolIndex.size).toBe(2);
    expect(state.toolOwner.size).toBe(2);
  });

  it("lands each session's result on its own bubble and on nobody else's", () => {
    let state = twoSessionsOneId();
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PostToolUse", session_id: "X-beta",
      tool_use_id: "call_1", tool_response: { beta: "done" },
    });

    const beta = callOf(state, "X-beta", "call_1")!;
    expect(beta.ok).toBe(true);
    expect(beta.endedAt).toBe(T0 + 4 * SEC);
    expect(beta.response).toEqual({ beta: "done" });

    // Alpha's command is still running, and says so. This is the assertion the
    // issue asked for: the deck must not tell a user that a command finished
    // because a different terminal finished a different command.
    const alpha = callOf(state, "X-alpha", "call_1")!;
    expect(alpha.endedAt).toBeUndefined();
    expect(alpha.ok).toBeUndefined();
    expect(alpha.response).toBeUndefined();
    expect(state.toolIndex.has(toolKey("X-alpha", "call_1"))).toBe(true);
    // Only beta's entry was released.
    expect(state.toolIndex.has(toolKey("X-beta", "call_1"))).toBe(false);
    expect(state.toolOwner.has(toolKey("X-beta", "call_1"))).toBe(false);

    // ...and alpha's own outcome, whenever it arrives, still settles alpha with
    // alpha's response. The key is not a way of losing the second half.
    state = send(state, T0 + 9 * SEC, {
      hook_event_name: "PostToolUse", session_id: "X-alpha",
      tool_use_id: "call_1", tool_response: { alpha: "8 passed" },
    });
    expect(alpha.ok).toBe(true);
    expect(alpha.response).toEqual({ alpha: "8 passed" });
    expect(beta.response).toEqual({ beta: "done" });
    expect(state.toolIndex.size).toBe(0);
    expect(state.toolOwner.size).toBe(0);
  });

  it("does not spend the pause gate's protection on another session's call", () => {
    // `settlesInFlightCall` is the payload half of the pause gate's `protect`
    // (#676): a hold at its ceiling drops events, and this is what decides which
    // ones are worth a slot. On the bare id it answered "yes" for a `PostToolUse`
    // that settles nothing of the sender's — so a busy neighbour's traffic could
    // hold a slot open for an event whose only effect, once applied, was to
    // corrupt a third session's bubble.
    const state = twoSessionsOneId();
    const settling = (session: string, id: string): HookEnvelope => ({
      seq: 99, receivedAt: T0 + 5 * SEC, source: "hook",
      payload: { hook_event_name: "PostToolUse", session_id: session, tool_use_id: id },
    });

    expect(settlesInFlightCall(state, settling("X-alpha", "call_1"))).toBe(true);
    expect(settlesInFlightCall(state, settling("X-beta", "call_1"))).toBe(true);
    // A session with nothing open under that id, however loudly the id matches.
    expect(settlesInFlightCall(state, settling("X-gamma", "call_1"))).toBe(false);
  });
});

describe("#1009 — the resurrection scan looks in one session", () => {
  /** A session whose call the stale sweep gave up on: settled, stamped failed,
   *  and dropped out of the live index — but still drawn on the card, which is
   *  exactly the state the scan was written to rescue (#436). */
  function sweptCall(): GraphState {
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "S-swept", cwd: "/repo" });
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", session_id: "S-swept",
      tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "make -j8" },
    });
    const at = T0 + SEC + STALE_SESSION_MS + MIN;
    expect(sweepStaleTools(state, at, STALE_SESSION_MS)).toBe(true);
    return state;
  }

  it("leaves a settled call in another session alone when an unrelated id matches", () => {
    let state = sweptCall();
    const swept = callOf(state, "S-swept", "call_1")!;
    expect(swept.ok).toBe(false);
    expect(swept.errorPreview).toBe("session ended before this call returned");
    expect(state.toolIndex.has(toolKey("S-swept", "call_1"))).toBe(false);

    // A different session answers ITS OWN `call_1`. It has no call open, so
    // nothing on this board is its answer. The scan used to walk every agent,
    // find the swept call by bare id and resurrect it — un-saying a failure the
    // sweep had honestly recorded, and stamping a stranger's response on it.
    state = send(state, T0 + 30 * MIN, {
      hook_event_name: "PostToolUse", session_id: "S-other",
      tool_name: "Bash", tool_use_id: "call_1", tool_response: { stdout: "not yours" },
    });

    expect(swept.ok).toBe(false);
    expect(swept.endedAt).toBe(T0 + SEC);
    expect(swept.response).toBeUndefined();
    expect(swept.errorPreview).toBe("session ended before this call returned");
    expect(swept.outcomeApplied).toBeUndefined();
  });

  it("still resurrects a call of its own session, drawn under a subagent", () => {
    // The case the scan exists for, and the reason the scope is the session and
    // not the agent. The call is drawn on the subagent; the late outcome carries
    // no agent id at all, because CC's tool-call hooks do not.
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "S-late", cwd: "/repo" });
    state = send(state, T0 + SEC, {
      hook_event_name: "SubagentStart", session_id: "S-late", agent_id: "k1", agent_type: "explorer",
    });
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PreToolUse", session_id: "S-late",
      tool_name: "Grep", tool_use_id: "call_1", tool_input: { pattern: "toolIndex" },
    });
    const sub = callOf(state, "S-late::k1", "call_1")!;

    const at = T0 + 2 * SEC + STALE_SESSION_MS + MIN;
    expect(sweepStaleTools(state, at, STALE_SESSION_MS)).toBe(true);
    expect(sub.ok).toBe(false);

    state = send(state, at + MIN, {
      hook_event_name: "PostToolUse", session_id: "S-late",
      tool_name: "Grep", tool_use_id: "call_1", tool_response: { matches: 12 },
    });

    expect(sub.ok).toBe(true);
    expect(sub.response).toEqual({ matches: 12 });
    // The sweep's guess is overturned in full, which is the contract #436 wrote.
    expect(sub.errorPreview).toBeUndefined();
    expect(sub.endedAt).toBe(at + MIN);
  });
});

describe("#1009 — the separator cannot be forged out of the halves", () => {
  it("keeps two sessions apart whose ids and tool ids differ only by where a colon sits", () => {
    // `a:b` + `c` and `a` + `b:c` are one key under `:`, and two under NUL. The
    // pair is not exotic: a Codex session id is an arbitrary string, and the id
    // this reducer synthesises when a payload carries no `tool_use_id` is
    // `${agent.id}:${toolCount}` — a colon inside the second half, on purpose.
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "a:b", cwd: "/repo" });
    state = send(state, T0 + SEC, { hook_event_name: "SessionStart", session_id: "a", cwd: "/repo" });
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PreToolUse", session_id: "a:b", tool_name: "Bash", tool_use_id: "c",
    });
    state = send(state, T0 + 3 * SEC, {
      hook_event_name: "PreToolUse", session_id: "a", tool_name: "Read", tool_use_id: "b:c",
    });

    expect(toolKey("a:b", "c")).not.toBe(toolKey("a", "b:c"));
    expect(state.toolIndex.size).toBe(2);
    expect(callOf(state, "a:b", "c")!.name).toBe("Bash");
    expect(callOf(state, "a", "b:c")!.name).toBe("Read");

    // And the halves are still two halves: a session can neither read nor settle
    // the other's call by spelling its id differently.
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PostToolUse", session_id: "a", tool_use_id: "b:c", tool_response: "mine",
    });
    expect(callOf(state, "a", "b:c")!.response).toBe("mine");
    expect(callOf(state, "a:b", "c")!.endedAt).toBeUndefined();
  });
});
