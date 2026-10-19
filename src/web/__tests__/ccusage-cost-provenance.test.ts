import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { asDay, historyTotals } from "../usage-history";
import { modelRows } from "../usage-from-ccusage";
import { reportedCost, storedCostNote } from "../reported-cost";
import { anyUnpriced } from "../usage-panel-rules";
import UsageDayDetail from "../components/UsageDayDetail";
import UsageModelTable from "../components/UsageModelTable";

const day = (cost: number, extra = {}) => asDay({ totalCost: cost, period: "2026-10-19", modelBreakdowns: [
  { modelName: "custom-model", cost, inputTokens: 100, ...extra },
] });

describe("ccusage cost provenance", () => {
  it("keeps missing pricing after a model has some priced days", () => {
    const days = [day(2, { storedCost: 1.5 }), day(0, { missingPricing: true })];
    const rows = modelRows({ days });
    expect(rows[0]).toMatchObject({ cost: 2, missingPricing: true, storedCost: 1.5, tokens: 200 });
    expect(anyUnpriced(true, rows, [])).toBe(true);
    expect(historyTotals(days).missingModels.has("custom-model")).toBe(true);
    const html = renderToStaticMarkup(createElement(UsageModelTable, { fromRange: true, rangeModelRows: rows, boardModelRows: [] }));
    expect(html).toContain("$2.00+");
    expect(html).toContain("Recorded in logs: $1.50");
  });
  it("distinguishes missing pricing from a known zero cost", () => {
    expect(reportedCost(0, true)).toBe("not priced");
    expect(reportedCost(0, false)).not.toBe("not priced");
    const html = renderToStaticMarkup(createElement(UsageDayDetail, { selectedDay: day(0, { missingPricing: true }) }));
    expect(html).toContain("not priced");
    expect(html).toContain("Some models have no known price");
  });
  it("treats stored cost as a subset, not an extra charge", () => {
    const days = [day(2, { storedCost: 1.5 }), day(3, { storedCost: 1 })];
    expect(historyTotals(days)).toMatchObject({ totalCost: 5, storedCost: 2.5 });
    expect(storedCostNote(2.5, 5)).toContain("other reported cost: $2.50");
    expect(storedCostNote(8, 5)).not.toContain("-");
  });
  it("leaves provenance unknown on older reports and rejects invalid stored costs", () => {
    expect(historyTotals([day(2)]).storedCost).toBeNull();
    expect(storedCostNote(null, 2)).toBeNull();
    for (const storedCost of [-1, NaN, Infinity, "3", null]) {
      expect(modelRows({ days: [day(2, { storedCost })] })[0].storedCost).toBeUndefined();
    }
    expect(day(2, { storedCost: 5 }).modelBreakdowns[0].storedCost).toBe(2);
  });
});
