import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fmtMonthlyCost, monthlyUsageFrom, monthlyUsageSince } from "../monthly-usage";

const web = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(join(web, "App.tsx"), "utf8");

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
  });

  it("fetches ccusage for that month and labels the figures together", () => {
    expect(app).toContain('fetch(`/api/ccusage?since=${since}`)');
    expect(app).toContain('className="month-usage-label">this month</span>');
    expect(app).toContain("fmtTokens(monthlyUsage.tokens)");
    expect(app).toContain("fmtMonthlyCost(monthlyUsage.cost)");
    expect(app).not.toContain("boardTotals(state.agents.values())");
  });
});
