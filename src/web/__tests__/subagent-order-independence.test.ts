// #1023. The reducer's first line promises "same events in any order = same
// end state". `SubagentStart` and `SubagentStop` did not have that property,
// and the losing order made the whole session unevictable for the life of the
// tab.
//
// `SubagentStop` looked the node up and refused to create one — right, because
// a stray `parent_tool_use_id` on somebody else's terminal event must not
// conjure a subagent at end-of-life — and then threw the fact away. A Stop that
// overtook its own Start was therefore a no-op, and the Start behind it created
// the node `active`, pushed its key onto the attribution stack, and left it
// there with no second Stop coming.
//
// ── the two orders, through the shipped reducer ─────────────────────────────
//
//   --- Start then Stop
//   [{"id":"S2::A","kind":"subagent","state":"done",
//     "startedAt":3000,"endedAt":4000}]
//   stack: [] | pruneOldAgents(cap 0, grace 0): true | agents left: 1
//
//   --- Stop then Start          (the same two events, delivered the other way)
//   [{"id":"S2::A","kind":"subagent","state":"active","startedAt":3000}]
//   stack: [["S2",["A"]]] | pruneOldAgents: false
//                         | pruneDoneSessions: false | agents left: 2
//
// ── why the race is ordinary rather than exotic ─────────────────────────────
//
// The two hook POSTs are separate processes, and each spends up to 800 ms in
// `prove()`'s two-attempt challenge before it posts. A fast subagent's Stop
// overtaking its Start needs no unusual conditions at all. A re-delivered
// `SubagentStart` landing after its Stop — several decks appending to one
// events.jsonl, a hook retry, a replayed log region — reaches the identical end
// state by a different road.
//
// ── what it costs ──────────────────────────────────────────────────────────
//
// The node is `active` with no `endedAt` and nothing left to settle it.
// `pruneOldAgents` needs `done` and `pruneDoneSessions` needs nothing live, so
// THE WHOLE SESSION stops being evictable; `runningSessionCount` counts it, so
// the tab strip and the favicon claim work in progress with nothing behind it;
// and the stranded stack key has `resolveOwner` hand every unkeyed Pre/
// PostToolUse of the next turn to a subagent that finished. That last part is
// the damage `pushActive` was hardened against in #675 — that fix covered the
// stack and this order walks straight past it, because the key genuinely is not
// on the stack when the Start arrives.
//
// ── the rule, and why it is a clock ─────────────────────────────────────────
//
// Reviving a `done` node is a REAL requirement the rest of the time: CC reuses
// an `agent_id` for a second Task and the node must come back fully. Nothing in
// either payload distinguishes that from a re-delivery, so this handler now does
// what `promptAlreadyRecorded`, `Notification`'s `Math.min(prev.since, now)` and
// `outcomeApplied` all do with the same ambiguity — it puts a clock on it. A
// Stop that arrives first leaves a tombstone the Start reads; a Start inside the
// re-delivery window of the ending it already has is refused. Outside that
// window nothing changes, and `subagent-start-idempotent.test.ts` pins the
// second Task minutes later still re-arming.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, type GraphState } from "../reducer";
import { runningSessionCount } from "../ambient-counts";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-order";
const SUB = `${SESSION}::A`;
const SEC = 1_000;
const MIN = 60_000;
const T0 = 1_700_000_000_000;

let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: "hook",
    payload: { session_id: SESSION, cwd: "/repo", ...payload },
  };
  return applyEvent(state, env);
}

/** A session mid-turn, before anything is said about a subagent. */
function turn(): GraphState {
  seq = 0;
  let state = send(initialState(), T0, { hook_event_name: "SessionStart" });
  return send(state, T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "dispatch a Task" });
}

/** The subagent's own Start and Stop, each carrying the stamp it was written
 *  with, delivered in whichever order the wire chose. */
const START = (s: GraphState) => send(s, T0 + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "explorer" });
const STOP = (s: GraphState) => send(s, T0 + 3 * SEC, { hook_event_name: "SubagentStop", agent_id: "A" });

function startThenStop(): GraphState { return STOP(START(turn())); }
function stopThenStart(): GraphState { return START(STOP(turn())); }

/** Everything about the node that a card, a pruner or the attribution stack can
 *  read, so the comparison below is of end states rather than of one field. */
function shape(state: GraphState) {
  const sub = state.agents.get(SUB) as AgentNodeData | undefined;
  return {
    exists: sub != null,
    state: sub?.state,
    startedAt: sub?.startedAt,
    endedAt: sub?.endedAt,
    parentId: sub?.parentId,
    childCount: state.agents.get(SESSION)?.childCount,
    stack: state.activeSubagentStack.get(SESSION),
    running: runningSessionCount(state.agents.values()),
  };
}

/** The root's own turn ends too. Everything the session has is now settled, or
 *  ought to be — which is the question the two ambient counts ask. */
function thenTheTurnEnds(state: GraphState): GraphState {
  return send(state, T0 + 4 * SEC, { hook_event_name: "Stop" });
}

describe("a subagent's Start and Stop reach the same end state in either order", () => {
  it("agrees on every field either order can be read from", () => {
    expect(shape(stopThenStart())).toEqual(shape(startThenStop()));
  });

  it("settles the node at the stamps the two events carried", () => {
    const sub = stopThenStart().agents.get(SUB)!;
    expect(sub.state).toBe("done");
    expect(sub.startedAt).toBe(T0 + 2 * SEC);
    expect(sub.endedAt).toBe(T0 + 3 * SEC);
  });

  it("leaves the session evictable, which the losing order used to prevent for ever", () => {
    // `pruneOldAgents` needs `done`; with the node stuck `active` neither pruner
    // could ever spend this session, whatever the cap.
    const state = stopThenStart();
    expect(pruneOldAgents(state, T0 + 60 * MIN, /*cap*/ 0, /*graceMs*/ 0)).toBe(true);
    expect(state.agents.has(SUB)).toBe(false);
  });

  it("stops the tab strip and the favicon claiming work that is over", () => {
    // `runningSessionCount` counts a session with ANY active agent in it, so the
    // stranded node kept this session on the strip and in the favicon's badge
    // after its turn had ended and nothing was left running.
    expect(runningSessionCount(thenTheTurnEnds(stopThenStart()).agents.values())).toBe(0);
  });

  it("does not strand the key that steals the root's next turn", () => {
    // The stranded key is what `resolveOwner` reads for every event carrying no
    // agent_id, which is all the root's own prompt and tool traffic.
    let state = stopThenStart();
    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();
    state = send(state, T0 + 4 * SEC, { hook_event_name: "UserPromptSubmit", prompt: "root turn two" });
    state = send(state, T0 + 5 * SEC, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" });
    expect(state.agents.get(SESSION)!.tools.map(t => t.name)).toEqual(["Read"]);
    expect(state.agents.get(SUB)!.tools).toHaveLength(0);
  });

  it("closes the session once nothing is live in it", () => {
    const state = thenTheTurnEnds(stopThenStart());
    expect(pruneDoneSessions(state, T0 + 60 * MIN, /*cap*/ 0, /*graceMs*/ 0)).toBe(true);
    expect(state.agents.size).toBe(0);
  });
});

describe("a Stop nobody can act on yet is remembered, not acted on", () => {
  it("manifests no node on its own", () => {
    // The reason `lookupSubagent` refuses to create one has not changed: a stray
    // `parent_tool_use_id` on somebody else's terminal event must not conjure a
    // subagent. The tombstone records the fact without drawing anything.
    const state = STOP(turn());
    expect(state.agents.has(SUB)).toBe(false);
    expect(state.agents.get(SESSION)!.childCount).toBe(0);
  });

  it("is forgotten by the time a genuinely later Start could mean a new subagent", () => {
    // Past the window the two events cannot be one subagent's life, so the Start
    // is what it looks like: a Task beginning now, and still running.
    let state = STOP(turn());
    state = send(state, T0 + 20 * MIN, { hook_event_name: "SubagentStart", agent_id: "A" });
    const sub = state.agents.get(SUB)!;
    expect(sub.state).toBe("active");
    expect(sub.endedAt).toBeUndefined();
    expect(state.activeSubagentStack.get(SESSION)).toEqual(["A"]);
  });

  it("does not leak a tombstone for a subagent that never appears", () => {
    let state = STOP(turn());
    state = send(state, T0 + 20 * MIN, { hook_event_name: "SubagentStop", agent_id: "B" });
    expect(state.subagentTombstones.size).toBe(1);
    expect([...state.subagentTombstones.keys()]).toEqual([`${SESSION}::B`]);
  });

  it("keeps one session's key from settling another session's subagent", () => {
    let state = STOP(turn());
    const other: HookEnvelope = {
      seq: ++seq,
      receivedAt: T0 + 2 * SEC,
      source: "hook",
      payload: { session_id: "sess-other", hook_event_name: "SubagentStart", agent_id: "A" },
    };
    state = applyEvent(state, other);
    expect(state.agents.get("sess-other::A")!.state).toBe("active");
  });
});

describe("a Stop delivered twice does not lengthen the subagent's life", () => {
  it("keeps the ending at the moment it happened", () => {
    // Left as `= now`, the second copy re-stamped `endedAt` forward — 3000 to
    // 9000 in the run #1023 filed — which moves the node to the back of
    // `pruneOldAgents`' eviction queue and lengthens the duration printed on its
    // card, for a subagent that did no more work.
    let state = startThenStop();
    state = send(state, T0 + 9 * SEC, { hook_event_name: "SubagentStop", agent_id: "A" });
    expect(state.agents.get(SUB)!.endedAt).toBe(T0 + 3 * SEC);
  });

  it("settles a second Task at the second Task's own ending", () => {
    // `SubagentStart` clears `endedAt` when it re-arms, so the earliest-wins rule
    // above has nothing of the first life to be earlier than.
    let state = startThenStop();
    state = send(state, T0 + 20 * MIN, { hook_event_name: "SubagentStart", agent_id: "A" });
    state = send(state, T0 + 21 * MIN, { hook_event_name: "SubagentStop", agent_id: "A" });
    expect(state.agents.get(SUB)!.endedAt).toBe(T0 + 21 * MIN);
  });
});
