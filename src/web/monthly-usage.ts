import { fmtCost } from "./pricing";
import { rangeTotals, sinceFor, type UsageRange } from "./usage-from-ccusage";

export const MONTHLY_USAGE_POLL_MS = 60_000;

export interface MonthlyUsage {
  cost: number;
  tokens: number;
}

/** Start of the current LOCAL calendar month in ccusage's YYYYMMDD format. */
export function monthlyUsageSince(now: Date = new Date()): string {
  return sinceFor("month", now);
}

/** The two figures the topbar owns, both from the same ccusage reading. */
export function monthlyUsageFrom(range: UsageRange | null | undefined): MonthlyUsage {
  const totals = rangeTotals(range);
  return { cost: totals.cost, tokens: totals.tokens };
}

/** fmtCost reserves an em dash for zero; an empty month is a real $0.00. */
export function fmtMonthlyCost(cost: number): string {
  return cost > 0 ? fmtCost(cost) : "$0.00";
}
