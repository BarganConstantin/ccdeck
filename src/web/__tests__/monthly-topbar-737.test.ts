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
    // period first. It leaves whole instead, but only under 1040px, where even
    // a ribbon cut down to its floor leaves no room beside a blocked session.
    // The strip goes with it when no pill is left.
    const giveWay = "@media (max-width: 1039px) {";
    expect(css).toContain(`${giveWay}
  .topbar .status .month-usage,
  .topbar .status:not(:has(.pill)) { display: none; }
}`);
    // After the base rule, whose own `display` would otherwise win on order.
    expect(css.indexOf(giveWay)).toBeGreaterThan(css.indexOf(".topbar .status .month-usage {"));
    // Nowhere else: 1440 is the app's default window, and the phrase is on it.
    const hiders = [...css.matchAll(/@media ([^{]+)\{\s*\.topbar \.status \.month-usage,/g)].map(m => m[1].trim());
    expect(hiders).toEqual(["(max-width: 1039px)"]);
  });

  it("makes the ribbon give up the room instead, and never past what fits", () => {
    // Room for the ribbon beside the budget case, measured in Chromium, less
    // 40px of headroom: W - 867 on glyphs, W - 1253 once the words arrive.
    const glyphs = /@media \(min-width: (\d+)px\) and \(max-width: (\d+)px\) \{\s*\.selected-ribbon \{ max-width: min\(24vw, calc\(100vw - (\d+)px\)\); \}/.exec(css);
    const words = /@media \(min-width: (\d+)px\) \{\s*\.selected-ribbon \{ max-width: min\(380px, calc\(100vw - (\d+)px\)\); \}/.exec(css);
    expect(glyphs, "the glyph band's ribbon cap").toBeTruthy();
    expect(words, "the words band's ribbon cap").toBeTruthy();
    const [, gFrom, gTo, gReserve] = glyphs!.map(Number);
    const [, wFrom, wReserve] = words!.map(Number);
    // The bands meet the phrase's floor and the words' arrival exactly.
    expect(gFrom).toBe(1040);
    expect(gTo).toBe(1439);
    expect(wFrom).toBe(1440);
    expect(css).toContain("@media (min-width: 1440px) {\n  .topbar .tb-word {");
    // The same budget both sides of 1440: only the words' width differs.
    expect(wReserve - gReserve).toBe(386);
    // At its tightest the ribbon still holds a state, ten-odd characters of a
    // name and its ×: 173px at the floor, 187 where the words arrive.
    expect(gFrom - gReserve).toBeGreaterThanOrEqual(170);
    expect(wFrom - wReserve).toBeGreaterThanOrEqual(170);
    // And it is after the ribbon's own rule, which would otherwise win on order.
    expect(css.indexOf(glyphs![0])).toBeGreaterThan(css.indexOf(".selected-ribbon {"));
    expect(css.indexOf(words![0])).toBeGreaterThan(css.indexOf(".selected-ribbon {"));
  });

  it("drops the ribbon's cost exactly where its cap is held under the usual one", () => {
    // Where min(380px, 24vw) takes over again the ribbon is its usual self, cost
    // and all. Short of that the name gets the room, and the cost stays on the
    // card, in the detail panel and in the ribbon's own title.
    const reserve = (re: RegExp) => Number(re.exec(css)![1]);
    const g = reserve(/max-width: min\(24vw, calc\(100vw - (\d+)px\)\)/);
    const w = reserve(/max-width: min\(380px, calc\(100vw - (\d+)px\)\)/);
    const cost = /@media \(min-width: 1040px\) and \(max-width: (\d+)px\), \(min-width: 1440px\) and \(max-width: (\d+)px\) \{\s*\.selected-ribbon \.selected-cost \{ display: none; \}\s*\}/.exec(css);
    expect(cost, "the cost's band").toBeTruthy();
    const [, gEnd, wEnd] = cost!.map(Number);
    // Glyphs: W - g meets 24vw at g / 0.76. Words: W - w meets 380 at w + 380.
    expect(gEnd).toBe(Math.floor(g / 0.76) - 1);
    expect(wEnd).toBe(w + 380 - 1);
    expect(app).toMatch(/className="selected-ribbon"[\s\S]{0,400}?title=\{`Zoom to \$\{selected\.label\} and its session \(Z\)\$\{\s*c\.total > 0 \? `\\n\$\{fmtCost\(c\.total\)\} spent/);
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

  it("reads at once when the month has turned since the last read", () => {
    // A read at 23:58 on the last day would otherwise hold the next until
    // 00:03, and last month's total would stand under "this month".
    const recent = { ...at, lastReadAt: at.now - 60_000 };
    expect(monthlyReadDue({ ...recent, lastSince: "20260901", since: "20261001" })).toBe(true);
    expect(monthlyReadDue({ ...recent, lastSince: "20261001", since: "20261001" })).toBe(false);
    expect(monthlyReadDue({ ...recent, shown: false, lastSince: "20260901", since: "20261001" })).toBe(false);
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
