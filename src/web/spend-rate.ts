// The usage header's $/min, as spend over a trailing window (#821).
//
// It used to be the total cost of the agents that happen to be live divided by
// how long the longest-running of them had been running. Both halves moved for
// reasons that have nothing to do with spending: an agent finishing took its
// cost out of the numerator, and the longest one's clock starts at the first
// event THIS page saw (#822), so the same deck read $2.39/min in a tab left
// open and $19.49/min in one opened minutes later. A headline money figure that
// moves eightfold with which tab you look at makes every figure beside it look
// untrustworthy.
//
// What a reader means by "how fast am I spending" is the change in the board's
// total over the last few minutes, so that is what this measures: the board
// total is sampled against the clock, and the rate is how far it rose across
// the samples still inside the window. Out here so the suite can drive it with
// no DOM, the way count-up.ts and live-delta.ts are.

export interface SpendSample {
  /** Wall-clock milliseconds. */
  t: number;
  /**
   * Spend this deck has WATCHED happen, cumulative and monotonic, in dollars.
   *
   * Not the board's total. The board gains a session's ENTIRE accumulated cost
   * the moment that session first reaches the canvas — a Claude session that
   * started before the deck and whose first hook event lands now, a rollout the
   * Codex watcher picks up mid-flight, a Stop-evicted session returning under
   * the same id, which reducer.ts records as routine — and none of that is
   * money spent in the last ten minutes. This counter only ever rises by what
   * a session gained BETWEEN two samples it appeared in both of.
   */
  watched: number;
}

/** Per-session spend right now, keyed by session id: what `boardBySession`
 *  already produces for the panel's live delta, read for its `cost` alone. */
export type SpendBySession = ReadonlyMap<string, { cost: number }>;

/**
 * Everything the board gained between two samples, counting only the sessions
 * that were in BOTH.
 *
 * The rule `live-delta.ts` states and this module could not follow while it
 * sampled a board-wide total: "this delta may only ever add work it has
 * WATCHED happen, never work it has merely learned about." A session that has
 * just joined contributes nothing until its second sample, which is the correct
 * answer — the deck did not watch that money being spent. A session that has
 * LEFT contributes nothing either, and cannot drag the figure backwards.
 */
function watchedRise(prev: SpendBySession, now: SpendBySession, dtMs: number): number {
  // PER ELAPSED SAMPLE, not per sample. The threshold is a rate — its own
  // comment calls it "$240 a minute" — and two samples are five seconds apart
  // only while the tab is in front. A backgrounded tab is throttled to about
  // one timer a second at best and can be suspended outright, so the gap is
  // routinely minutes, and a flat ceiling would throw away a session's real
  // spending for the whole time somebody was looking at something else.
  const ceiling = SPEND_JUMP_USD * Math.max(1, dtMs / SAMPLE_EVERY_MS);
  let sum = 0;
  for (const [sid, cur] of now) {
    const was = prev.get(sid);
    if (was === undefined) continue;
    const rise = cur.cost - was.cost;
    // Per session, where the threshold can mean what its name says. One session
    // gaining more than this is a correction landing all at once — a transcript
    // pass pricing a whole session's subagents — and not spending.
    if (rise > 0 && rise <= ceiling) sum += rise;
  }
  return sum;
}

/** The samples in the window, plus what the last of them was measured against. */
export interface SpendHistory {
  samples: readonly SpendSample[];
  /** Per-session costs at the most recent sample, to diff the next one against.
   *  Empty before the first sample, which is why the first sample can only ever
   *  establish a baseline and never contribute a rise. */
  last: SpendBySession;
  /** The running counter the samples carry, so trimming the window never has
   *  to recompute it. */
  watched: number;
}

export const NO_SPEND_HISTORY: SpendHistory = { samples: [], last: new Map(), watched: 0 };

/** How far back the rate looks. */
export const SPEND_WINDOW_MS = 10 * 60_000;
/** Less than this and a rate is a guess: say nothing yet. */
export const SPEND_MIN_SPAN_MS = 60_000;
/** The panel recomputes four times a second; a sample every few seconds is
 *  plenty for a ten-minute window and keeps the list to about 120 entries. */
export const SAMPLE_EVERY_MS = 5_000;
/** More than this, from ONE session, between two samples at most five seconds
 *  apart is not spending. It is $240 a minute; what does that is a correction
 *  landing all at once, such as a transcript pass pricing a whole session's
 *  subagents.
 *
 *  PER SESSION since #987, and that is the whole difference between a threshold
 *  that means something and one that was the only thing standing between the
 *  headline and every session's accumulated history. Against the board total it
 *  had to be larger than any single session's lifetime cost to be safe, and it
 *  never was: an hour-old session carrying $15 walked straight under it and the
 *  rate read 8.56x the truth for a full window. Against one session's rise
 *  across five seconds it is the absurd figure it was always described as. */
export const SPEND_JUMP_USD = 20;

/**
 * This moment's per-session spend, folded into the samples still in the window.
 *
 * NO RESETS ANY MORE, and none needed. The two the board-wide version had were
 * both repairs for reading one number that could move for reasons other than
 * spending: a total that went DOWN meant sessions had left the board — pruned,
 * or the canvas cleared — and a total that leapt UP meant a correction or a
 * session arriving with history. Summing per-session rises answers all three by
 * construction: a session that left is not in `now`, a session that arrived is
 * not in `prev`, and a correction is caught by the per-session threshold. The
 * window is now only ever trimmed by age, so a board that loses a session keeps
 * the ten minutes of rate it honestly measured.
 */
export function recordSpend(h: SpendHistory, t: number, bySession: SpendBySession): SpendHistory {
  const last = h.samples[h.samples.length - 1];
  if (last && t - last.t < SAMPLE_EVERY_MS) return h;
  const watched = h.watched + watchedRise(h.last, bySession, last ? t - last.t : 0);
  const kept = h.samples.filter(s => t - s.t <= SPEND_WINDOW_MS);
  kept.push({ t, watched });
  return { samples: kept, last: bySession, watched };
}

export interface SpendRate {
  /** Dollars spent across the span. */
  spent: number;
  /** How long the span is, in seconds — what the rate is divided by. */
  spanSec: number;
  /** The same span in whole minutes, for the label: never more than the window. */
  spanMin: number;
}

/**
 * How much the board spent across the samples, or null when there is nothing
 * honest to say: under a minute of history, or no spending in the window at
 * all — a quiet board has no rate, and "$0.00/min" in the headline would be a
 * figure pretending to be news.
 */
export function spendRate(h: SpendHistory, t: number, bySession: SpendBySession): SpendRate | null {
  const first = h.samples[0];
  if (!first) return null;
  const spanMs = t - first.t;
  if (spanMs < SPEND_MIN_SPAN_MS) return null;
  // Up to `now`, not up to the last sample: the panel recomputes four times a
  // second and samples every five, so reading only the samples would hold the
  // figure still for five seconds at a time.
  const lastAt = h.samples[h.samples.length - 1]!.t;
  const spent = (h.watched + watchedRise(h.last, bySession, t - lastAt)) - first.watched;
  if (!(spent > 0)) return null;
  return {
    spent,
    spanSec: spanMs / 1000,
    spanMin: Math.min(SPEND_WINDOW_MS / 60_000, Math.ceil(spanMs / 60_000)),
  };
}
