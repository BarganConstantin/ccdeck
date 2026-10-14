import { describe, expect, it } from "vitest";
import { formatHistoryAxis, historyTimeDomain } from "../account-history";

const MINUTE = 60_000;
const DAY = 86400_000;
const now = Date.UTC(2026, 9, 14, 12);

describe("adaptive history time axis", () => {
  it("fits a few minutes of observations instead of a week of empty space", () => {
    const { start, end } = historyTimeDomain(
      [now - 5 * MINUTE, now],
      now - 7 * DAY,
      now,
    );
    expect(end - start).toBe(35 * MINUTE);
    expect(start).toBe(now - 20 * MINUTE);
    expect(end).toBe(now + 15 * MINUTE);
  });

  it("centers a single observation in a nonzero domain", () => {
    const { start, end } = historyTimeDomain([now], now - 7 * DAY, now);
    expect(end - start).toBe(30 * MINUTE);
    expect((now - start) / (end - start)).toBe(0.5);
  });

  it("does not extend history with invalid or out-of-period observations", () => {
    expect(
      historyTimeDomain(
        [NaN, Infinity, now - 10 * DAY, now + MINUTE, now],
        now - 7 * DAY,
        now,
      ),
    ).toEqual(historyTimeDomain([now], now - 7 * DAY, now));
  });

  it("preserves the empty-state range when no readings are available", () => {
    expect(historyTimeDomain([], now - 7 * DAY, now)).toEqual({
      start: now - 7 * DAY,
      end: now,
    });
  });

  it("uses proportional padding for longer history regardless of point order", () => {
    expect(
      historyTimeDomain([now, now - 6 * DAY, now], now - 7 * DAY, now),
    ).toEqual({ start: now - 6.3 * DAY, end: now + 0.3 * DAY });
  });

  it("shows time for short ranges and dates for multi-day ranges", () => {
    const short = formatHistoryAxis(now, now - MINUTE, now + MINUTE);
    expect(short).toMatch(/\d{1,2}:\d{2}/);
    const long = formatHistoryAxis(now, now - 7 * DAY, now);
    expect(long).not.toMatch(/\d{1,2}:\d{2}/);
    expect(long).toContain("14");
  });
});
