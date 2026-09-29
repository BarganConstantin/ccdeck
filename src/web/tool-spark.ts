// The card's activity chart, counted: which of the last minute's buckets
// hold a tool call or a block of the model's own output, and the sentence its
// tooltip says about them.
//
// Pure given the calls, the blocks and the time, and it was the body of
// ToolRateSpark in AgentNode.tsx, where the suite could only read it. The leaf
// keeps its own one-second beat (#873) and draws the bars; the counting and
// the scale they are drawn to are here, where they can be run.
import type { ToolCall } from "./types";

/** A minute, in 24 buckets of 2.5s, drawn into a 132 × 14 box. */
export const WINDOW_MS = 60_000;
export const BUCKETS = 24;
const BUCKET_MS = WINDOW_MS / BUCKETS;
export const SPARK_W = 132;
export const SPARK_H = 14;

/** The activity chart.
 *
 *  IT USED TO COUNT ONLY TOOL CALLS, and that is why a working card read as an
 *  idle one. Between a tool's result and the next tool's call the model is
 *  reading, reasoning and writing — 16.5% of measured time on this machine,
 *  more than the time spent inside the tools themselves — and the chart drew a
 *  flat line through all of it. A chart labelled `60s` on a card whose only
 *  other movement is a clock is the element a reader checks to answer "is this
 *  thing doing anything", and it was answering no while the answer was yes.
 *
 *  It counts both now. A tool call is one mark and a completed block of the
 *  model's own output is another, so the line moves whenever the session does
 *  and is flat only when the session genuinely is. */
export function sparkWindow(tools: ToolCall[], outputs: number[] | undefined, now: number): { counts: number[]; title: string } {
  const counts: number[] = new Array(BUCKETS).fill(0);
  let total = 0;
  const mark = (at: number) => {
    const age = now - at;
    if (age < 0 || age >= WINDOW_MS) return;
    const idx = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
    if (idx >= 0 && idx < BUCKETS) {
      counts[idx] += 1;
      total += 1;
    }
  };
  for (const t of tools) mark(t.startedAt);
  for (const at of outputs ?? []) mark(at);
  const observedPeak = Math.max(0, ...counts);
  const peakRate = observedPeak / (BUCKET_MS / 1000);
  // Says what it counted rather than naming only half of it — the chart moving
  // on a card with no tool call in a minute is otherwise a reader's puzzle.
  const toolMarks = tools.filter(t => now - t.startedAt >= 0 && now - t.startedAt < WINDOW_MS).length;
  const blockMarks = total - toolMarks;
  const parts = [
    toolMarks > 0 ? `${toolMarks} tool ${toolMarks === 1 ? "call" : "calls"}` : "",
    blockMarks > 0 ? `${blockMarks} ${blockMarks === 1 ? "block" : "blocks"} of thinking and writing` : "",
  ].filter(Boolean);
  const title = total === 0
    ? "nothing in the last 60s"
    : `${parts.join(" · ")} in last 60s · peak ${peakRate.toFixed(1)}/s`;
  return { counts, title };
}

// ONE SCALE FOR EVERY CARD ON THE CANVAS. This used to be
// `Math.max(1, ...counts)` — each card normalised to its own busiest bucket,
// so a session at one call per bucket and a session at twelve drew the
// IDENTICAL chart. Two charts that cannot be told apart are not comparing
// anything, and comparing sessions is the only reason a graph exists rather
// than a list.
//
// A fixed ceiling rather than the canvas maximum, which was the other way to
// make them comparable and is worse: the busiest card would set the scale for
// all of them, so every chart on screen would silently redraw when an
// unrelated session spiked, and a card nobody touched would appear to calm
// down. A constant means a bar height is the same quantity in every card, at
// every moment, whatever else is on the canvas.
//
// TWO, MEASURED — and it was four, guessed, back when this counted only tool
// calls. Over 14,194 real 2.5s buckets: 92.5% hold nothing, 6.9% hold exactly
// one, and 0.7% hold more than one. p90 is 1 and p99 is 3. At a ceiling of
// four the ordinary active bucket drew a 3.5px stub in a 14px box and the
// chart spent its whole range on a case that happens once in a thousand.
//
// What the chart is actually reading, at this density, is HOW MANY of the 24
// buckets have anything in them — a session working steadily fills them, a
// stalling one does not — so the height per bucket matters less than that a
// single mark is unmistakably a mark. Two puts one at half the box and clips
// only the 0.1% of buckets past it, where the tooltip carries the real
// figure, as it always has.
const FULL_SCALE = 2;

/** How tall a bucket's bar is drawn: a 1.5px stub for an empty bucket, and
 *  against FULL_SCALE above it, clipped at the box. */
export function barHeight(c: number): number {
  return c === 0 ? 1.5 : Math.max(1.5, Math.min(1, c / FULL_SCALE) * SPARK_H);
}
