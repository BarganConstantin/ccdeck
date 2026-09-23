import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fmtMonthlyCost, monthlyUsageFrom, monthlyUsageSince } from "../monthly-usage";

const web = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(join(web, "App.tsx"), "utf8");
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("month-to-date topbar usage (#737)", () => {
  it("starts at the first day of the local calendar month", () => {
    expect(monthlyUsageSince(new Date(2026, 8, 23, 23, 55))).toBe("20260901");
    expect(monthlyUsageSince(new Date(2026, 8, 1, 0, 5))).toBe("20260901");
  });

  it("uses ccusage totals for both tokens and cost", () => {
    expect(monthlyUsageFrom({
      totals: { totalTokens: 12_345, totalCost: 6.78 },
    })).toEqual({ tokens: 12_345, cost: 6.78 });
  });

  it("renders a successful empty month as numeric zero", () => {
    expect(monthlyUsageFrom({ totals: { totalTokens: 0, totalCost: 0 } }))
      .toEqual({ tokens: 0, cost: 0 });
    expect(fmtMonthlyCost(0)).toBe("$0.00");
    // The route passes `totals` through as null when ccusage printed none, which
    // is what a month with no transcripts in it yet can look like.
    expect(monthlyUsageFrom({ ok: true, days: [], totals: null }))
      .toEqual({ tokens: 0, cost: 0 });
  });

  it("fetches ccusage for that month and labels the figures together", () => {
    expect(app).toContain('fetch(`/api/ccusage?since=${since}`)');
    expect(app).toContain('className="month-usage-label">this month</span>');
    expect(app).toContain("fmtTokens(monthlyUsage.tokens)");
    expect(app).toContain("fmtMonthlyCost(monthlyUsage.cost)");
    expect(app).not.toContain("boardTotals(state.agents.values())");
  });

  it("leaves the bar whole where it would otherwise be clipped", () => {
    // The readout clips from the left, so a phrase that does not fit loses its
    // period first. It leaves whole instead: under 920px, and under 1760px
    // while a node is selected. The strip goes with it when no pill is left.
    expect(css).toMatch(/@media \(max-width: 919px\) \{\s*\.topbar \.status \.month-usage,\s*\.topbar \.status:not\(:has\(\.pill\)\) \{ display: none; \}/);
    expect(css).toMatch(/@media \(max-width: 1759px\) \{\s*\.topbar:has\(\.selected-ribbon\) \.status \.month-usage,\s*\.topbar:has\(\.selected-ribbon\) \.status:not\(:has\(\.pill\)\) \{ display: none; \}/);
    // After the base rule, whose own `display` would otherwise win on order.
    expect(css.indexOf("@media (max-width: 919px)"))
      .toBeGreaterThan(css.indexOf(".topbar .status .month-usage {"));
  });
});
