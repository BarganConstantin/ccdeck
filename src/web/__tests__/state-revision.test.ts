// The counter that says the state changed, and the four writers that did not
// move it.
//
// applyEvent mutates GraphState in place and returns the same object — every
// branch ends `return state`, and only `__clear` builds a new one. So the
// state's identity never moves, and a `useMemo` keyed on it depends entirely on
// its second dep. That dep was `lastSeq`, which only the envelope path writes.
//
// The four periodic sweeps mutate the same state and never touched it. They
// return `changed` and App.tsx calls rerender(), React re-renders, and the memos
// hand back their cached value — computed from a state that has since changed
// underneath them.
//
// The visible cost was the alarm surfaces, which is the worst place for it.
// sweepStaleSessions exists to clear a `waiting` block left by a terminal killed
// mid-permission-prompt; its own comment names the tab title and the favicon as
// the reason it was written. `waitingSessions` and `runningSessions` are memos,
// their effect is keyed on their lengths, and on a quiet deck no further event
// ever arrives to move `lastSeq` — so the title, the favicon and the amber chip
// announced a block that had been cleared ninety minutes earlier, for as long as
// the tab stayed open. Clicking the chip focused a session that was settled.
//
// This file pins the contract that replaced it: a writer that changes something
// moves `revision`, and one that changes nothing leaves it alone. The memos
// cannot be tested here — the suite has no DOM — but the signal they depend on
// can, and it is the half that was missing.
import { describe, it, expect } from "vitest";
import {
  applyEvent, initialState, pruneDoneSessions, pruneOldAgents,
  sweepStaleSessions, sweepStaleTools,
} from "../reducer";
import type { GraphState, HookEnvelope, HookPayload } from "../types";

const MIN = 60_000;
const STALE = 90 * MIN;

let seq = 0;
const send = (state: GraphState, sid: string, payload: Partial<HookPayload>, at: number) =>
  applyEvent(state, {
    seq: ++seq,
    receivedAt: at,
    payload: { session_id: sid, ...payload } as HookPayload,
  } as HookEnvelope);

/** A session that asked for permission and was never answered. */
function blocked(): GraphState {
  seq = 0;
  let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" }, 1_000);
  state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" }, 2_000);
  state = send(state, "s1", {
    hook_event_name: "Notification",
    notification_type: "permission_prompt",
    message: "Claude needs your permission",
  }, 3_000);
  return state;
}

describe("revision", () => {
  it("moves on every accepted event", () => {
    const state = initialState();
    expect(state.revision).toBe(0);
    const after = send(state, "s1", { hook_event_name: "SessionStart", cwd: "/x" }, 1_000);
    expect(after.revision).toBe(1);
    send(after, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" }, 2_000);
    expect(after.revision).toBe(2);
  });

  it("carries across a clear rather than restarting", () => {
    // __clear returns a NEW object, so identity alone already tells every memo
    // to recompute. The counter still has to advance: a memo that cached at 7
    // must not be handed a fresh 0 and conclude nothing has happened.
    const state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/x" }, 1_000);
    const cleared = send(state, "s1", { hook_event_name: "__clear", cwd: "" }, 2_000);
    expect(cleared).not.toBe(state);
    expect(cleared.revision).toBeGreaterThan(state.revision);
  });

  it("moves when the stale sweep clears a block — the case the memos missed", () => {
    const state = blocked();
    const before = state.revision;
    expect(state.agents.get("s1")?.waiting).toBeTruthy();

    expect(sweepStaleSessions(state, 3_000 + 91 * MIN, STALE)).toBe(true);
    expect(state.agents.get("s1")?.waiting).toBeFalsy();
    // The assertion that would have failed before this change, with the block
    // cleared and every memo still holding the version that says it is lit.
    expect(state.revision).toBeGreaterThan(before);
  });

  it("stays put when a sweep finds nothing to do", () => {
    // The other half of the contract, and the reason this is not just
    // `revision++` at the top of each sweep: a memo that recomputes four times a
    // second on a deck where nothing is happening is its own defect.
    const state = blocked();
    const before = state.revision;
    expect(sweepStaleSessions(state, 4_000, STALE)).toBe(false);
    expect(sweepStaleTools(state, 4_000, STALE)).toBe(false);
    expect(pruneOldAgents(state, 4_000, 100, 5 * MIN)).toBe(false);
    expect(pruneDoneSessions(state, 4_000, 100, 5 * MIN)).toBe(false);
    expect(state.revision).toBe(before);
  });

  it("moves when a prune drops a finished session off the canvas", () => {
    // pruneDoneSessions feeds the token and cost readouts and the filter chips,
    // which are memos too: an evicted session's tokens went on being counted,
    // and its chips went on being drawn, until the next event arrived.
    seq = 0;
    let state = initialState();
    for (let i = 1; i <= 9; i++) {
      state = send(state, `s${i}`, { hook_event_name: "SessionStart", cwd: `/p${i}` }, 1_000 + i);
      state = send(state, `s${i}`, { hook_event_name: "Stop" }, 2_000 + i);
    }
    const before = state.revision;
    expect(pruneDoneSessions(state, 2_100 + 10 * MIN, 3, 5 * MIN)).toBe(true);
    expect(state.revision).toBeGreaterThan(before);
  });
});
