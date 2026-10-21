import { describe, expect, it } from "vitest";
import { account, NOW } from "./fixtures/capacity-account";
import { usageReport, readingOf, shownUsed } from "../accounts-usage-report";
import { headroomAt } from "../lane-view";
import { resetCalendar } from "../account-reset-calendar";

describe("capacity renewal requires an observation", () => {
  it("does not advertise free headroom by dropping an exhausted elapsed window", () => {
    const a = { ...account(), headroom: 0, lanes: [
      { id: "five_hour", label: "5h", pct: 100, resetAt: NOW - 1 },
      { id: "seven_day", label: "7d", pct: 1, resetAt: NOW + 3600 },
    ] };
    expect(headroomAt(a, NOW)).toBeNull();
  });
  it("does not promote exhausted readings to ready when their reset timestamp passes", () => {
    const r = usageReport([account()], NOW);
    expect(r.roomInBoth).toBe(0);
    expect(r.rows[0].status).toBe("exhausted");
    expect(r.windows.map(w => w.used)).toEqual([100, 100]);
    expect(r.windows.map(w => w.reporting)).toEqual([0, 0]);
  });
});

describe("temporal and percentage invariants", () => {
  it("keeps unknown reset times unknown and handles the exact expiry boundary", () => {
    for (const resetAt of [null, -1, 0, NaN, Infinity, 1e20]) {
      const a = { ...account(), lanes: [{ id: "seven_day", label: "7d", pct: 70, resetAt }] };
      expect(resetCalendar([a], NOW).unscheduled[0].reason).toBe("unknown");
    }
    expect(resetCalendar([account(NOW)], NOW).unscheduled[0].reason).toBe("passed");
    expect(resetCalendar([account(NOW + 1)], NOW).days.reduce((n, d) => n + d.scheduled, 0)).toBe(1);
  });
  it("never counts impossible observation stamps as fresh", () => {
    for (const fetchedAt of [NaN, Infinity, 1e20, -1]) {
      const a = { ...account(NOW + 3600), fetchedAt };
      expect(readingOf(a, "seven_day", NOW).counted).toBe(false);
      expect(resetCalendar([a], NOW).days.reduce((n, d) => n + d.outdated, 0)).toBe(1);
    }
  });
  it.each([[0, 0], [1, 1], [69, 69], [70, 70], [99, 99], [100, 100], [-3, 0], [140, 100]])("keeps %s percent in its own window, capped to %s", (pct, expected) => {
    const a = { ...account(NOW + 3600), lanes: [{ id: "seven_day", label: "7d", pct, resetAt: NOW + 3600 }] };
    expect(usageReport([a], NOW).windows[1].used).toBe(expected);
    expect(resetCalendar([a], NOW).days.flatMap(d => d.entries)[0].used).toBe(expected);
    expect(shownUsed(expected)).toBe(expected);
  });
  it("partitions every account into exactly one calendar category", () => {
    const all = [account(NOW + 1), { ...account(NOW + 3600), num: 2, stale: true }, { ...account(NOW - 1), num: 3 }, { ...account(NOW + 10 * 86400), num: 4 }];
    const r = resetCalendar(all, NOW);
    expect(r.days.reduce((n, d) => n + d.scheduled, 0)).toBe(1);
    expect(r.days.reduce((n, d) => n + d.outdated, 0)).toBe(1);
    expect(r.unscheduled).toHaveLength(2);
    expect(r.days.flatMap(d => d.entries).concat(r.unscheduled)).toHaveLength(4);
  });
});
