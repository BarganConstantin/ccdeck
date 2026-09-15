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
import { applyEvent, initialState, toolKey, type GraphState } from "../reducer";
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
    expect(state.toolIndex.has(toolKey(SESSION, "t1"))).toBe(true);
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(state.toolIndex.has(toolKey(SESSION, "t1"))).toBe(false);
    expect(state.toolOwner.has(toolKey(SESSION, "t1"))).toBe(false);
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

// ── #1022, part one: the sweep was blind in the one configuration it claimed
// ── safety from ─────────────────────────────────────────────────────────────
//
// The rule above walked `root.tools` and nothing else, and justified that with
// "they carry an agent id and live on their own node". The first half is true
// of a subagent's calls. The second half is not true of the ROOT's.
//
// While a Task is live the root's own tool calls carry no `agent_id` at all,
// and `resolveOwner`'s stack heuristic hands an unkeyed event to the deepest
// live subagent — the right call for drawing it on the canvas, and the reason
// `root.tools` is EMPTY at exactly the moment the sweep runs. The same log that
// measured 65 background subagents still open across a `Stop` measured them
// open across 65 of 65, so this was not an edge: for every session with a Task
// running at the turn boundary the sweep walked an empty list and the lost
// `Bash` it exists to settle went on pulsing in flight, hours after the work
// had finished, exactly as it did before the rule was written. `sweepStaleTools`
// cannot reach it either — its clock is the SESSION's silence, and a background
// subagent keeps the session loud, which is the whole reason `Stop` was given
// this sweep in the first place.
//
// Driven through the shipped reducer before the fix — SessionStart,
// UserPromptSubmit, SubagentStart, an UNKEYED root PreToolUse, Stop:
//
//   [{"id":"S1","kind":"root","state":"done","endedAt":5000,"tools":[]},
//    {"id":"S1::bg","kind":"subagent","state":"active",
//     "tools":[{"id":"k1","name":"Bash"}]}]      ← no endedAt, ever
//
// The same sequence without the SubagentStart settled `k1` normally, which is
// what makes it the sweep's own blind spot rather than a rule nobody wrote.
//
// The discriminator is `explicitSubagentId` — what the PAYLOAD said, recorded
// on the call for precisely this kind of question (#361 reads it for the same
// reason) — rather than which node the call happened to be drawn on.
describe("a live Task does not hide the root's own call from the turn boundary", () => {
  /** A root that dispatched a background Task and then made a tool call of its
   *  own. The call carries no `agent_id`, because CC's tool hooks do not put one
   *  on the root's traffic, so the stack heuristic draws it on the subagent. */
  function rootCallUnderLiveTask(): GraphState {
    seq = 0;
    let state = send(initialState(), T0 - 10 * SEC, { hook_event_name: "SessionStart", provider: "claude" });
    state = send(state, T0 - 5 * SEC, { hook_event_name: "UserPromptSubmit", prompt: "build it", provider: "claude" });
    state = send(state, T0 - 4 * SEC, { hook_event_name: "SubagentStart", agent_id: "bg", provider: "claude" });
    return send(state, T0, {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "k1",
      tool_input: { command: "npm run build" }, provider: "claude",
    });
  }

  const anywhere = (s: GraphState, id: string) => {
    for (const a of s.agents.values()) {
      const t = a.tools.find(x => x.id === id);
      if (t) return t;
    }
    return undefined;
  };

  it("draws the unkeyed call on the subagent, which is what made this invisible", () => {
    const state = rootCallUnderLiveTask();
    expect(rootOf(state).tools).toHaveLength(0);
    expect(anywhere(state, "k1")!.explicitSubagentId).toBeUndefined();
  });

  it("settles it at the turn boundary anyway", () => {
    let state = rootCallUnderLiveTask();
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    const t = anywhere(state, "k1")!;
    expect(t.endedAt).toBe(T0 + 30 * SEC);
    expect(t.ok).toBe(false);
    expect(t.errorPreview).toBe("the turn ended before this call returned");
  });

  it("reaches the same end state as the same turn with no Task in it", () => {
    let withTask = rootCallUnderLiveTask();
    withTask = send(withTask, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    let control = running();
    control = send(control, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    const a = anywhere(withTask, "k1")!;
    const b = call(control, "t1")!;
    expect([a.endedAt, a.ok, a.errorPreview]).toEqual([b.endedAt, b.ok, b.errorPreview]);
  });

  it("leaves the subagent's own keyed call alone, which is the boundary this must not cross", () => {
    // Both calls now sit on the same node. Only the payload tells them apart.
    let state = rootCallUnderLiveTask();
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "s1",
      agent_id: "bg", provider: "claude",
    });
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(anywhere(state, "k1")!.endedAt).toBe(T0 + 30 * SEC);
    expect(anywhere(state, "s1")!.endedAt, "a background subagent's call is still genuinely running").toBeUndefined();
  });

  it("leaves a keyed call alone even when it was drawn on the root by fallback", () => {
    // A subagent whose `SubagentStart` was lost: `resolveOwner` refuses to
    // manifest a node for it, so the call lands on the root — while the payload
    // says plainly that it belongs to a subagent, whose work outlives this
    // boundary. The old rule swept it because of where it had been drawn.
    let state = running();
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "g1",
      agent_id: "never-announced", provider: "claude",
    });
    expect(rootOf(state).tools.map(t => t.id)).toContain("g1");
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(call(state, "t1")!.endedAt).toBe(T0 + 30 * SEC);
    expect(call(state, "g1")!.endedAt).toBeUndefined();
  });

  it("still abstains on Codex, where a missing result means not-yet-approved", () => {
    seq = 0;
    let state = send(initialState(), T0 - 10 * SEC, { hook_event_name: "SessionStart", provider: "codex" });
    state = send(state, T0 - 4 * SEC, { hook_event_name: "SubagentStart", agent_id: "bg", provider: "codex" });
    state = send(state, T0, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "k1", provider: "codex" });
    state = send(state, T0 + 30 * SEC, { hook_event_name: "Stop", provider: "codex" });
    expect(anywhere(state, "k1")!.endedAt).toBeUndefined();
  });
});

// ── #1022, part two: `Stop` was the one terminal handler with no re-delivery
// ── guard ───────────────────────────────────────────────────────────────────
//
// `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification` and
// `pushActive` all carry one, each with a comment saying duplicates are routine
// on this wire. `Stop` had none, and everything it does is destructive: it
// re-stamps `endedAt`, runs the sweep above, and drops the attribution stack.
//
// The damage needs the next turn to have already started, and 223 of 250 `Stop`s
// on this machine's logs were followed by another prompt on the same session.
// Observed by driving turn one's `Stop` into the shipped reducer a second time
// while turn two was running:
//
//   --- mid turn two
//   [{"id":"S3","state":"active","tools":[{"id":"b1","name":"Bash"}]}]
//   --- after the re-delivered Stop
//   [{"id":"S3","state":"done","endedAt":8000,"tools":[
//     {"id":"b1","ok":false,"errorPreview":"the turn ended before this call
//      returned"}]}]
//
// A live `npm test` drawn red, the card flipped to `done`, the error count up
// and the stack dropped mid-turn — healing only when `b1`'s real `PostToolUse`
// lands, which for that command is four minutes.
//
// WHAT THE GUARD CAN AND CANNOT SEE. A `Stop` carries nothing identifying the
// turn it ended, so the clock is the only handle, and it recognises the two
// shapes a duplicate actually arrives in: a replayed copy carrying the original
// writer's `receivedAt`, and a hook retry stamped fresh inside the 1500ms cap on
// the hook's own fan-out. A copy landing later than that is — on the wire and in
// the payload — identical to a genuine turn-two `Stop`, and is treated as one.
// Both halves of the duplicate test are required so that a `Stop` hook which
// blocks and lets the agent carry on, emitting a second genuine `Stop` moments
// later with no prompt in between, still ends the turn.
describe("a turn ending that has already been recorded does not end another turn", () => {
  /** Turn one ends at T0. The human types straight back and turn two is running
   *  `npm test` by T0 + 800ms — the window in which a duplicate does its damage,
   *  so it is the window these cases drive. */
  function midTurnTwo(): GraphState {
    seq = 0;
    let state = send(initialState(), T0 - 60 * SEC, { hook_event_name: "SessionStart", provider: "claude" });
    state = send(state, T0 - 50 * SEC, { hook_event_name: "UserPromptSubmit", prompt: "one", provider: "claude" });
    state = send(state, T0, { hook_event_name: "Stop", provider: "claude" });
    state = send(state, T0 + 400, { hook_event_name: "UserPromptSubmit", prompt: "two", provider: "claude" });
    return send(state, T0 + 800, {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1",
      tool_input: { command: "npm test" }, provider: "claude",
    });
  }

  it("ignores a replayed copy, which carries the original stamp", () => {
    let state = midTurnTwo();
    state = send(state, T0, { hook_event_name: "Stop", provider: "claude" });
    const root = rootOf(state);
    expect(root.state).toBe("active");
    expect(root.endedAt).toBeUndefined();
    expect(call(state, "b1")!.endedAt, "npm test is still running").toBeUndefined();
    expect(call(state, "b1")!.ok).toBeUndefined();
  });

  it("ignores a hook retry stamped fresh inside the fan-out's own cap", () => {
    let state = midTurnTwo();
    state = send(state, T0 + 1_500, { hook_event_name: "Stop", provider: "claude" });
    expect(rootOf(state).state).toBe("active");
    expect(rootOf(state).endedAt).toBeUndefined();
    expect(call(state, "b1")!.endedAt).toBeUndefined();
  });

  it("keeps the attribution stack the duplicate used to drop", () => {
    let state = midTurnTwo();
    state = send(state, T0 + 900, { hook_event_name: "SubagentStart", agent_id: "bg", provider: "claude" });
    state = send(state, T0 + 1_500, { hook_event_name: "Stop", provider: "claude" });
    expect(state.activeSubagentStack.get(SESSION)).toEqual(["bg"]);
  });

  it("still ends turn two when turn two's own Stop arrives", () => {
    let state = midTurnTwo();
    state = send(state, T0 + 300 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(rootOf(state).state).toBe("done");
    expect(rootOf(state).endedAt).toBe(T0 + 300 * SEC);
    expect(call(state, "b1")!.ok).toBe(false);
  });

  it("still ends the turn for a second genuine Stop with no prompt in between", () => {
    // A `Stop` hook that blocks lets the agent carry on and stop again. Both
    // Stops are real, they can be a second apart, and the second is the one that
    // ends the turn.
    let state = running();
    state = send(state, T0 + 10 * SEC, { hook_event_name: "Stop", provider: "claude" });
    state = send(state, T0 + 11 * SEC, {
      hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2", provider: "claude",
    });
    state = send(state, T0 + 12 * SEC, { hook_event_name: "Stop", provider: "claude" });
    expect(rootOf(state).endedAt).toBe(T0 + 12 * SEC);
    expect(call(state, "t2")!.endedAt).toBe(T0 + 12 * SEC);
  });

  it("does not let a terminal event stamp an ending older than the turn it lands in", () => {
    // The symmetric check `SessionStart` has had since #445 and `SessionEnd`
    // never did. `closedAt` ranks `pruneDoneSessions`' eviction queue, so a
    // `SessionEnd` predating the session's own newest prompt spends a terminal
    // the human is sitting in front of — the disappearance #445 exists to
    // prevent, caused by the flag meant to prevent it.
    let state = midTurnTwo();
    state = send(state, T0 - 30 * SEC, { hook_event_name: "SessionEnd", provider: "claude" });
    const root = rootOf(state);
    expect(root.closedAt).toBeUndefined();
    expect(root.state).toBe("active");
  });

  it("a SessionEnd that follows the turn's own Stop still closes the session", () => {
    // The ordinary `/exit`: `Stop`, then `SessionEnd` a second later with no
    // prompt between them. Two different events, and the second is not a copy
    // of the first.
    let state = running();
    state = send(state, T0 + 10 * SEC, { hook_event_name: "Stop", provider: "claude" });
    state = send(state, T0 + 11 * SEC, {
      hook_event_name: "SessionEnd", reason: "prompt_input_exit", provider: "claude",
    });
    expect(rootOf(state).closedAt).toBe(T0 + 11 * SEC);
  });
});
