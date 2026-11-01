// V4's Rail / Usage (Figma 22:831): the 5-hour window at the foot of the
// attention rail, one button that opens the Usage panel.
//
// The rules (what is drawn, what is said, when nothing is) are rail-usage.ts's
// and are called on readings shaped like /api/quota's; the look is read out of
// the sheet the way v4-rail.test.ts reads it; what a bare-node suite cannot see
// (that the reading is held once and that the button is the stripe door's own
// toggle) is pinned at the source.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RailUsage } from "../components/RailParts";
import { usageMeter } from "../rail-usage";
import { resetCountdown } from "../relative-time";
import type { MeterQuota, QuotaData } from "../use-quota";
import { sheetRules } from "./sheet-cascade";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const source = (p: string) => readFileSync(here(p), "utf8");
const code = (p: string) => source(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const rules = sheetRules();
function decl(selector: string, prop: string, media: string | null = null): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (r.media !== media || !r.selectors.includes(selector)) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
    if (m) found = m[1].trim();
  }
  return found;
}
const rail = source("../styles/session-list.css");

const NOW = 1_800_000_000;
const reading = (over: Partial<QuotaData> = {}): QuotaData => ({
  ok: true, planLabel: "Max 20x",
  session5hPct: 62, session5hResetAt: NOW + 2 * 3600 + 9 * 60,
  week7dPct: 31, week7dResetAt: NOW + 3 * 86400,
  ...over,
});
// What the server's memory hands the rail: the reading, when it was taken (ms)
// and whether a window has reset since. By default read this very second, so
// the cases that are not about age see a fresh meter.
const heldOf = (q: QuotaData | null | undefined, nowSec: number, over: Partial<MeterQuota> = {}): MeterQuota =>
  ({ reading: q ?? null, readAt: nowSec * 1000, failed: false, ...over });
const meter = (q: QuotaData | null | undefined, nowSec = NOW, over: Partial<MeterQuota> = {}) =>
  usageMeter(heldOf(q, nowSec, over), nowSec * 1000);
const draw = (q: QuotaData | null, nowSec = NOW, over: Partial<MeterQuota> = {}) =>
  renderToStaticMarkup(createElement(RailUsage, { meter: meter(q, nowSec, over), onPress: () => {} }));

describe("Rail / Usage box (22:831)", () => {
  it("sits at the foot, 4 round it, outside the scrolling list", () => {
    expect(decl(".session-list .sl-usage", "flex")).toBe("none");
    expect(decl(".session-list .sl-usage", "padding")).toBe("4px");
    // After the list and the removed cards' line in the aside, so it is pinned
    // below what scrolls.
    const list = code("../components/SessionList.tsx");
    expect(list.indexOf("<RailUsage")).toBeGreaterThan(list.indexOf('<ul className="sl-rows"'));
    expect(list.indexOf("<RailUsage")).toBeGreaterThan(list.indexOf('className="sl-foot"'));
  });

  it("is a column, 4 apart, 8 and 12 in, the rows' --r-panel round (the kit has no 9), nothing at rest", () => {
    expect(decl(".session-list .sl-usage-btn", "display")).toBe("flex");
    expect(decl(".session-list .sl-usage-btn", "flex-direction")).toBe("column");
    expect(decl(".session-list .sl-usage-btn", "gap")).toBe("4px");
    expect(decl(".session-list .sl-usage-btn", "padding")).toBe("8px 12px");
    expect(decl(".session-list .sl-usage-btn", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".session-list .sl-usage-btn", "background")).toBe("transparent");
    expect(decl(".session-list .sl-usage-btn", "border")).toBe("0");
    expect(decl(".session-list .sl-usage-btn", "width")).toBe("100%");
  });

  it("sets line 1 on a baseline 6 apart: the name 12/16 600 text, the limit 12/16 secondary, the percent mono 600 text at the end", () => {
    expect(decl(".session-list .sl-usage-line1", "align-items")).toBe("baseline");
    expect(decl(".session-list .sl-usage-line1", "gap")).toBe("6px");
    expect(decl(".session-list .sl-usage-line1", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-usage-line1", "line-height")).toBe("16px");
    expect(decl(".session-list .sl-usage-name", "font-weight")).toBe("600");
    expect(decl(".session-list .sl-usage-name", "color")).toBe("var(--text)");
    expect(decl(".session-list .sl-usage-what", "color")).toBe("var(--text-secondary)");
    expect(decl(".session-list .sl-usage-pct", "font-family")).toBe("var(--font-mono)");
    expect(decl(".session-list .sl-usage-pct", "font-weight")).toBe("600");
    expect(decl(".session-list .sl-usage-pct", "color")).toBe("var(--text)");
    expect(decl(".session-list .sl-usage-pct", "margin-left")).toBe("auto");
  });

  it("sets line 2 on a baseline 4 apart, 12/16 muted", () => {
    expect(decl(".session-list .sl-usage-line2", "align-items")).toBe("baseline");
    expect(decl(".session-list .sl-usage-line2", "gap")).toBe("4px");
    expect(decl(".session-list .sl-usage-line2", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-usage-line2", "line-height")).toBe("16px");
    expect(decl(".session-list .sl-usage-line2", "color")).toBe("var(--muted)");
  });

  it("draws the bar 4 tall, --r-tag round, clipped, on a --line track", () => {
    expect(decl(".session-list .sl-usage-bar", "height")).toBe("4px");
    expect(decl(".session-list .sl-usage-bar", "width")).toBe("100%");
    expect(decl(".session-list .sl-usage-bar", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".session-list .sl-usage-bar", "overflow")).toBe("hidden");
    expect(decl(".session-list .sl-usage-bar", "background")).toBe("var(--line)");
  });

  it("answers the rows' hover wash, press and ring, and keeps a phone target of 44", () => {
    expect(decl(".session-list .sl-usage-btn:hover", "background")).toBe("var(--ctl-fill)");
    expect(decl(".session-list .sl-usage-btn:active", "transform")).toBe(decl(".session-list .sl-row:active", "transform"));
    expect(decl(".session-list .sl-usage-btn:focus-visible", "outline-offset")).toBe("-2px");
    expect(decl(".session-list .sl-usage-btn:focus-visible", "outline")).toBeUndefined();
    expect(decl(".session-list .sl-usage-btn", "min-height", "(max-width: 640px)")).toBe("44px");
    // The box is wider than the rail only if the sheet says so; it follows it.
    expect(decl(".session-list .sl-usage-btn", "width")).toBe("100%");
    expect(rail).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.sl-usage-btn/);
  });
});

describe("one fill, in the Usage panel bar's data colours", () => {
  it("draws ONE fill whose width is the percent, in --accent at a normal reading", () => {
    const html = draw(reading({ session5hPct: 62 }));
    expect(html.match(/sl-usage-fill/g)).toHaveLength(1);
    expect(html).toContain('style="width:62%;background:var(--accent)"');
    // None of the five Figma segment colours: they have no data behind them.
    expect(rail).not.toMatch(/--usage-(?:cyan|indigo|lime|pink|orange)/);
  });

  it("wears the colour QuotaBar's own bar wears for the same reading: --accent, --warn from 70, --err from 90", () => {
    const colour = (pct: number) => draw(reading({ session5hPct: pct })).match(/background:(var\(--[a-z]+\))/)?.[1];
    expect(colour(69)).toBe("var(--accent)");
    expect(colour(70)).toBe("var(--warn)");
    expect(colour(89)).toBe("var(--warn)");
    expect(colour(90)).toBe("var(--err)");
    expect(colour(100)).toBe("var(--err)");
    // One source for both: the bar calls the same function, no colour of its own here.
    expect(code("../components/QuotaBar.tsx")).toContain("quotaLevelColor(capped, isErr)");
    expect(code("../components/QuotaBar.tsx")).toMatch(/capped >= 70 \? "var\(--warn\)" : "var\(--accent\)"/);
    expect(code("../rail-usage.ts")).toContain("quotaLevelColor(capped)");
    // No hex, no new token in the rule the meter adds.
    const css = rail.slice(rail.indexOf(".session-list .sl-usage {"), rail.indexOf("The phone keeps the drawer"));
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/--warn|--err|--accent|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("caps the width at 0 to 100", () => {
    expect(draw(reading({ session5hPct: 140 }))).toContain("width:100%");
    expect(draw(reading({ session5hPct: -5 }))).toContain("width:0%");
    expect(meter(reading({ session5hPct: 140 }))?.pctText).toBe("100%");
  });

  it("prints the percent the way the panel's bar does", () => {
    expect(meter(reading({ session5hPct: 61.6 }))?.pctText).toBe("62%");
    expect(meter(reading({ session5hPct: 0.25 }))?.pctText).toBe("< 1%");
    expect(code("../components/QuotaBar.tsx")).toContain("quotaPctText(capped)");
  });
});

describe("what it says, and when it says nothing", () => {
  it("prints the account, the limit, the percent, the reset and the 7-day figure", () => {
    const m = meter(reading())!;
    expect(m.name).toBe("Max 20x");
    expect(m.pctText).toBe("62%");
    expect(m.reset).toBe(`Resets in ${resetCountdown(NOW + 2 * 3600 + 9 * 60, NOW)}`);
    expect(m.reset).toBe("Resets in 2h 9m");
    expect(m.week).toBe("7-day 31%");
    const html = draw(reading());
    expect(html).toContain("Max 20x");
    expect(html).toContain("5-hour limit");
    expect(html).toContain("<span>Resets in 2h 9m</span><span>·</span><span>7-day 31%</span>");
  });

  it("is named by one sentence with every figure, and hides the pieces from a reader", () => {
    expect(meter(reading())?.spoken).toBe("Usage: Max 20x, 5-hour limit 62%, resets in 2h 9m, 7-day 31%");
    const html = draw(reading());
    expect(html).toContain('aria-label="Usage: Max 20x, 5-hour limit 62%, resets in 2h 9m, 7-day 31%"');
    expect(html).toContain('<span class="sl-usage-bar" aria-hidden="true">');
    expect(html).toContain('<span class="sl-usage-line1" aria-hidden="true">');
    expect(html).toContain('<span class="sl-usage-line2" aria-hidden="true">');
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toContain('<button type="button" class="sl-usage-btn"');
  });

  it("draws nothing without a reading: no account, not in yet, failed, no 5-hour window, a window already over", () => {
    expect(draw(null)).toBe("");
    expect(draw(reading({ ok: false }))).toBe("");
    expect(draw({ ok: true })).toBe("");
    expect(draw(reading({ session5hPct: undefined }))).toBe("");
    expect(draw(reading({ session5hResetAt: NOW - 1 }))).toBe("");
    expect(meter(undefined)).toBeNull();
  });

  it("drops '· 7-day …' without a 7-day reading, and 'Resets in …' without a reset", () => {
    const noWeek = meter(reading({ week7dPct: null }))!;
    expect(noWeek.week).toBeNull();
    expect(noWeek.spoken).toBe("Usage: Max 20x, 5-hour limit 62%, resets in 2h 9m");
    expect(draw(reading({ week7dPct: null }))).toContain("<span>Resets in 2h 9m</span></span>");
    expect(draw(reading({ week7dPct: null }))).not.toContain("·");
    const noReset = meter(reading({ session5hResetAt: undefined }))!;
    expect(noReset.reset).toBeNull();
    expect(noReset.spoken).toBe("Usage: Max 20x, 5-hour limit 62%, 7-day 31%");
    expect(draw(reading({ session5hResetAt: undefined }))).toContain('<span class="sl-usage-line2" aria-hidden="true"><span>7-day 31%</span></span>');
    expect(draw(reading({ session5hResetAt: undefined }))).not.toContain("·");
  });

  it("does not draw an empty second line", () => {
    const html = draw(reading({ session5hResetAt: undefined, week7dPct: null }));
    expect(html).toContain("sl-usage-bar");
    expect(html).not.toContain("sl-usage-line2");
  });

  it("drops the name when the reading carries none, rather than inventing one", () => {
    const m = meter(reading({ planLabel: null }))!;
    expect(m.name).toBeNull();
    expect(m.spoken).toBe("Usage: 5-hour limit 62%, resets in 2h 9m, 7-day 31%");
    expect(draw(reading({ planLabel: undefined }))).not.toContain("sl-usage-name");
  });

  it("labels the meter with the active account's alias, else with its plan", () => {
    expect(usageMeter(heldOf(reading(), NOW), NOW * 1000, "Home")?.name).toBe("Home");
    expect(usageMeter(heldOf(reading(), NOW), NOW * 1000, "Home")?.spoken).toBe("Usage: Home, 5-hour limit 62%, resets in 2h 9m, 7-day 31%");
    for (const none of [null, "", "   "]) expect(usageMeter(heldOf(reading(), NOW), NOW * 1000, none)?.name, JSON.stringify(none)).toBe("Max 20x");
    expect(usageMeter(heldOf(reading(), NOW), NOW * 1000)?.name).toBe("Max 20x");
    expect(usageMeter(heldOf(reading({ planLabel: null }), NOW), NOW * 1000, "Home")?.name).toBe("Home");
    expect(usageMeter(heldOf(reading({ planLabel: null }), NOW), NOW * 1000, null)?.name).toBeNull();
    const html = renderToStaticMarkup(createElement(RailUsage, { meter: usageMeter(heldOf(reading(), NOW), NOW * 1000, "Home"), onPress: () => {} }));
    expect(html).toContain('<span class="sl-usage-name" title="Home">Home</span>');
  });

  it("ends a long alias in an ellipsis and carries the whole name in a title", () => {
    const long = "A very long account alias that cannot fit the rail";
    const html = renderToStaticMarkup(createElement(RailUsage, { meter: usageMeter(heldOf(reading(), NOW), NOW * 1000, long), onPress: () => {} }));
    expect(html).toContain(`title="${long}"`);
    expect(decl(".session-list .sl-usage-name", "overflow")).toBe("hidden");
    expect(decl(".session-list .sl-usage-name", "text-overflow")).toBe("ellipsis");
    expect(decl(".session-list .sl-usage-name", "white-space")).toBe("nowrap");
  });

  it("takes the alias from the roster the page already holds: no request of its own", () => {
    const app = code("../App.tsx");
    expect(app).toContain("activeAlias={attention.accounts?.find(a => a.active)?.alias ?? null}");
    expect(code("../use-account-attention.ts")).toMatch(/return \{\s*rows,\s*accounts,/);
    expect(code("../rail-usage.ts")).not.toMatch(/fetch\(/);
  });

  it("does not print a week whose reset has passed", () => {
    expect(meter(reading({ week7dResetAt: NOW - 5 }))?.week).toBeNull();
  });
});

describe("where the reading comes from, and what the button does", () => {
  it("reads through useMeterQuota only (the plain poll, held once in App.tsx); the Usage panel keeps its own useQuota; the rail never fetches", () => {
    const app = code("../App.tsx");
    expect(app).not.toMatch(/\buseQuota\(/);
    expect(app).not.toMatch(/import \{[^}]*\buseQuota\b/);
    expect(app.match(/useMeterQuota\(/g)).toHaveLength(1);
    expect(app).toContain("useMeterQuota(providers.claude)");
    expect(app).toMatch(/quota=\{meterQuota\}/);
    expect(app).not.toMatch(/claudeQuota/);
    // The panel polls (and forces a read on open) for itself, as before.
    expect(code("../components/UsagePanel.tsx")).toContain("useQuota(providers.claude)");
    expect(code("../components/UsagePanel.tsx")).not.toMatch(/claudeQuota/);
    for (const f of ["../components/SessionList.tsx", "../components/RailParts.tsx", "../rail-usage.ts"]) {
      expect(code(f), f).not.toMatch(/\bfetch\(|setInterval|useQuota\(|useMeterQuota\(|import \{[^}]*useQuota/);
    }
    expect(code("../rail-usage.ts")).toContain('import type { MeterQuota } from "./use-quota"');
  });

  it("presses the Usage stripe door's own toggle, so an open panel closes", () => {
    expect(code("../App.tsx")).toContain("onOpenUsage={() => usageRail.set(o => !o)}");
    expect(code("../rail-items.tsx")).toContain("onPress: () => setUsagePanelOpen(o => !o)");
    expect(code("../App.tsx")).toContain("setUsagePanelOpen: usageRail.set");
    expect(code("../components/RailParts.tsx")).toMatch(/<button type="button" className="sl-usage-btn" onClick=\{onPress\}/);
  });

  it("is not drawn without the press handler, and the rail has no folded state to draw it in", () => {
    expect(code("../components/SessionList.tsx")).toContain("{onOpenUsage && <RailUsage");
    expect(rail).not.toMatch(/\.session-list[^{]*\.(?:folded|collapsed|narrow)/);
  });

  it("imports nothing that is otherwise loaded lazily", () => {
    for (const f of ["../rail-usage.ts", "../components/RailParts.tsx"]) {
      const s = code(f);
      expect(s, f).not.toMatch(/\blazy\(|import\(/);
    }
    const imports = [...code("../rail-usage.ts").matchAll(/from "([^"]+)"/g)].map(m => m[1]);
    expect(imports.sort()).toEqual(["./components/QuotaBar", "./elapsed-short", "./relative-time", "./use-quota"]);
    // QuotaBar is reached from App.tsx's static UsagePanel import already.
    expect(code("../App.tsx")).toContain('import UsagePanel from "./components/UsagePanel";');
    expect(code("../App.tsx")).not.toMatch(/const UsagePanel = lazy/);
  });

  it("writes no literal colour in the rule it adds", () => {
    const css = rail.slice(rail.indexOf(".session-list .sl-usage {"), rail.indexOf("The phone keeps the drawer")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe("a reading the deck has not taken lately is drawn quiet and says so", () => {
  const MIN = 60_000;
  const readAgo = (min: number) => NOW * 1000 - min * MIN;

  it("is fresh up to ten minutes and stale past them", () => {
    expect(meter(reading(), NOW, { readAt: readAgo(0) })?.stale).toBe(false);
    expect(meter(reading(), NOW, { readAt: readAgo(10) })?.stale, "exactly ten minutes is still fresh").toBe(false);
    expect(meter(reading(), NOW, { readAt: readAgo(10) - 1 })?.stale).toBe(true);
    expect(meter(reading(), NOW, { readAt: readAgo(12) })?.stale).toBe(true);
  });

  it("is stale when the latest read failed, however recent the reading", () => {
    expect(meter(reading(), NOW, { readAt: readAgo(1), failed: true })?.stale).toBe(true);
    expect(meter(reading(), NOW, { readAt: readAgo(1), failed: false })?.stale).toBe(false);
  });

  it("draws the fill and the percent in the accent when fresh, in --muted when stale, on the same markup otherwise", () => {
    const fresh = draw(reading(), NOW, { readAt: readAgo(2) });
    const stale = draw(reading(), NOW, { readAt: readAgo(12) });
    expect(fresh).not.toContain("data-stale");
    expect(stale).toContain('data-stale="true"');
    expect(fresh).toContain("width:62%;background:var(--accent)");
    expect(stale).toContain("width:62%;background:var(--muted)");
    // A stale reading goes quiet even where it would be --warn or --err when fresh.
    expect(draw(reading({ session5hPct: 95 }), NOW, { readAt: readAgo(12) })).toContain("background:var(--muted)");
    expect(draw(reading({ session5hPct: 95 }), NOW, { failed: true })).toContain("background:var(--muted)");
    expect(decl(".session-list .sl-usage-btn[data-stale] .sl-usage-pct", "color")).toBe("var(--muted)");
    // The same one fill, the same width: only its colour changes.
    expect(stale.match(/sl-usage-fill/g)).toHaveLength(1);
    expect(stale).toContain("width:62%");
  });

  it("says when it was read on line 2, with the deck's short clock, and in the spoken name", () => {
    const m = meter(reading(), NOW, { readAt: readAgo(12) })!;
    expect(m.readAgo).toBe("read 12m ago");
    expect(m.spoken).toBe("Usage: Max 20x, 5-hour limit 62%, resets in 2h 9m, 7-day 31%, last read 12 minutes ago");
    const html = draw(reading(), NOW, { readAt: readAgo(12) });
    expect(html).toContain("<span>read 12m ago</span><span>·</span><span>Resets in 2h 9m</span>");
    expect(html).toContain('aria-label="Usage: Max 20x, 5-hour limit 62%, resets in 2h 9m, 7-day 31%, last read 12 minutes ago"');
    expect(meter(reading(), NOW, { readAt: readAgo(75) })?.readAgo).toBe("read 1h 15m ago");
  });

  it("names a failed-read but recent reading in whole minutes too", () => {
    expect(meter(reading({ week7dResetAt: NOW - 5 }), NOW, { readAt: readAgo(0), failed: true })?.spoken).toMatch(/last read less than a minute ago$/);
    expect(meter(reading(), NOW, { readAt: readAgo(1), failed: true })?.spoken).toMatch(/last read 1 minute ago$/);
  });

  it("says nothing of age on a fresh meter", () => {
    const m = meter(reading(), NOW, { readAt: readAgo(3) })!;
    expect(m.readAgo).toBeNull();
    expect(m.spoken).not.toContain("last read");
    expect(draw(reading(), NOW, { readAt: readAgo(3) })).not.toContain("read ");
  });

  it("still draws nothing without a reading or on a failed one, however it is aged", () => {
    expect(draw(null, NOW, { readAt: readAgo(30) })).toBe("");
    expect(draw(reading({ ok: false }), NOW, { readAt: readAgo(30), failed: true })).toBe("");
    expect(usageMeter(null, NOW * 1000)).toBeNull();
    expect(usageMeter({ reading: null, readAt: 0, failed: false }, NOW * 1000)).toBeNull();
  });

  it("uses tokens only for the quiet colours", () => {
    const quiet = rail.slice(rail.indexOf("A reading the deck has not taken lately"), rail.indexOf("The phone keeps the drawer"));
    expect(quiet).toContain("[data-stale]");
    expect(quiet.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(quiet).not.toMatch(/--accent/);
  });
});
