// ccusage's cost is a partial total when a model has missing pricing.
import { t } from "./i18n";
import { fmtCost } from "./pricing";

export function reportedCost(cost: number, missingPricing?: boolean): string {
  if (missingPricing && cost <= 0) return t("insights.cost.notPriced");
  return fmtCost(cost) + (missingPricing ? "+" : "");
}

/** English, kept for tests; the panels read missingPriceNote(). */
export const MISSING_PRICE_NOTE = "Some models have no known price. Tokens are counted; their cost is missing from the total.";
export const missingPriceNote = () => t("insights.cost.missingPrice");

export function storedCostNote(stored: number | null | undefined, total: number): string | null {
  if (stored == null) return null;
  const recorded = Math.min(Math.max(0, stored), Math.max(0, total));
  return t("insights.cost.stored", { recorded: fmtCost(recorded), other: fmtCost(Math.max(0, total - recorded)) });
}
