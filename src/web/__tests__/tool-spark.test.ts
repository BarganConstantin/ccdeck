// The card's activity chart, run rather than read.
//
// Its counting was the body of ToolRateSpark in AgentNode.tsx, so the suite
// pinned the lines that did it — the two `mark` loops, the peak, the empty
// window's sentence — and could not ask what they produce. sparkWindow and
// barHeight in tool-spark.ts are that body, and these are the answers.
import { describe, expect, it } from "vitest";

import { barHeight, BUCKETS, SPARK_H, sparkWindow, WINDOW_MS } from "../tool-spark";
import type { ToolCall } from "../types";

const NOW = 1_790_550_060_000;
const call = (agoMs: number): ToolCall => ({ startedAt: NOW - agoMs } as ToolCall);
const BUCKET = WINDOW_MS / BUCKETS;

describe("the activity chart's window", () => {
  it("draws a minute as 24 buckets, and says so when nothing is in it", () => {
    const { counts, title } = sparkWindow([], undefined, NOW);
    expect(counts).toEqual(new Array(24).fill(0));
    expect(title).toBe("nothing in the last 60s");
  });

  it("puts the newest mark on the right and the oldest it keeps on the left", () => {
    const { counts } = sparkWindow([call(0), call(WINDOW_MS - 1)], undefined, NOW);
    expect(counts[BUCKETS - 1]).toBe(1);
    expect(counts[0]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("buckets by 2.5 seconds of age", () => {
    const { counts } = sparkWindow([call(BUCKET - 1), call(BUCKET)], undefined, NOW);
    expect(counts[BUCKETS - 1]).toBe(1);
    expect(counts[BUCKETS - 2]).toBe(1);
  });

  it("leaves out a stamp exactly a minute old, and one from the future", () => {
    // The reducer drops outputs by the same edge (output-on-the-card), so the
    // two agree about what a minute is.
    const { counts, title } = sparkWindow([call(WINDOW_MS), call(-1)], [NOW - WINDOW_MS, NOW + 5], NOW);
    expect(counts.every(c => c === 0)).toBe(true);
    expect(title).toBe("nothing in the last 60s");
  });

  it("marks a block of the model's own output the way it marks a call", () => {
    const { counts } = sparkWindow([], [NOW - 1_000], NOW);
    expect(counts[BUCKETS - 1]).toBe(1);
  });

  it("says what it counted, both halves, in the singular and the plural", () => {
    expect(sparkWindow([call(1_000)], undefined, NOW).title).toBe("1 tool call in last 60s · peak 0.4/s");
    expect(sparkWindow([], [NOW - 1_000, NOW - 20_000], NOW).title)
      .toBe("2 blocks of thinking and writing in last 60s · peak 0.4/s");
    expect(sparkWindow([call(1_000), call(30_000)], [NOW - 40_000], NOW).title)
      .toBe("2 tool calls · 1 block of thinking and writing in last 60s · peak 0.4/s");
  });

  it("reports the busiest bucket's rate as its peak", () => {
    // Three marks in one 2.5s bucket is 1.2 a second, and two is 0.8.
    expect(sparkWindow([call(100), call(200)], [NOW - 300], NOW).title).toMatch(/ · peak 1\.2\/s$/);
    expect(sparkWindow([call(100), call(200)], undefined, NOW).title).toMatch(/ · peak 0\.8\/s$/);
  });

  it("counts a tool call outside the window in neither half", () => {
    expect(sparkWindow([call(90_000)], [NOW - 1_000], NOW).title)
      .toBe("1 block of thinking and writing in last 60s · peak 0.4/s");
  });
});

describe("the chart's one scale", () => {
  it("draws an empty bucket as a stub and one mark at half the box", () => {
    expect(barHeight(0)).toBe(1.5);
    expect(barHeight(1)).toBe(SPARK_H / 2);
  });

  it("reaches the top at two marks and clips past it", () => {
    expect(barHeight(2)).toBe(SPARK_H);
    expect(barHeight(7)).toBe(SPARK_H);
  });
});
