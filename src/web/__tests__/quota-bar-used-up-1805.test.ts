// #1805: a quota window already at 100% said "runs out in 0m".
//
// computePace measured what was left as `100 - pct`, which is nothing at 100%,
// so the time to run it out was zero seconds — under the time to reset and
// under a day — and the note under a full red bar read "runs out in 0m", as if
// a moment of allowance were left. A window at its limit says it is used up,
// and the runs-out wording is kept for a window that still has some.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBar, { computePace } from "../components/QuotaBar";

const WINDOW = 18_000;           // five hours
const RESET = 18_000;
const HOUR_LEFT = RESET - 3600;  // four hours in, one to go

const paceText = (html: string) => /class="qb-pace"[^>]*>(?:<i [^>]*><\/i>)?([^<]*)</.exec(html)?.[1];
const bar = (props: { pct: number; nowSec: number; limitReached?: boolean }) =>
  renderToStaticMarkup(createElement(QuotaBar, { label: "5-hour window", resetAt: RESET, windowSec: WINDOW, ...props }));

describe("a quota window at its limit (#1805)", () => {
  it("has no time left to run out in", () => {
    const pace = computePace(100, RESET, WINDOW, HOUR_LEFT)!;
    expect(pace.runsOutIn).toBeUndefined();
    expect(pace.label).toBe("used up");
    expect(pace.isDeficit).toBe(true);
  });

  it("says it is used up under the bar, beside the countdown", () => {
    const html = bar({ pct: 100, nowSec: HOUR_LEFT });
    expect(html).not.toContain("runs out in");
    expect(paceText(html)).toBe("used up");
    expect(html).toContain("resets in 1h");
  });

  it("says used up at the end of the window too, where it was on pace", () => {
    // Five minutes left: 98.3% was the pace, so 100% was within three points
    // of it and read "on pace" beside a full bar.
    expect(computePace(100, RESET, WINDOW, RESET - 300)!.label).toBe("used up");
    expect(paceText(bar({ pct: 100, nowSec: RESET - 300 }))).toBe("used up");
  });

  it("says used up when the source flags the limit before the bar is full", () => {
    expect(computePace(97, RESET, WINDOW, HOUR_LEFT, true)!.label).toBe("used up");
    expect(paceText(bar({ pct: 97, nowSec: HOUR_LEFT, limitReached: true }))).toBe("used up");
  });

  it.each([
    // [pct, what the note says] with an hour of a five-hour window left
    [99, "runs out in 2m"],
    [95, "runs out in 12m"],
    [90, "runs out in 26m"],
    [85, "runs out in 42m"],
    [80, "on pace"],
    [70, "10% under pace"],
  ])("still gives a window at %d%% its pace: %s", (pct, text) => {
    expect(paceText(bar({ pct, nowSec: HOUR_LEFT }))).toBe(text);
  });
});
