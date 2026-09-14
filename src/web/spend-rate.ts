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
  /** The board's total spend at that moment, in dollars. */
  cost: number;
}

/** How far back the rate looks. */
export const SPEND_WINDOW_MS = 10 * 60_000;
/** Less than this and a rate is a guess: say nothing yet. */
export const SPEND_MIN_SPAN_MS = 60_000;
/** The panel recomputes four times a second; a sample every few seconds is
 *  plenty for a ten-minute window and keeps the list to about 120 entries. */
const SAMPLE_EVERY_MS = 5_000;
/** More than this between two samples — at most five seconds apart — is not
 *  spending. It is $240 a minute; what does that is a correction landing all
 *  at once, such as a transcript pass pricing a whole session's subagents. */
export const SPEND_JUMP_USD = 20;

/**
 * This moment's board total, added to the samples that are still in the window.
 *
 * A total that went DOWN means sessions left the board — pruned, or the canvas
 * cleared — not money coming back, so the window starts again from here rather
 * than reading the drop as a negative rate or averaging across it. A total that
 * leapt up by more than SPEND_JUMP_USD since the last sample is the same kind
 * of event in the other direction, and starts the window again too.
 */
export function recordSpend(samples: readonly SpendSample[], t: number, cost: number): SpendSample[] {
  const last = samples[samples.length - 1];
  if (last && (cost < last.cost || cost - last.cost > SPEND_JUMP_USD)) return [{ t, cost }];
  const kept = samples.filter(s => t - s.t <= SPEND_WINDOW_MS);
  if (!last || t - last.t >= SAMPLE_EVERY_MS) kept.push({ t, cost });
  return kept;
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
export function spendRate(samples: readonly SpendSample[], t: number, cost: number): SpendRate | null {
  const first = samples[0];
  if (!first) return null;
  const spanMs = t - first.t;
  if (spanMs < SPEND_MIN_SPAN_MS) return null;
  const spent = cost - first.cost;
  if (!(spent > 0)) return null;
  return {
    spent,
    spanSec: spanMs / 1000,
    spanMin: Math.min(SPEND_WINDOW_MS / 60_000, Math.ceil(spanMs / 60_000)),
  };
}
