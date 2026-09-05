// The spend that has happened since the reading on screen was taken.
//
// ccusage is the truth and it is expensive: 7.8 CPU-seconds on this machine,
// because it walks every transcript whatever period it is asked for. Asking
// every ten seconds would be 78% of a core, forever, for numbers that move
// slowly — so it is asked once a minute, and the gap is filled from what the
// deck already knows. Every hook event carries its session's cumulative usage,
// so the canvas holds an exact running total for free.
//
// The rules here are what keep that honest: never subtract, never double-count
// a session that was already in the reading, and never let an eviction — which
// happens two minutes after a session ends — pull the headline backwards.
import { describe, it, expect } from "vitest";
import { boardBySession, liveDelta, NO_DELTA, type CountableAgent } from "../live-delta";

/** A session root as the canvas holds one, priced by the deck's own table. */
const root = (sessionId: string, input: number, output: number, model = "claude-opus-5"): CountableAgent => ({
  kind: "root",
  sessionId,
  model,
  usage: {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheCreate1hTokens: 0, cacheCreate5mTokens: 0, reasoningOutputTokens: 0,
  },
} as never);

describe("what the canvas contributes", () => {
  it("counts session roots and nothing else", () => {
    // A subagent's tokens are already inside its root's total — see the note in
    // reducer.ts — so a node-by-node sum would count them twice.
    const agents: CountableAgent[] = [
      root("s1", 1000, 100),
      { ...root("s2", 500, 50), kind: "subagent" } as CountableAgent,
      { ...root("s3", 500, 50), sessionId: undefined } as CountableAgent,
    ];
    const board = boardBySession(agents);
    expect([...board.keys()]).toEqual(["s1"]);
  });

  it("carries every token class, and a cost", () => {
    const board = boardBySession([root("s1", 1000, 100)]);
    const s = board.get("s1")!;
    expect(s.inputTokens).toBe(1000);
    expect(s.outputTokens).toBe(100);
    expect(s.cost).toBeGreaterThan(0);
  });
});

describe("the delta against a baseline", () => {
  it("is nothing when nothing has happened", () => {
    const board = boardBySession([root("s1", 1000, 100)]);
    expect(liveDelta(board, board)).toEqual(NO_DELTA);
  });

  it("counts only the increase for a session the reading already included", () => {
    // The whole point: ccusage counted s1's first thousand tokens, so adding
    // them again would double the day.
    const before = boardBySession([root("s1", 1000, 100)]);
    const after = boardBySession([root("s1", 1600, 180)]);
    const d = liveDelta(before, after);
    expect(d.inputTokens).toBe(600);
    expect(d.outputTokens).toBe(80);
    expect(d.sessions).toBe(1);
    expect(d.cost).toBeGreaterThan(0);
  });

  it("counts nothing for a session the baseline never saw", () => {
    // This case used to assert the opposite, on the reading that a session the
    // baseline never saw is work ccusage cannot have counted. That is true of a
    // session which did not exist yet and false of the ordinary case, which is
    // a session that existed all along and had not reached the CANVAS yet.
    //
    // Measured on a deck four seconds old: ccusage answered $450.28 for today
    // and the panel printed $1,006. The reading lands ~2.5s after boot while
    // the canvas is still replaying, so the baseline was taken over an almost
    // empty board, and every session that then appeared — each already inside
    // ccusage's $450 — was added again in full.
    const before = boardBySession([root("s1", 1000, 100)]);
    const after = boardBySession([root("s1", 1000, 100), root("s2", 400, 40)]);
    const d = liveDelta(before, after);
    expect(d.inputTokens).toBe(0);
    expect(d.sessions).toBe(0);
  });

  it("does count that session once it grows under the deck's own eyes", () => {
    // The other half, and why the correction is not simply "ignore arrivals
    // forever". The next reading re-takes the baseline with the session in it,
    // and from then on its growth is the deck's to report — which is the whole
    // point of the delta. Worst case a genuinely new session waits one poll.
    const landed = boardBySession([root("s1", 1000, 100), root("s2", 400, 40)]);
    const later = boardBySession([root("s1", 1000, 100), root("s2", 700, 70)]);
    const d = liveDelta(landed, later);
    expect(d.inputTokens).toBe(300);
    expect(d.sessions).toBe(1);
  });

  it("never goes backwards when a finished session is evicted", () => {
    // pruneDoneSessions takes a session off the canvas about two minutes after
    // it ends. A board-wide subtraction would drop the headline UNDER a total
    // that already counted that session — the defect #687 is about, one level
    // worse.
    const before = boardBySession([root("s1", 1000, 100), root("s2", 900, 90)]);
    const after = boardBySession([root("s1", 1000, 100)]);
    expect(liveDelta(before, after)).toEqual(NO_DELTA);
  });

  it("ignores a session whose totals went down", () => {
    // A replay, or a deck restarted mid-session. Not a refund, and not
    // something to interpret.
    const before = boardBySession([root("s1", 5000, 500)]);
    const after = boardBySession([root("s1", 1000, 100)]);
    expect(liveDelta(before, after)).toEqual(NO_DELTA);
  });

  it("adds up across several sessions at once, and only the ones it was watching", () => {
    // s3 is an arrival and contributes nothing; s1 and s2 were in the baseline
    // and contribute their growth. Written as one case rather than two because
    // the mistake this guards is a sum that reaches for every key in `current`.
    const before = boardBySession([root("s1", 1000, 100), root("s2", 200, 20)]);
    const after = boardBySession([root("s1", 1500, 150), root("s2", 700, 70), root("s3", 50, 5)]);
    const d = liveDelta(before, after);
    expect(d.inputTokens).toBe(500 + 500);
    expect(d.outputTokens).toBe(50 + 50);
    expect(d.sessions).toBe(2);
  });

  it("is nothing at all before the first reading has landed", () => {
    // No baseline means no idea what ccusage already counted, and guessing
    // would double the day.
    expect(liveDelta(null, boardBySession([root("s1", 1000, 100)]))).toEqual(NO_DELTA);
  });
});
