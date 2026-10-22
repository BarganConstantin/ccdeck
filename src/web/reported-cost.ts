// ccusage's cost is a partial total when a model has missing pricing.
import { fmtCost, UNPRICED_LABEL } from "./pricing";

export function reportedCost(cost: number, missingPricing?: boolean): string {
  if (missingPricing && cost <= 0) return UNPRICED_LABEL;
  return fmtCost(cost) + (missingPricing ? "+" : "");
}

export const MISSING_PRICE_NOTE = "Some models have no known price. Tokens are counted; their cost is missing from the total.";

export function storedCostNote(stored: number | null | undefined, total: number): string | null {
  if (stored == null) return null;
  const recorded = Math.min(Math.max(0, stored), Math.max(0, total));
  return `Recorded in logs: ${fmtCost(recorded)} · other reported cost: ${fmtCost(Math.max(0, total - recorded))}. Both are included in the total; recorded costs are not a verified bill.`;
}
