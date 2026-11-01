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
import type { QuotaData } from "../use-quota";
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
const draw = (q: QuotaData | null, nowSec = NOW) =>
  renderToStaticMarkup(createElement(RailUsage, { meter: usageMeter(q, nowSec), onPress: () => {} }));

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

describe("one fill, never amber", () => {
  it("draws ONE fill whose width is the percent, in the colour the panel's bar wears at a normal reading", () => {
    const html = draw(reading({ session5hPct: 62 }));
    expect(html.match(/sl-usage-fill/g)).toHaveLength(1);
    expect(html).toContain('style="width:62%"');
    expect(decl(".session-list .sl-usage-fill", "background")).toBe("var(--accent)");
    // QuotaBar's own normal colour (below its 70% and 90% steps) is --accent.
    expect(code("../components/QuotaBar.tsx")).toMatch(/capped >= 70 \? "var\(--warn\)" : "var\(--accent\)"/);
    // None of the five Figma segment colours: they have no data behind them.
    expect(rail).not.toMatch(/--usage-(?:cyan|indigo|lime|pink|orange)/);
  });

  it("keeps the normal fill at 95% and at 100%, where QuotaBar turns it warn and err", () => {
    for (const pct of [70, 90, 95, 100]) {
      const html = draw(reading({ session5hPct: pct }));
      expect(html).toContain(`style="width:${pct}%"`);
      expect(html).not.toMatch(/warn|err|danger|amber/);
    }
    const css = rail.slice(rail.indexOf(".session-list .sl-usage {"), rail.indexOf("The phone keeps the drawer"));
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/--warn|--err|amber|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const model = code("../rail-usage.ts") + code("../components/RailParts.tsx");
    expect(model).not.toMatch(/limitReached|var\(--warn\)|var\(--err\)/);
  });

  it("caps the width at 0 to 100", () => {
    expect(draw(reading({ session5hPct: 140 }))).toContain('style="width:100%"');
    expect(draw(reading({ session5hPct: -5 }))).toContain('style="width:0%"');
    expect(usageMeter(reading({ session5hPct: 140 }), NOW)?.pctText).toBe("100%");
  });

  it("prints the percent the way the panel's bar does", () => {
    expect(usageMeter(reading({ session5hPct: 61.6 }), NOW)?.pctText).toBe("62%");
    expect(usageMeter(reading({ session5hPct: 0.25 }), NOW)?.pctText).toBe("< 1%");
    expect(code("../components/QuotaBar.tsx")).toContain("quotaPctText(capped)");
  });
});

describe("what it says, and when it says nothing", () => {
  it("prints the account, the limit, the percent, the reset and the 7-day figure", () => {
    const m = usageMeter(reading(), NOW)!;
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
    expect(usageMeter(reading(), NOW)?.spoken).toBe("Usage: Max 20x, 5-hour limit 62%, resets in 2h 9m, 7-day 31%");
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
    expect(usageMeter(undefined, NOW)).toBeNull();
  });

  it("drops '· 7-day …' without a 7-day reading, and 'Resets in …' without a reset", () => {
    const noWeek = usageMeter(reading({ week7dPct: null }), NOW)!;
    expect(noWeek.week).toBeNull();
    expect(noWeek.spoken).toBe("Usage: Max 20x, 5-hour limit 62%, resets in 2h 9m");
    expect(draw(reading({ week7dPct: null }))).toContain("<span>Resets in 2h 9m</span></span>");
    expect(draw(reading({ week7dPct: null }))).not.toContain("·");
    const noReset = usageMeter(reading({ session5hResetAt: undefined }), NOW)!;
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
    const m = usageMeter(reading({ planLabel: null }), NOW)!;
    expect(m.name).toBeNull();
    expect(m.spoken).toBe("Usage: 5-hour limit 62%, resets in 2h 9m, 7-day 31%");
    expect(draw(reading({ planLabel: undefined }))).not.toContain("sl-usage-name");
  });

  it("does not print a week whose reset has passed", () => {
    expect(usageMeter(reading({ week7dResetAt: NOW - 5 }), NOW)?.week).toBeNull();
  });
});

describe("where the reading comes from, and what the button does", () => {
  it("polls /api/quota once: App.tsx holds useQuota, the panel is handed it, the rail only reads", () => {
    const app = code("../App.tsx");
    expect(app.match(/useQuota\(/g)).toHaveLength(1);
    expect(app).toContain("useQuota(providers.claude)");
    expect(app).toMatch(/claudeQuota=\{claudeQuota\}/);
    expect(app).toMatch(/quota=\{providers\.claude \? claudeQuota\.quota : null\}/);
    expect(code("../components/UsagePanel.tsx")).not.toMatch(/\buseQuota\(/);
    for (const f of ["../components/SessionList.tsx", "../components/RailParts.tsx", "../rail-usage.ts"]) {
      expect(code(f), f).not.toMatch(/\bfetch\(|setInterval|useQuota\(|import \{[^}]*useQuota/);
    }
    expect(code("../rail-usage.ts")).toContain('import type { QuotaData } from "./use-quota"');
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
    expect(imports.sort()).toEqual(["./components/QuotaBar", "./relative-time", "./use-quota"]);
    // QuotaBar is reached from App.tsx's static UsagePanel import already.
    expect(code("../App.tsx")).toContain('import UsagePanel from "./components/UsagePanel";');
    expect(code("../App.tsx")).not.toMatch(/const UsagePanel = lazy/);
  });

  it("writes no literal colour in the rule it adds", () => {
    const css = rail.slice(rail.indexOf(".session-list .sl-usage {"), rail.indexOf("The phone keeps the drawer")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
