// The Projects report's money must add up. These pin the invariant the
// reconciliation is built to guarantee — the one whose absence made the period
// total ($33.99) disagree with the only attributed day's total ($38.41):
//
//   Σ project totals === Σ daily totals === the period's attributed total,
//   and (with ccusage) attributed + unattributed === the window's ccusage total.
import { describe, it, expect } from "vitest";
import { reconcile, type Counters, type DayInput } from "../account-projects-reconcile";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const c = (i: number, o: number, cr = 0, cc = 0): Counters => ({ i, o, cr, cc, c1h: 0, c5m: 0 });
const M = "claude-opus-5";
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** One day, two projects and same-day unattributed — the screenshot's shape. */
const oneDay: DayInput[] = [{
  day: "2026-09-22",
  projects: [
    { path: "/u/agents-deck", models: { [M]: c(20_000, 400_000, 60_000_000, 6_000_000) } },
    { path: "/u/vcrm-core", models: { [M]: c(9_000, 150_000, 10_000_000, 900_000) } },
  ],
  unattributed: { [M]: c(1_000, 20_000, 900_000, 90_000) },
}];

describe("the reconciliation invariant", () => {
  it("makes Σ project = Σ day = period total, on the single-day case that exposed the bug", () => {
    // ccusage priced the window at $1897; only $38.41 of it was on the tracked
    // day, the rest is earlier unattributed days not present in `daily`.
    const ccByDayModel = new Map<string, number>([[`2026-09-22|${M}`, 38.41]]);
    const ccWindowTotal = 1897;
    const r = reconcile(oneDay, oneDay[0].unattributed, ccByDayModel, ccWindowTotal, NOW);

    expect(r.reconciled).toBe(true);
    const dayTotals = sum(r.perDay.map(d => d.total));
    const projTotals = sum(r.projects.map(p => p.cost));
    expect(close(r.totalCost, dayTotals)).toBe(true);
    expect(close(r.totalCost, projTotals)).toBe(true);
    // One attributed day ⇒ the period total IS that day's total (no divergence).
    expect(r.perDay).toHaveLength(1);
    expect(close(r.totalCost, r.perDay[0].total)).toBe(true);
    // Attributed + unattributed reconstructs the window's ccusage spend exactly.
    expect(r.unattributed).not.toBeNull();
    expect(close(r.totalCost + r.unattributed!.cost, ccWindowTotal)).toBe(true);
    // The tracked day is a slice of the window, so its total is under it.
    expect(r.totalCost).toBeGreaterThan(0);
    expect(r.totalCost).toBeLessThan(ccWindowTotal);
  });

  it("holds the same invariant across several days", () => {
    const daily: DayInput[] = [
      { day: "2026-09-20", projects: [{ path: "/u/a", models: { [M]: c(5_000, 80_000, 2_000_000, 200_000) } }], unattributed: null },
      { day: "2026-09-21", projects: [
        { path: "/u/a", models: { [M]: c(3_000, 40_000, 1_000_000, 100_000) } },
        { path: "/u/b", models: { [M]: c(2_000, 30_000, 800_000, 80_000) } },
      ], unattributed: { [M]: c(500, 5_000, 100_000, 10_000) } },
      { day: "2026-09-22", projects: [{ path: "/u/b", models: { [M]: c(6_000, 90_000, 3_000_000, 300_000) } }], unattributed: null },
    ];
    const ccByDayModel = new Map<string, number>([
      [`2026-09-20|${M}`, 4], [`2026-09-21|${M}`, 3], [`2026-09-22|${M}`, 6],
    ]);
    const r = reconcile(daily, daily[1].unattributed, ccByDayModel, 13, NOW);
    expect(close(r.totalCost, sum(r.perDay.map(d => d.total)))).toBe(true);
    expect(close(r.totalCost, sum(r.projects.map(p => p.cost)))).toBe(true);
    expect(close(r.totalCost + (r.unattributed?.cost ?? 0), 13)).toBe(true);
    // Two projects, ordered by descending reconciled cost.
    expect(r.projects).toHaveLength(2);
    expect(r.projects[0].cost).toBeGreaterThanOrEqual(r.projects[1].cost);
  });

  it("falls back to pricing.ts when ccusage is unavailable, and still balances", () => {
    const r = reconcile(oneDay, oneDay[0].unattributed, new Map(), 0, NOW);
    expect(r.reconciled).toBe(false);
    // Every project priced, Σ project = Σ day = total, unattributed priced too.
    expect(close(r.totalCost, sum(r.perDay.map(d => d.total)))).toBe(true);
    expect(close(r.totalCost, sum(r.projects.map(p => p.cost)))).toBe(true);
    expect(r.totalCost).toBeGreaterThan(0);
    expect(r.unattributed!.cost).toBeGreaterThan(0);
  });

  it("counts a project's billed tokens as input+output+cache, and leaves no residual when the day is fully attributed", () => {
    // A day with no unattributed work: the whole day's ccusage cost lands on
    // its projects, so nothing is left over.
    const fullyAttributed: DayInput[] = [{
      day: "2026-09-22",
      projects: oneDay[0].projects,
      unattributed: null,
    }];
    const r = reconcile(fullyAttributed, null, new Map([[`2026-09-22|${M}`, 38.41]]), 38.41, NOW);
    expect(r.projects[0].path).toBe("/u/agents-deck");   // more tokens ⇒ leads
    expect(r.projects[0].tokens).toBe(20_000 + 400_000 + 60_000_000 + 6_000_000);
    expect(close(r.totalCost, 38.41)).toBe(true);        // attributed = the day's ccusage cost
    expect(r.unattributed).toBeNull();                   // nothing left over
  });
});
