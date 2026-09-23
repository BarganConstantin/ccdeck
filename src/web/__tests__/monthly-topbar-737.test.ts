import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  fmtMonthlyCost,
  monthlyReadDue,
  monthlyUsageFrom,
  monthlyUsageSince,
  MONTHLY_USAGE_CHECK_MS,
  MONTHLY_USAGE_POLL_MS,
} from "../monthly-usage";

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

  it("does not keep last month's figure under \"this month\" when a read fails", () => {
    // A failed read leaves the last good figure standing only while it is
    // still the same month; after the 1st it goes rather than being relabelled.
    expect(app).toContain("goodSince = since;");
    expect(app).toContain("if (since !== goodSince) setMonthlyUsage(null);");
  });

  it("leaves the bar whole where it would otherwise be clipped, by width alone", () => {
    // The readout clips from the left, so a phrase that does not fit loses its
    // period first. It leaves whole instead, in the two bands where a blocked
    // session beside a selected node's ribbon does not fit with it: under
    // 1130px, and from 1440 (where the words arrive) to 1639. The strip goes
    // with it when no pill is left.
    const giveWay = "@media (max-width: 1129px), (min-width: 1440px) and (max-width: 1639px) {";
    expect(css).toContain(`${giveWay}
  .topbar .status .month-usage,
  .topbar .status:not(:has(.pill)) { display: none; }
}`);
    // After the base rule, whose own `display` would otherwise win on order.
    expect(css.indexOf(giveWay)).toBeGreaterThan(css.indexOf(".topbar .status .month-usage {"));
    // The words band opens exactly where the words do, so the two cannot drift
    // into a band where both are on the bar and neither fits.
    expect(css).toContain("@media (min-width: 1440px) {\n  .topbar .tb-word {");
  });

  it("never lets a selection decide whether the phrase is there", () => {
    // It did, under 1760px, and the phrase sits ahead of the blocked-session
    // chip: selecting a card slid the alarm 204px left. No rule that hides the
    // phrase or its strip may name the ribbon, or anything else a click on the
    // canvas can put on the bar.
    const hiders = [...css.matchAll(/([^{}]+)\{[^{}]*display:\s*none;[^{}]*\}/g)]
      .map(m => m[1].trim())
      .filter(sel => /month-usage|\.status:not/.test(sel));
    expect(hiders.length).toBeGreaterThan(0);
    for (const sel of hiders) expect(sel).not.toMatch(/selected|:has\(\.selected|\.btn\.danger/);
  });
});

describe("the month is read only while it is shown (#737)", () => {
  const at = { shown: true, tabVisible: true, now: 1_000_000_000 };

  it("reads at once when nothing has been read yet", () => {
    expect(monthlyReadDue({ ...at, lastReadAt: null })).toBe(true);
  });

  it("asks again every five minutes, not every minute", () => {
    expect(MONTHLY_USAGE_POLL_MS).toBe(5 * 60_000);
    expect(monthlyReadDue({ ...at, lastReadAt: at.now - 60_000 })).toBe(false);
    expect(monthlyReadDue({ ...at, lastReadAt: at.now - MONTHLY_USAGE_POLL_MS + 1 })).toBe(false);
    expect(monthlyReadDue({ ...at, lastReadAt: at.now - MONTHLY_USAGE_POLL_MS })).toBe(true);
    // The check is a comparison and runs more often than the read it gates.
    expect(MONTHLY_USAGE_CHECK_MS).toBeLessThan(MONTHLY_USAGE_POLL_MS);
  });

  it("does not read for a phrase that is display: none, or a tab in the background", () => {
    for (const lastReadAt of [null, 0]) {
      expect(monthlyReadDue({ ...at, shown: false, lastReadAt })).toBe(false);
      expect(monthlyReadDue({ ...at, tabVisible: false, lastReadAt })).toBe(false);
    }
  });

  it("asks the phrase itself whether it is drawn, and watches it come back", () => {
    const start = app.indexOf("const monthUsageRef = useRef<HTMLSpanElement>(null);");
    expect(start).toBeGreaterThan(-1);
    const effect = app.slice(start, app.indexOf("}, []);", start));
    // Not a copy of the breakpoints: a box inside display: none has no client
    // rects, whichever rule put it there.
    expect(effect).toContain("shown: !!phrase && phrase.getClientRects().length > 0,");
    expect(app).toMatch(/ref=\{monthUsageRef\}\s+className="month-usage"/);
    expect(effect).toContain("seen = new ResizeObserver(poll);");
    expect(effect).toContain("seen.observe(monthUsageRef.current);");
    expect(effect).toContain('document.addEventListener("visibilitychange", poll);');
    expect(effect).toContain("window.setInterval(poll, MONTHLY_USAGE_CHECK_MS)");
    // Every read goes through the rule; nothing fetches the month on a timer
    // of its own.
    expect(effect.match(/\bread\(\);/g)).toHaveLength(1);
    expect(effect).toMatch(/now: Date\.now\(\),\s*\}\)\) read\(\);/);
  });
});
