import { describe, expect, it } from "vitest";
import {
  formatHistoryAxis,
  historyTimeDomain,
  clampHistoryRange,
  zoomHistoryRange,
} from "../account-history";

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

describe("history chart navigation", () => {
  const full = { start: now - DAY, end: now };
  it("zooms around the chosen instant", () => {
    const range = zoomHistoryRange(full, full, 0.5, 0.25);
    expect(range.end - range.start).toBe(DAY / 2);
    expect(range.start + (range.end - range.start) * 0.25).toBe(
      full.start + DAY / 4,
    );
  });
  it("clamps panning to the available domain without changing zoom", () => {
    const span = 3600_000;
    expect(
      clampHistoryRange({ start: full.start - span, end: full.start }, full),
    ).toEqual({ start: full.start, end: full.start + span });
    expect(
      clampHistoryRange({ start: full.end, end: full.end + span }, full),
    ).toEqual({ start: full.end - span, end: full.end });
  });
  it("limits zoom to five minutes and zoom-out to the full domain", () => {
    const tiny = zoomHistoryRange(full, full, 0.000001);
    expect(tiny.end - tiny.start).toBe(5 * MINUTE);
    expect(zoomHistoryRange(tiny, full, 1e6)).toEqual(full);
  });
  it("recovers when the available domain changes", () => {
    const narrowed = { start: now - 30 * MINUTE, end: now };
    expect(clampHistoryRange(full, narrowed)).toEqual(narrowed);
  });
});
