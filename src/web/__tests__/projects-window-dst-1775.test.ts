// #1775. The Projects report's last 7 and 30 days started one calendar day
// early or late in the week after a clock change.
//
// Both halves of the report found the window's first day the same way: the
// local date of `now − (span − 1) × 24h` — projectsUrls for the ccusage range
// the page asks for, windowCutoff for the server's own tally. A span that
// crosses a daylight-saving change holds a 23- or a 25-hour day, so for one hour
// of each day that subtraction lands on the wrong date. The two agreed with
// each other, which is why the report never looked inconsistent, and both
// disagreed with the Usage panel's preset for the same span (presetSince, which
// counts calendar days).
//
// Pinned to America/New_York, where 2026's clocks go forward on 8 March and
// back on 1 November. `process.env.TZ` is assigned for this file and restored
// after it, and the first case proves the zone took before any answer is read,
// so a runtime that ignored the assignment fails loudly here rather than
// passing in the runner's own zone. Every instant is built INSIDE a case, after
// the assignment, from New York wall-clock fields.
import { afterAll, describe, expect, it } from "vitest";
import { projectsUrls } from "../account-projects-load";
import { presetSince } from "../usage-range";
import { windowCutoff } from "../../server/account-projects.mjs";

const PREV_TZ = process.env.TZ;
process.env.TZ = "America/New_York";
afterAll(() => {
  if (PREV_TZ === undefined) delete process.env.TZ; else process.env.TZ = PREV_TZ;
});

/** 00:30 on the second day after spring-forward: 7 days back crosses the 23h day. */
const spring = () => new Date(2026, 2, 10, 0, 30).getTime();
/** 23:30 on the second day after fall-back: 7 days back crosses the 25h day. */
const autumn = () => new Date(2026, 10, 3, 23, 30).getTime();

describe("the Projects window counts calendar days across a clock change (#1775)", () => {
  it("runs in New York, with its two offsets", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
  });

  it("asks ccusage for seven calendar days after spring-forward", () => {
    expect(projectsUrls(1, 7, spring()).ccusage).toBe("/api/ccusage?since=20260304&until=20260310");
  });

  it("asks ccusage for seven calendar days after fall-back", () => {
    expect(projectsUrls(1, 7, autumn()).ccusage).toBe("/api/ccusage?since=20261028&until=20261103");
  });

  it("asks for thirty calendar days across the change, too", () => {
    expect(projectsUrls(1, 30, spring()).ccusage).toBe("/api/ccusage?since=20260209&until=20260310");
    expect(projectsUrls(1, 30, autumn()).ccusage).toBe("/api/ccusage?since=20261005&until=20261103");
  });

  it("cuts the server's tally at the same calendar day", () => {
    expect(windowCutoff(7, spring())).toBe("2026-03-04");
    expect(windowCutoff(7, autumn())).toBe("2026-10-28");
    expect(windowCutoff(30, spring())).toBe("2026-02-09");
    expect(windowCutoff(30, autumn())).toBe("2026-10-05");
  });

  it("starts where the Usage panel's preset for the same span starts", () => {
    for (const now of [spring(), autumn()]) {
      for (const span of [7, 30]) {
        const since = presetSince(span, new Date(now));
        expect(projectsUrls(1, span, now).ccusage).toContain(`since=${since}&`);
        expect(windowCutoff(span, now)).toBe(`${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6)}`);
      }
    }
  });
});
