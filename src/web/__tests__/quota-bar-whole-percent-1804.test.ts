// #1804: a Codex spend cap read "33.33333333333333%", and 0.25% had no fill.
//
// Claude's bars arrive rounded (clampPct), so QuotaBar printed `${capped}%` as
// it came. The Codex spend cap's usedPct is `used / limit * 100`, and a lane's
// used_percent can arrive as a fraction, so $10 of $30 printed fifteen digits
// and a cap barely touched printed "0.25%" over a scaleX(0.0025) fill, which
// draws nothing — the 2% sliver was kept for exactly zero. The label is a
// whole percentage now, and anything under 1% reads "< 1%" over the sliver,
// the way a zero always has.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBar from "../components/QuotaBar";
import { CodexQuotaSection } from "../components/QuotaSections";

const bar = (pct: number) => renderToStaticMarkup(createElement(QuotaBar, { pct, label: "x", nowSec: 0 }));
// The figure sits in a crossfading wrapper span now (FadeFigure), so the text is one span in.
const label = (html: string) => /class="qb-pct"[^>]*>(?:<span[^>]*>)*([^<]*)</.exec(html)?.[1];
// The fill may carry data-jump (a change under a point jumps) before its style.
const fill = (html: string) => Number(/qb-fill"(?: data-jump="true")? style="transform:scaleX\(([^)]+)\)/.exec(html)?.[1]);

describe("the quota bar's percentage (#1804)", () => {
  it.each([
    [100 / 3, "33%"],
    [33.5, "34%"],
    [66.66666666666667, "67%"],
    [1, "1%"],
    [1.4, "1%"],
    [99.4, "99%"],
    [100, "100%"],
  ])("prints %d as %s", (pct, text) => {
    expect(label(bar(pct))).toBe(text);
  });

  it.each([0, 0.0025, 0.005, 0.01, 0.25, 0.5, 0.99])("prints %d as < 1% over the minimum sliver", pct => {
    const html = bar(pct);
    expect(label(html)).toBe("&lt; 1%");
    expect(fill(html)).toBeGreaterThanOrEqual(0.02);
  });

  it("keeps the fill and the colour on the reading, not the rounded label", () => {
    // 89.6 prints "90%" but is under the red line, as it was before.
    const html = bar(89.6);
    expect(label(html)).toBe("90%");
    expect(fill(html)).toBeCloseTo(0.896, 6);
    // CHANGED ON PURPOSE (compact accounts, #2539): main's quota colours (under 70 --accent,
    // 70 to 89 --warn, 90 and up --err); 89.6 is under the red line, so --warn and not --err.
    expect(html).toContain("background:var(--warn)");
    expect(html).not.toContain("var(--err)");
  });

  it("prints the Codex spend cap as a whole percentage", () => {
    const html = renderToStaticMarkup(createElement(CodexQuotaSection, {
      codexQuota: { ok: true, creditLimit: { limit: 30, used: 10, usedPct: 100 / 3, remaining: 20, source: null, resetAt: null, reset: null } },
      codexLoading: false,
      codexUsage: null,
      nowSec: 0,
    }));
    expect(html).toContain("spend cap · $10 of $30");
    expect(html).toContain(">33%<");
    expect(html).not.toContain("33.33");
  });
});
