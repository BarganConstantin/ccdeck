// #676. A pause that overflows its hold used to strand the tool calls that were
// already running when it began, and then blame their sessions for it.
//
// The ceiling in pause.ts dropped by POSITION — `queue.shift()`, oldest first —
// and the note above it argued the tail was the safe end to keep, because
// keeping the head "would pin the canvas to the moment the ceiling was hit and
// lose every event describing the present, so a tool that finished would pulse
// as running until the stale sweep reaped it". Every word of that is true about
// keeping the head, and none of it is answered by keeping the tail, because the
// same sentence describes what keeping the tail does to the other end. The head
// of a pause queue is not spare capacity: it is where the settling events for
// calls that were open at the freeze land, because a `Bash` running when you
// press Space returns a few seconds later. Oldest-out drops exactly those.
//
// And nothing brings them back. The gate's `through` and the browser's
// `Last-Event-ID` both advanced past an envelope the instant it was OFFERED, so
// a reconnect resumes above the hole even though the server's ring still holds
// what fell in it. The reducer cannot see the hole either: a run with 201
// envelopes missing from the middle is a run of strictly increasing seqs, like
// a quiet minute.
//
// So the call sits in `toolIndex` with `endedAt == null`, pulsing in the burst
// layer, counting in the card's in-flight number and pinning its whole
// `tool_input` — and ninety minutes later `sweepStaleTools` stamps it
// `ok = false` with `errorPreview = "session ended before this call returned"`
// on a call that returned "all green" while the session was alive. That last
// part is the expensive half. A missing result is a gap the user can see
// through; a cause that never happened is a bug hunt they go on.
//
// The fix is in two places and they answer two different questions.
//
//   pause.ts     — the eviction keeps its direction and stops being blind. It
//                  drops the oldest event that is not the ANSWER to something
//                  already on the canvas, which the caller identifies through
//                  `protect`. Freshness is preserved (the tail is untouched)
//                  and so is monotonicity (nothing is reordered), which are the
//                  two things the old note was right about.
//   reducer.ts   — `noteDroppedEvents` records that a hole was knowingly
//                  applied, and `sweepStaleTools` reads that record before it
//                  names a cause. A drop policy decides how OFTEN an outcome is
//                  lost; only this decides what the deck SAYS when one is.
//
// Driven the way the reporter drove it and the way App.tsx drives it: the real
// gate, the real reducer, the real sweep. There is no DOM in this suite, and
// none is needed — every surface in the issue is a field on a `ToolCall`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPauseGate, PAUSE_QUEUE_LIMIT } from "../pause";
import {
  applyEvent,
  initialState,
  noteDroppedEvents,
  settlesInFlightCall,
  STALE_SESSION_MS,
  sweepStaleTools,
  type GraphState,
} from "../reducer";
import type { HookEnvelope, HookPayload, ToolCall } from "../types";

const T0 = 1_700_000_000_000;
const CWD = "/repo";
/** The sweep's window, plus a margin, so `sweepStaleTools` has certainly fired
 *  by the time these cases ask what it decided. */
const LONG_AFTER = T0 + 10 * STALE_SESSION_MS;

/** The two sentences the sweep can write, quoted here so a case that expects
 *  one of them cannot be satisfied by the other. */
const BLAMES_SESSION = "session ended before this call returned";
const NAMES_THE_GAP = "no result reached the deck — events were dropped while the deck was paused";

/** One deck: a real graph, a real gate wired the way App.tsx wires it, and a
 *  seq counter shared between them so the envelopes arrive in one numbering.
 *
 *  `feed` is the SSE handler: offer to the gate, apply what it hands back. The
 *  gate's `protect` reads the LIVE graph, which is what makes the protection
 *  mean "open when the pause began" — a pause applies nothing, so the graph is
 *  frozen for as long as it lasts. */
function deck(limit?: number) {
  let state = initialState();
  let seq = 0;
  const gate = createPauseGate<HookEnvelope>({
    limit,
    protect: env => settlesInFlightCall(state, env),
  });
  const feed = (payload: HookPayload): void => {
    seq += 1;
    const env: HookEnvelope = {
      seq,
      receivedAt: T0 + seq * 10,
      source: "hook",
      payload: { cwd: CWD, ...payload },
      epoch: "boot-676",
    };
    if (gate.accept(env)) state = applyEvent(state, env);
  };
  /** App.tsx's `togglePause`, to the line: read the drop count before the
   *  toggle clears it, note the hole before the drain, then drain. */
  const resume = (): void => {
    const holed = gate.paused && gate.dropped > 0;
    const held = gate.setPaused(false);
    if (holed) noteDroppedEvents(state);
    for (const env of held) state = applyEvent(state, env);
  };
  return {
    gate,
    feed,
    resume,
    pause: () => { gate.setPaused(true); },
    sweep: (at = LONG_AFTER) => sweepStaleTools(state, at, STALE_SESSION_MS),
    get state(): GraphState { return state; },
  };
}

const start = (session: string): HookPayload =>
  ({ hook_event_name: "SessionStart", session_id: session });
const pre = (session: string, id: string, command: string): HookPayload =>
  ({ hook_event_name: "PreToolUse", session_id: session, tool_use_id: id, tool_name: "Bash", tool_input: { command } });
const post = (session: string, id: string, response: string): HookPayload =>
  ({ hook_event_name: "PostToolUse", session_id: session, tool_use_id: id, tool_response: response });

/** Whatever the graph holds under this id, wherever it was drawn. */
function call(state: GraphState, id: string): ToolCall {
  for (const a of state.agents.values()) {
    const found = a.tools.find(t => t.id === id);
    if (found) return found;
  }
  throw new Error(`no tool call ${id} on the canvas`);
}

/** The card's in-flight number, App.tsx: `data.tools.filter(t => !t.endedAt).length`. */
const inFlight = (state: GraphState, session: string): string[] =>
  (state.agents.get(session)?.tools ?? []).filter(t => !t.endedAt).map(t => t.id);

/** Traffic from the other sessions on a busy deck: whole calls, opened and
 *  closed inside the pause, which is what fills a hold. Interleaved across six
 *  sessions the way six agents working at once interleave. */
function flood(d: ReturnType<typeof deck>, envelopes: number): void {
  for (let i = 0; i < envelopes; i++) {
    const session = `other-${i % 6}`;
    if (i % 2 === 0) d.feed(pre(session, `o${i}`, `echo ${i}`));
    else d.feed(post(session, `o${i - 1}`, "ok"));
  }
}

describe("a pause that overflows while a tool call is in flight", () => {
  it("keeps the settling event the ceiling used to eat, and the call settles for real", () => {
    // The reporter's sequence exactly, at the shipped limit: one `Bash` open on
    // the watched session, 1200 envelopes from six others behind it.
    const d = deck();
    d.feed(start("P"));
    d.feed(pre("P", "long-1", "npm test"));
    expect(inFlight(d.state, "P")).toEqual(["long-1"]);

    d.pause();
    d.feed(post("P", "long-1", "all green"));
    flood(d, 1200);

    // The hold is still bounded, and still dropping — the ceiling did not move
    // and this is not a fix that works by holding more.
    expect(d.gate.size).toBe(PAUSE_QUEUE_LIMIT);
    expect(d.gate.dropped).toBe(201);
    expect(d.gate.overflowed).toBe(true);

    d.resume();

    // The one envelope that could not be replaced survived. The call is closed
    // with its real outcome, at the moment it really returned, and it is out of
    // the in-flight index rather than pinning its `tool_input` for 200 calls.
    expect(inFlight(d.state, "P")).toEqual([]);
    expect(d.state.toolIndex.has("long-1")).toBe(false);
    const t = call(d.state, "long-1");
    expect(t.endedAt).toBe(T0 + 30);
    expect(t.ok).toBe(true);
    expect(t.response).toBe("all green");

    // And the sweep, ninety minutes later, has nothing to say about it — which
    // is the headline of the issue: a call that returned "all green" was being
    // drawn as a failure with a cause that never happened.
    d.sweep();
    expect(call(d.state, "long-1").ok).toBe(true);
    expect(call(d.state, "long-1").errorPreview).toBeUndefined();
  });

  it("pays for it out of the flood rather than out of the ceiling", () => {
    // The protection is a preference between events, not extra room: the same
    // number of envelopes goes overboard, and what changes is which. Without
    // this the fix could pass by quietly holding one more.
    const d = deck();
    d.feed(start("P"));
    d.feed(pre("P", "long-1", "npm test"));
    d.pause();
    d.feed(post("P", "long-1", "all green"));
    flood(d, 1200);

    const held = d.gate.setPaused(false);
    expect(held).toHaveLength(PAUSE_QUEUE_LIMIT);
    expect(held.map(e => e.seq)).toContain(3);           // the settling event
    // Everything else is contiguous and strictly increasing, so the drain is a
    // run the reducer applies whole rather than one its seq guard half rejects
    // — the second thing the old eviction note was right about.
    const seqs = held.map(e => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBe(1203);
    expect(seqs.slice(1)).toEqual(seqs.slice(1).map((_, i) => seqs[1] + i));
  });

  it("still lands the canvas on the present, which is what the tail was kept for", () => {
    // The old note's own argument, held to. Protecting the head must not turn
    // into keeping the head: the newest events of the pause are all there, and
    // the flood's own calls — opened and closed inside the hold — are drawn
    // whole or not at all.
    const d = deck();
    d.feed(start("P"));
    d.feed(pre("P", "long-1", "npm test"));
    d.pause();
    d.feed(post("P", "long-1", "all green"));
    flood(d, 1200);
    d.resume();

    // The last call of the flood is on the canvas, settled.
    const last = call(d.state, "o1198");
    expect(last.endedAt).not.toBeUndefined();
    expect(last.ok).toBe(true);
    // And nothing from the flood was left half-drawn by the truncation: every
    // call the resume put on the board has its outcome, because head-eviction
    // can only ever drop a `PreToolUse` before the `PostToolUse` behind it.
    const orphans: string[] = [];
    for (const a of d.state.agents.values()) {
      if (!a.sessionId.startsWith("other-")) continue;
      for (const t of a.tools) if (t.endedAt == null) orphans.push(t.id);
    }
    expect(orphans).toEqual([]);
  });
});

describe("the cause the sweep reports for a call it cannot explain", () => {
  it("names the deck's own gap when the deck knowingly threw events away", () => {
    // The case the protection cannot save: more calls open at the freeze than
    // the hold has slots, so the ceiling has to drop settling events even after
    // preferring them. This is what `noteDroppedEvents` is for, and it is the
    // half of the fix that survives any drop policy.
    const d = deck(4);
    for (let i = 1; i <= 6; i++) {
      d.feed(start(`S${i}`));
      d.feed(pre(`S${i}`, `c${i}`, `build ${i}`));
    }
    d.pause();
    for (let i = 1; i <= 6; i++) d.feed(post(`S${i}`, `c${i}`, "all green"));

    // Four held, two dropped — and both drops were settling events, because
    // settling events are all there was.
    expect(d.gate.size).toBe(4);
    expect(d.gate.dropped).toBe(2);

    d.resume();

    // The four whose outcomes survived are settled and carry no gap: the flag
    // burns off on the first real outcome, so it does not spread to calls the
    // deck knows about.
    for (const id of ["c3", "c4", "c5", "c6"]) {
      expect(call(d.state, id).endedAt).not.toBeUndefined();
      expect(call(d.state, id).outcomeGap).toBeFalsy();
    }

    // The two whose outcomes went into the hole are still in flight, and when
    // the sweep finally passes a verdict on them it names what happened rather
    // than blaming the session, which was alive and answered.
    expect(d.sweep()).toBe(true);
    for (const id of ["c1", "c2"]) {
      const t = call(d.state, id);
      expect(t.errorPreview).toBe(NAMES_THE_GAP);
      expect(t.errorPreview).not.toBe(BLAMES_SESSION);
    }
  });

  it("still blames the session when the session is what went quiet", () => {
    // The other half of the same discriminator, and the reason this is not
    // simply a reworded string. #436 argued a cause is knowable here: Claude
    // emits a PostToolUse for every call it completes, so a session silent for
    // the whole window died mid-call. Nothing was dropped in this deck, so that
    // argument stands and the sweep must still make it.
    const d = deck();
    d.feed(start("P"));
    d.feed(pre("P", "killed-1", "npm test"));
    // Never resumed, never dropped — the session simply stops.
    expect(d.sweep()).toBe(true);
    const t = call(d.state, "killed-1");
    expect(t.ok).toBe(false);
    expect(t.errorPreview).toBe(BLAMES_SESSION);
  });

  it("keeps the gap to the calls that were open when the hole was applied", () => {
    // A deck that overflowed once must not describe every later stale call as a
    // gap for the rest of the day. The record is per call and is only ever put
    // on the calls in flight at that instant.
    const d = deck(4);
    d.feed(start("P"));
    d.feed(pre("P", "held-open", "npm test"));
    d.pause();
    flood(d, 40);
    expect(d.gate.dropped).toBeGreaterThan(0);
    d.resume();
    expect(call(d.state, "held-open").outcomeGap).toBe(true);

    // A call this session starts AFTER the resume was never at risk from that
    // hole, and its verdict says so.
    d.feed(pre("P", "after-1", "npm run lint"));
    expect(call(d.state, "after-1").outcomeGap).toBeFalsy();

    d.sweep();
    expect(call(d.state, "held-open").errorPreview).toBe(NAMES_THE_GAP);
    expect(call(d.state, "after-1").errorPreview).toBe(BLAMES_SESSION);
  });

  it("forgets the gap the moment a real outcome arrives, however late", () => {
    // The flag says "the deck does not know". An outcome is the deck coming to
    // know, and it has to clear the record — otherwise a call settled minutes
    // after the resume would be described as a gap, and a late outcome
    // overturning the sweep's guess (#436's un-reap) would leave the sentence
    // standing on a call that succeeded.
    const d = deck(4);
    d.feed(start("P"));
    d.feed(pre("P", "slow-1", "npm test"));
    d.pause();
    flood(d, 40);
    d.resume();
    expect(call(d.state, "slow-1").outcomeGap).toBe(true);

    d.feed(post("P", "slow-1", "all green"));
    const t = call(d.state, "slow-1");
    expect(t.outcomeGap).toBeFalsy();
    expect(t.ok).toBe(true);

    d.sweep();
    expect(call(d.state, "slow-1").errorPreview).toBeUndefined();
  });
});

describe("the gate's ceiling, under the new eviction", () => {
  it("drops the oldest when nothing is protected, exactly as it always did", () => {
    // No `protect` at all: every gate built before #676, and the behaviour the
    // rest of pause-overflow.test.ts pins.
    const plain = createPauseGate<HookEnvelope>({ limit: 5 });
    plain.setPaused(true);
    for (let seq = 1; seq <= 20; seq++) {
      plain.accept({ seq, receivedAt: T0 + seq, source: "hook", payload: {}, epoch: "boot-676" });
    }
    expect(plain.setPaused(false).map(e => e.seq)).toEqual([16, 17, 18, 19, 20]);
  });

  it("holds no more than the limit even when every held event is protected", () => {
    // The fallback. A hold made entirely of settling events still has a
    // ceiling; preferring them is a preference and never a reservation, or the
    // unbounded queue #547 removed comes back through this door.
    const everything = createPauseGate<HookEnvelope>({ limit: 3, protect: () => true });
    everything.setPaused(true);
    for (let seq = 1; seq <= 50; seq++) {
      everything.accept({ seq, receivedAt: T0 + seq, source: "hook", payload: {}, epoch: "boot-676" });
    }
    expect(everything.size).toBe(3);
    expect(everything.dropped).toBe(47);
    expect(everything.setPaused(false).map(e => e.seq)).toEqual([48, 49, 50]);
  });

  it("asks about a settling event and nothing else", () => {
    // `settlesInFlightCall` is the predicate both App.tsx and these cases use,
    // so what it answers is worth pinning on its own: an outcome for a call the
    // graph is waiting on, and no other event — a fresh `PreToolUse` is not a
    // settling event, and an outcome for a call that already settled is not one
    // either, because there is nothing left for it to close.
    const d = deck();
    d.feed(start("P"));
    d.feed(pre("P", "open-1", "npm test"));
    const env = (payload: HookPayload): HookEnvelope =>
      ({ seq: 99, receivedAt: T0, source: "hook", payload: { cwd: CWD, ...payload }, epoch: "boot-676" });

    expect(settlesInFlightCall(d.state, env(post("P", "open-1", "all green")))).toBe(true);
    expect(settlesInFlightCall(d.state, env(
      { hook_event_name: "PostToolUseFailure", session_id: "P", tool_use_id: "open-1", tool_response: "exit 1" },
    ))).toBe(true);
    expect(settlesInFlightCall(d.state, env(pre("P", "open-2", "npm run lint")))).toBe(false);
    expect(settlesInFlightCall(d.state, env(post("P", "never-existed", "ok")))).toBe(false);
    expect(settlesInFlightCall(d.state, env(start("P")))).toBe(false);

    d.feed(post("P", "open-1", "all green"));
    expect(settlesInFlightCall(d.state, env(post("P", "open-1", "all green")))).toBe(false);
  });
});

describe("the deck this is all wired into", () => {
  // `deck()` above is App.tsx's `togglePause` re-written, because there is no
  // DOM here to mount the component in. That is only worth anything while the
  // component is still doing the same thing, and both halves of this fix are
  // one line of wiring each — a gate built without `protect`, or a resume that
  // drains before it notes the hole, puts the bug straight back with every case
  // above still green. So the source is read.
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("builds its pause gate with the protection the ceiling reads", () => {
    expect(app).toMatch(/createPauseGate<HookEnvelope>\(\{\s*protect: env => settlesInFlightCall\(stateRef\.current, env\),/);
  });

  it("notes the hole on a resume that dropped, before it feeds the run in", () => {
    const toggle = app.slice(app.indexOf("const togglePause"), app.indexOf("const [now, setNow]"));
    expect(toggle).toContain("noteDroppedEvents(stateRef.current)");
    // Ordering is the whole of it, twice over. `dropped` has to be read while
    // the gate is still paused, because the resume clears it; and the note has
    // to land before the drain, because the drain is what clears the flag off
    // every call whose outcome did survive.
    const readsCount = toggle.indexOf("pauseGate.dropped");
    const toggles = toggle.indexOf("setPaused(!pauseGate.paused)");
    const notes = toggle.indexOf("noteDroppedEvents");
    const drains = toggle.indexOf("for (const env of held)");
    // Offsets into one string, so the failures are numbers — each one says
    // which order it wanted, because "expected 716 to be less than 623" is not
    // a sentence anybody can act on.
    expect(readsCount, "togglePause never reads pauseGate.dropped").toBeGreaterThanOrEqual(0);
    expect(readsCount, "pauseGate.dropped is read after the toggle, which clears it — it is always 0")
      .toBeLessThan(toggles);
    expect(toggles, "noteDroppedEvents runs before the toggle, when nothing has been drained yet")
      .toBeLessThan(notes);
    expect(notes, "the held run is applied before the hole is noted, so every call it settles is flagged after the fact")
      .toBeLessThan(drains);
  });
});
