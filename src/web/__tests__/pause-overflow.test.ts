// The pause queue was a hold with no ceiling and no memory of what it had
// already taken, and both halves of that showed up the same way: a paused deck
// carrying thousands of envelopes it could not usefully apply, behind a pill
// that said `paused · 99+` whether the number was five or five thousand.
//
// pause.ts had already removed the obvious route in. Pressing Space no longer
// tears the EventSource down, so the toggle itself cannot make the server
// replay its ring buffer into a paused handler any more. What it did not remove
// is the reconnect, and a reconnect is not something the deck initiates: the
// stream drops on a server restart, an `npx` upgrade, a laptop sleep, a wifi
// blip or an `ssh -L` tunnel resetting, the deck's `error` handler only flips
// the live indicator, and `EventSource` opens a new connection on its own after
// the retry interval. The server answers a new connection by draining its ring
// buffer — up to two thousand envelopes — down the fresh socket, and while the
// gate is paused every one of those reaches `accept` BEFORE the reducer and
// before the render coalescer. So the queue is where they land, on top of
// whatever it was already holding, each one pinning a payload whose
// `tool_input` and `tool_response` the ingest path admits five million
// characters of. Then resuming re-applies the lot synchronously inside
// `togglePause`, one long main-thread block.
//
// Whether that burst is a RE-delivery turns on which sequence number the resume
// asks from, and the number the deck had lying around was the wrong one. The
// reducer's `lastSeq` is the last seq APPLIED, and a pause freezes it by
// definition — everything held since the freeze is invisible to it, so a filter
// built on it would let every held event through a second time. The right
// resume point is the last seq RECEIVED, held or applied, and the gate is the
// only object in the deck that knows it. So the gate keeps it (`through`), and
// while paused it refuses anything at or below it: not a duplicate filter run
// over the drain afterwards, but the resume point enforced at the door, which
// is free because the reducer's own seq guard would reject those envelopes on
// resume anyway.
//
// One reconnect that number cannot rescue is the one across a server restart.
// The server's counter starts at 1 on every boot and is re-derived by replaying
// events.jsonl, so the seq an open tab holds means nothing to the new process;
// envelopes carry a per-boot `epoch` for exactly this, and the rule here is the
// reducer's rule — a new epoch rebases the mark rather than silencing the
// stream. Which means a restarted server genuinely does offer a paused tab its
// whole re-ingested ring and nothing can tell it from new traffic. That case
// belongs to the ceiling, which is why the ceiling is not optional, and why the
// cases below check both.
//
// The shape of these tests follows the two things that had to be true at once.
// The gate is driven directly, the way the SSE handler drives it, because it is
// a plain object and there is no DOM in this suite. And the resume is fed to
// the REAL reducer rather than to a counter, because "the cap leaves the canvas
// consistent" is a claim about `applyEvent` — a truncation at the wrong end, or
// a drain the seq guard rejects half of, would pass any assertion made about
// the queue alone and still leave a tool pulsing as running forever.
import { describe, it, expect } from "vitest";
import { createPauseGate, PAUSE_QUEUE_LIMIT } from "../pause";
import { applyEvent, initialState } from "../reducer";
import { pauseTitle, statusPill } from "../status-pill";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-547";
const BOOT = "boot-a";

/** One tool call, identifiable by seq so a drained queue can be matched against
 *  the canvas the reducer built out of it. */
function toolUse(seq: number): HookPayload {
  return {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_name: "Read",
    tool_use_id: `t${seq}`,
    tool_input: { file_path: `/tmp/${seq}.txt` },
  };
}

function envelope(seq: number, epoch: string = BOOT): HookEnvelope {
  return { seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload: toolUse(seq), epoch };
}

/** Feed a run of seqs through the gate the way the SSE handler does, and
 *  collect what it says to deliver right now. */
function offer(
  gate: ReturnType<typeof createPauseGate<HookEnvelope>>,
  seqs: number[],
  epoch: string = BOOT,
): HookEnvelope[] {
  const through: HookEnvelope[] = [];
  for (const seq of seqs) {
    const env = envelope(seq, epoch);
    if (gate.accept(env)) through.push(env);
  }
  return through;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("a reconnect arriving while the deck is paused", () => {
  it("delivers nothing the pause is already holding, because the resume point is the last seq received", () => {
    const gate = createPauseGate<HookEnvelope>();
    // Live for a while, so the gate's mark is somewhere other than zero when
    // the freeze begins — the moment a gate that only tracked while paused
    // would have nothing to compare against.
    offer(gate, range(1, 10));
    gate.setPaused(true);
    offer(gate, range(11, 40));
    expect(gate.size).toBe(30);
    expect(gate.through).toBe(40);

    // The stream drops and comes back. The server drains its ring from the
    // beginning; every envelope in it is one this tab has seen, and thirty of
    // them are sitting in the queue right now.
    offer(gate, range(1, 40));

    expect(gate.size).toBe(30);
    expect(gate.dropped).toBe(0);
    const held = gate.setPaused(false);
    expect(held.map(e => e.seq)).toEqual(range(11, 40));
  });

  it("takes the part of the replay that is genuinely new, and only that part", () => {
    const gate = createPauseGate<HookEnvelope>();
    offer(gate, range(1, 10));
    gate.setPaused(true);
    offer(gate, range(11, 20));

    // A reconnect that catches up as well as replays: the ring holds 1..30, of
    // which 21..30 landed while the socket was down and this tab has never
    // seen them.
    offer(gate, range(1, 30));

    expect(gate.setPaused(false).map(e => e.seq)).toEqual(range(11, 30));
  });

  it("does not touch the live path, where a duplicate has always been the reducer's to reject", () => {
    // Short-circuiting a running deck would also rob the render coalescer of a
    // tick it has been given for every arriving envelope since before the gate
    // existed, so the mark is recorded while running and enforced only while
    // paused.
    const gate = createPauseGate<HookEnvelope>();
    expect(offer(gate, range(1, 5)).map(e => e.seq)).toEqual(range(1, 5));
    expect(offer(gate, range(1, 5)).map(e => e.seq)).toEqual(range(1, 5));
    expect(gate.through).toBe(5);
  });

  it("stops calling a replay a duplicate once the server has renumbered, which is what the ceiling is for", () => {
    // A restart re-derives the counter from events.jsonl, so seq 12 under the
    // new boot is a different event from seq 12 under the old one. The gate
    // rebases on the epoch exactly as the reducer's guard does; nothing here
    // can be recognised, and the honest answer is to hold it and let the cap
    // decide how much.
    const gate = createPauseGate<HookEnvelope>({ limit: 100 });
    gate.setPaused(true);
    offer(gate, range(1, 20));
    expect(gate.size).toBe(20);

    offer(gate, range(1, 20), "boot-b");

    expect(gate.size).toBe(40);
    expect(gate.through).toBe(20);
    expect(gate.setPaused(false).map(e => e.seq)).toEqual([...range(1, 20), ...range(1, 20)]);
  });

  it("keeps the plain monotonic rule for servers too old to stamp an epoch", () => {
    const gate = createPauseGate<HookEnvelope>();
    const bare = (seq: number): HookEnvelope =>
      ({ seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload: toolUse(seq) });
    gate.setPaused(true);
    for (const seq of range(1, 10)) gate.accept(bare(seq));
    for (const seq of range(1, 10)) gate.accept(bare(seq));
    expect(gate.size).toBe(10);
  });
});

describe("the ceiling on the hold, and the pill that has to admit to it", () => {
  it("holds no more than its limit, however long the pause runs", () => {
    const gate = createPauseGate<HookEnvelope>({ limit: 8 });
    gate.setPaused(true);
    offer(gate, range(1, 8));
    expect(gate.size).toBe(8);
    expect(gate.overflowed).toBe(false);

    offer(gate, range(9, 100));

    expect(gate.size).toBe(8);
    expect(gate.dropped).toBe(92);
    expect(gate.overflowed).toBe(true);
  });

  it("drops the oldest, so the survivors describe the present rather than the moment it filled", () => {
    // Which end goes is the whole of the choice. Keeping the head would pin the
    // canvas to the instant the ceiling was reached and lose every event since,
    // so a tool whose PostToolUse fell off would pulse as running until the
    // stale sweep reaped it an hour and a half later.
    const gate = createPauseGate<HookEnvelope>({ limit: 5 });
    gate.setPaused(true);
    offer(gate, range(1, 20));
    expect(gate.setPaused(false).map(e => e.seq)).toEqual(range(16, 20));
  });

  it("says `paused · full` rather than a number that has stopped counting anything", () => {
    const gate = createPauseGate<HookEnvelope>({ limit: 8 });
    gate.setPaused(true);
    offer(gate, range(1, 8));
    // Still an ordinary deep pause: the whole hold will be applied.
    expect(statusPill({ connected: true, paused: true, held: gate.size, dropped: gate.dropped }).label)
      .toBe("paused · 8");

    offer(gate, range(9, 20));

    const pill = statusPill({ connected: true, paused: true, held: gate.size, dropped: gate.dropped });
    expect(pill.tone).toBe("paused");
    expect(pill.label).toBe("paused · full");
    // And the label still fits the box the tone reserves — the property the
    // pill's `widest` exists for, now that the tone has a fourth string.
    expect(pill.label.length).toBeLessThanOrEqual(pill.widest.length);
    expect(pill.title).toContain("the pause is full");
    expect(pill.title).toContain("dropped");
  });

  it("names the count that was dropped in the tooltip, which has room for it", () => {
    const gate = createPauseGate<HookEnvelope>({ limit: 8 });
    gate.setPaused(true);
    offer(gate, range(1, 20));
    const title = pauseTitle({ paused: true, held: gate.size, dropped: gate.dropped });
    expect(title).toContain("The pause is full");
    expect(title).toContain("8 events held");
    expect(title).toContain("12 older ones already dropped");
    expect(title).toContain("(Space)");
  });

  it("never says full while it is merely deep, however far past the pill's 99 the count runs", () => {
    // The two states have to be distinguishable, because they call for
    // different things: a pause holding 400 events will be applied whole, and
    // a pause that has started dropping will not.
    const pill = statusPill({ connected: true, paused: true, held: 400, dropped: 0 });
    expect(pill.label).toBe("paused · 99+");
    expect(pill.title).not.toContain("full");
  });

  it("ships a ceiling well under the ring the server would replay into it", () => {
    // The relationship is the point, not the figure: a full ring drain is 2000
    // envelopes, so it overflows the hold by construction and cannot be
    // mistaken for a backlog a human pause produced.
    expect(PAUSE_QUEUE_LIMIT).toBeLessThan(2000);
    expect(PAUSE_QUEUE_LIMIT).toBeGreaterThan(99);
  });
});

describe("resuming a pause that overflowed", () => {
  it("leaves the canvas consistent rather than half-applied", () => {
    const gate = createPauseGate<HookEnvelope>({ limit: 6 });

    // Ten events applied normally, so the canvas has a real history behind it.
    let state = initialState();
    for (const env of offer(gate, range(1, 10))) state = applyEvent(state, env);
    expect(state.lastSeq).toBe(10);

    // Pause, then a long run plus a reconnect replaying the whole ring on top
    // of it — far more than the hold will carry.
    gate.setPaused(true);
    offer(gate, range(11, 40));
    offer(gate, range(1, 40));
    expect(gate.overflowed).toBe(true);

    const held = gate.setPaused(false);
    for (const env of held) state = applyEvent(state, env);

    // Every released envelope was applied. Not one was thrown away by the
    // reducer's seq guard mid-drain, which is what a truncation from the wrong
    // end or a re-offered replay in the queue would have produced.
    expect(held).toHaveLength(6);
    expect(held.map(e => e.seq)).toEqual(range(35, 40));
    expect(state.totalEvents).toBe(16);
    expect(state.lastSeq).toBe(40);

    // The canvas holds one contiguous run per surviving event, and the ones
    // the ceiling ate are simply absent — a shorter history, not a broken one.
    const tools = state.agents.get(SESSION)?.tools ?? [];
    expect(tools.map(t => t.id)).toEqual([...range(1, 10), ...range(35, 40)].map(n => `t${n}`));

    // And the gate itself is back to a single coherent state: nothing held,
    // nothing outstanding to report, and a second resume with nothing to give.
    expect(gate.paused).toBe(false);
    expect(gate.size).toBe(0);
    expect(gate.dropped).toBe(0);
    expect(gate.overflowed).toBe(false);
    expect(gate.setPaused(false)).toEqual([]);

    // The pill drops the overflow the moment the hold does, rather than
    // reporting a truncation of a pause that is no longer open.
    expect(statusPill({ connected: true, paused: false, held: gate.size, dropped: gate.dropped }).label)
      .toBe("live");
  });

  it("follows the stream again immediately, without re-holding what it just applied", () => {
    const gate = createPauseGate<HookEnvelope>({ limit: 4 });
    let state = initialState();
    gate.setPaused(true);
    offer(gate, range(1, 30));
    for (const env of gate.setPaused(false)) state = applyEvent(state, env);
    expect(state.lastSeq).toBe(30);

    // Live traffic goes straight through, and the reducer takes it: the
    // high-water mark the gate kept while paused is the same number the
    // reducer now holds, so the two are in step rather than one lagging.
    expect(gate.through).toBe(30);
    const live = offer(gate, [31]);
    expect(live.map(e => e.seq)).toEqual([31]);
    state = applyEvent(state, live[0]);
    expect(state.lastSeq).toBe(31);
  });

  it("carries the drop count across a re-pause, since only a resume closes the hold", () => {
    const gate = createPauseGate<HookEnvelope>({ limit: 3 });
    gate.setPaused(true);
    offer(gate, range(1, 10));
    expect(gate.setPaused(true)).toEqual([]);   // re-pause must not spill
    expect(gate.size).toBe(3);
    expect(gate.dropped).toBe(7);
    expect(gate.setPaused(false).map(e => e.seq)).toEqual(range(8, 10));
    expect(gate.dropped).toBe(0);
  });
});
