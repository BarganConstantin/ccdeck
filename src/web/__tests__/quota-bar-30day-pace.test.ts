// A thirty-day Codex window is paced over its own reported length, and its
// note can say what a day may cost to last until the reset (CodexBar #4766,
// #4677). The pace arithmetic takes the window's seconds, never 5h or 7d.
import { describe, expect, it } from "vitest";
import { computePace, monthlyDailyTarget } from "../components/QuotaBar";

const DAY = 86_400;
const MONTH = 30 * DAY;
const sec = (d: Date) => d.getTime() / 1000;

describe("pace over a thirty-day window", () => {
  it("measures the elapsed share against thirty days", () => {
    const now = 1_800_000_000;
    // Ten days in: a third of the window is gone.
    const p = computePace(50, now + 20 * DAY, MONTH, now)!;
    expect(Math.round(p.expectedPct)).toBe(33);
    expect(p.label).toBe("17% over pace");
    expect(computePace(33, now + 20 * DAY, MONTH, now)!.label).toBe("on pace");
    expect(computePace(10, now + 20 * DAY, MONTH, now)!.label).toBe("23% under pace");
  });

  it("does not warn a run-out beyond a day away", () => {
    const now = 1_800_000_000;
    expect(computePace(50, now + 20 * DAY, MONTH, now)!.runsOutIn).toBeUndefined();
  });
});

describe("the daily target of a monthly window", () => {
  it("spreads what is left over the local calendar days to the reset", () => {
    const now = new Date(2026, 5, 10, 15, 0, 0);          // 10 Jun, afternoon
    const reset = new Date(2026, 5, 30, 8, 0, 0);         // 30 Jun, morning: today + 20 days = 21 dates
    expect(monthlyDailyTarget(79, sec(reset), MONTH, sec(now))).toBeCloseTo(1, 5);
  });

  it("adds no extra day for a reset exactly at midnight", () => {
    const now = new Date(2026, 5, 10, 15, 0, 0);
    const reset = new Date(2026, 5, 30, 0, 0, 0);         // 10..29 = 20 dates
    expect(monthlyDailyTarget(60, sec(reset), MONTH, sec(now))).toBeCloseTo(2, 5);
  });

  it("counts the last day, and stays silent for other windows", () => {
    const now = new Date(2026, 5, 29, 9, 0, 0);
    const reset = new Date(2026, 5, 29, 23, 0, 0);
    expect(monthlyDailyTarget(40, sec(reset), MONTH, sec(now))).toBeCloseTo(60, 5);
    expect(monthlyDailyTarget(40, sec(reset), 7 * DAY, sec(now))).toBeNull();
    expect(monthlyDailyTarget(40, sec(reset), 5 * 3600, sec(now))).toBeNull();
    expect(monthlyDailyTarget(100, sec(reset), MONTH, sec(now))).toBeNull();
    expect(monthlyDailyTarget(40, sec(now) - 1, MONTH, sec(now))).toBeNull();
  });
});
