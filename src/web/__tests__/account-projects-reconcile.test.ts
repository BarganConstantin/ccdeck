// The Projects report's money must add up AND must not inflate. These pin two
// rules the reconciliation is built to guarantee:
//   1. Σ project totals === Σ daily totals === the period's attributed total.
//   2. our tokens are priced at ccusage's own per-token rate — so tracking only
//      part of a day gives a fraction of that day's cost, never the whole of it
//      applied to a sliver of tokens (the bug that made $139 out of 12.65M).
import { describe, it, expect } from "vitest";
import { reconcile, toUsage, type Counters, type DayInput, type CcCell } from "../account-projects-reconcile";
import { costForUsage } from "../pricing";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const c = (i: number, o: number, cr = 0, cc = 0): Counters => ({ i, o, cr, cc, c1h: 0, c5m: 0 });
const M = "claude-opus-5";
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const price = (models: Record<string, Counters>) => Object.entries(models).reduce((s, [m, v]) => s + costForUsage(toUsage(v), m, NOW).total, 0);

/** A ccusage cell whose tokens are `mult`× the given counters, at cost `cost`. */
function cell(models: Record<string, Counters>, cost: number, mult = 1): CcCell {
  const t = models[M];
  return { cost, usage: { inputTokens: t.i * mult, outputTokens: t.o * mult, cacheReadTokens: t.cr * mult, cacheCreateTokens: t.cc * mult, cacheCreate1hTokens: 0, cacheCreate5mTokens: 0 } };
}

const day1: DayInput[] = [{
  day: "2026-09-22",
  projects: [
    { path: "/u/agents-deck", models: { [M]: c(20_000, 400_000, 60_000_000, 6_000_000) } },
    { path: "/u/vcrm-core", models: { [M]: c(9_000, 150_000, 10_000_000, 900_000) } },
  ],
  unattributed: null,
}];

describe("prices our tokens at ccusage's rate, without inflating a partial day", () => {
  it("gives a fully-tracked day exactly its ccusage cost", () => {
    // ccusage's tokens for the day == our tokens (we tracked all of it): the
    // attributed total lands on ccusage's cost to the cent.
    const allTokens = { [M]: c(29_000, 550_000, 70_000_000, 6_900_000) };  // agents-deck + vcrm-core
    const cc = new Map<string, CcCell>([[`2026-09-22|${M}`, cell(allTokens, 38.41)]]);
    const r = reconcile(day1, null, cc, NOW);
    expect(close(r.totalCost, 38.41, 1e-4)).toBe(true);
  });

  it("gives a HALF-tracked day about half the cost, never the whole applied to a sliver", () => {
    // ccusage saw twice our tokens (we tracked half the day). The attributed
    // total must be ~half the day's cost — the old code made it the whole cost.
    const allTokens = { [M]: c(29_000, 550_000, 70_000_000, 6_900_000) };
    const cc = new Map<string, CcCell>([[`2026-09-22|${M}`, cell(allTokens, 38.41, 2)]]);
    const r = reconcile(day1, null, cc, NOW);
    expect(r.totalCost).toBeGreaterThan(38.41 * 0.45);
    expect(r.totalCost).toBeLessThan(38.41 * 0.55);   // NOT inflated to ~$38 or beyond
    // Σ project = Σ day = total.
    expect(close(r.totalCost, sum(r.perDay.map(d => d.total)))).toBe(true);
    expect(close(r.totalCost, sum(r.projects.map(p => p.cost)))).toBe(true);
  });

  it("holds Σ project = Σ day = total across several days", () => {
    const daily: DayInput[] = [
      { day: "2026-09-21", projects: [{ path: "/u/a", models: { [M]: c(3_000, 40_000, 1_000_000, 100_000) } }], unattributed: null },
      { day: "2026-09-22", projects: [
        { path: "/u/a", models: { [M]: c(6_000, 90_000, 3_000_000, 300_000) } },
        { path: "/u/b", models: { [M]: c(2_000, 30_000, 800_000, 80_000) } },
      ], unattributed: null },
    ];
    const cc = new Map<string, CcCell>([
      [`2026-09-21|${M}`, cell(daily[0].projects[0].models, 3)],
      [`2026-09-22|${M}`, { cost: 9, usage: { inputTokens: 8_000, outputTokens: 120_000, cacheReadTokens: 3_800_000, cacheCreateTokens: 380_000, cacheCreate1hTokens: 0, cacheCreate5mTokens: 0 } }],
    ]);
    const r = reconcile(daily, null, cc, NOW);
    expect(close(r.totalCost, sum(r.perDay.map(d => d.total)))).toBe(true);
    expect(close(r.totalCost, sum(r.projects.map(p => p.cost)))).toBe(true);
    expect(r.projects).toHaveLength(2);
    expect(r.projects[0].cost).toBeGreaterThanOrEqual(r.projects[1].cost);
  });

  it("shows unattributed with a cost AND its tokens, or nothing when there is none", () => {
    const un = { [M]: c(1_000, 20_000, 900_000, 90_000) };
    const cc = new Map<string, CcCell>([[`2026-09-22|${M}`, cell({ [M]: c(29_000, 550_000, 70_000_000, 6_900_000) }, 38.41)]]);
    const withUn = reconcile(day1, un, cc, NOW);
    expect(withUn.unattributed).not.toBeNull();
    expect(withUn.unattributed!.tokens).toBe(1_000 + 20_000 + 900_000 + 90_000);
    expect(withUn.unattributed!.cost).toBeGreaterThan(0);
    // No unattributed passed ⇒ no bucket (a fresh install / after a reset).
    expect(reconcile(day1, null, cc, NOW).unattributed).toBeNull();
  });

  it("falls back to pricing.ts when ccusage is unavailable, and still balances", () => {
    const r = reconcile(day1, { [M]: c(1_000, 20_000, 0, 0) }, new Map(), NOW);
    expect(r.reconciled).toBe(false);
    expect(close(r.totalCost, price(day1[0].projects[0].models) + price(day1[0].projects[1].models))).toBe(true);
    expect(close(r.totalCost, sum(r.projects.map(p => p.cost)))).toBe(true);
    expect(r.unattributed!.cost).toBeGreaterThan(0);
  });
});
