// A pinned session stays on the board: the cap on finished sessions passes it
// over (board-sweeps.ts pruneDoneSessions), so the Sessions list can keep it in
// Pinned for as long as the pin is on (list-pinned.ts).
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, pruneDoneSessions } from "../reducer";
import { sweepTick } from "../prune";
import { DONE_SESSION_CAP, DONE_SESSION_GRACE_MS } from "../board-limits";
import type { GraphState, HookEnvelope, HookPayload } from "../types";

const MIN = 60_000;
let seq = 0;
const send = (state: GraphState, sid: string, payload: Partial<HookPayload>, at: number) =>
  applyEvent(state, { seq: ++seq, receivedAt: at, payload: { session_id: sid, ...payload } as HookPayload } as HookEnvelope);

/** `n` sessions, s1 first, each started and then finished a second apart. */
function finished(n: number): GraphState {
  seq = 0;
  let state = initialState();
  for (let i = 1; i <= n; i++) {
    state = send(state, `s${i}`, { hook_event_name: "SessionStart", cwd: `/p${i}` }, 1_000 * i);
    state = send(state, `s${i}`, { hook_event_name: "Stop" }, 1_000 * i + 500);
  }
  return state;
}

const rootOf = (state: GraphState, sid: string) =>
  [...state.agents.values()].find(a => a.kind === "root" && a.sessionId === sid)!;
const sessionsLeft = (state: GraphState) =>
  [...new Set([...state.agents.values()].map(a => a.sessionId))].sort();

const LATER = 100_000 + 10 * MIN;

describe("a pinned session and the cap on finished sessions", () => {
  it("evicts the oldest finished session when nothing is pinned", () => {
    const state = finished(9);
    expect(pruneDoneSessions(state, LATER, 6, 2 * MIN)).toBe(true);
    expect(sessionsLeft(state)).toEqual(["s4", "s5", "s6", "s7", "s8", "s9"]);
  });

  it("keeps the pinned one, by its root's id, and does not count it", () => {
    const state = finished(9);
    const pinned = new Set([rootOf(state, "s1").id]);
    expect(pruneDoneSessions(state, LATER, 6, 2 * MIN, undefined, pinned)).toBe(true);
    // s1 stays, and six unpinned finished sessions stay beside it: the pin
    // takes no room from the others.
    expect(sessionsLeft(state)).toEqual(["s1", "s4", "s5", "s6", "s7", "s8", "s9"]);
  });

  it("keeps every pinned one, however many there are", () => {
    const state = finished(9);
    const pinned = new Set(["s1", "s2", "s3"].map(sid => rootOf(state, sid).id));
    expect(pruneDoneSessions(state, LATER, 2, 2 * MIN, undefined, pinned)).toBe(true);
    expect(sessionsLeft(state)).toEqual(["s1", "s2", "s3", "s8", "s9"]);
  });

  it("treats a session as any other once its pin is off", () => {
    const state = finished(9);
    const pinned = new Set([rootOf(state, "s1").id]);
    pruneDoneSessions(state, LATER, 6, 2 * MIN, undefined, pinned);
    expect(pruneDoneSessions(state, LATER, 6, 2 * MIN)).toBe(true);
    expect(sessionsLeft(state)).toEqual(["s4", "s5", "s6", "s7", "s8", "s9"]);
  });

  it("reports only the unpinned sessions it forgot", () => {
    const state = finished(9);
    const pinned = new Set([rootOf(state, "s2").id]);
    const forgot: string[] = [];
    pruneDoneSessions(state, LATER, 6, 2 * MIN, sid => forgot.push(sid), pinned);
    expect(forgot).toEqual(["s1", "s3"]);
  });

  it("is what the board's tick does with the pins it is given", () => {
    const state = finished(DONE_SESSION_CAP + 3);
    const pinned = new Set([rootOf(state, "s1").id]);
    const { forgotten } = sweepTick(state, 100_000 + DONE_SESSION_GRACE_MS + MIN, pinned);
    // Nine finished, one pinned: eight count against the cap of six.
    expect(forgotten).toEqual(["s2", "s3"]);
    expect(sessionsLeft(state)).toContain("s1");
  });
});
