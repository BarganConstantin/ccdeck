// The selected-node ribbon's caps (#737), and the month phrase that set them.
//
// #737 put a month-to-date phrase on the topbar, read from ccusage, and gave
// the ribbon the job of making room for it: the ribbon is the one member of the
// bar that can say less and still be itself. The phrase left the bar on
// 2026-10-08 — a month's total is not a fact about right now, and keeping it
// current cost a ccusage run every five minutes — and the Usage panel says the
// month beside today and all time (usage-panel-source-737.test.ts).
//
// The caps stay where the phrase put them until the topbar's redesign settles
// every width tier at once, so what is pinned here is the caps as cut, that a
// selection still never decides what the readout holds, and that nothing in the
// page reads ccusage in the background any more.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(join(web, "App.tsx"), "utf8");
const readouts = readFileSync(join(web, "components/TopbarReadouts.tsx"), "utf8");
const sheet = sheetText();
const css = sheet.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every page source outside the tests, by path relative to src/web. */
function pageSources(dir = web, prefix = ""): [string, string][] {
  return readdirSync(join(dir), { withFileTypes: true }).flatMap(e => {
    if (e.isDirectory()) return e.name === "__tests__" ? [] : pageSources(join(dir, e.name), `${prefix}${e.name}/`);
    return /\.tsx?$/.test(e.name) ? [[`${prefix}${e.name}`, readFileSync(join(dir, e.name), "utf8")] as [string, string]] : [];
  });
}

describe("the topbar's month phrase is gone (#737)", () => {
  it("leaves no phrase, no hook and no rule behind", () => {
    expect(existsSync(join(web, "use-monthly-usage.ts")), "the hook that polled ccusage for the phrase").toBe(false);
    expect(existsSync(join(web, "monthly-usage.ts")), "the phrase's cadence and formatter").toBe(false);
    expect(readouts).not.toMatch(/month-usage|monthlyUsage|monthUsageRef|fmtMonthlyCost/);
    expect(app).not.toMatch(/useMonthlyUsage|monthly=\{/);
    expect(css).not.toContain(".month-usage");
  });

  it("reads ccusage only for a surface somebody opened", () => {
    // The phrase was the one reader with no panel behind it: every five minutes
    // while the tab was in front, a walk of every transcript on disk. What is
    // left is the Usage panel's period, the history modal and an account's
    // Projects report, each mounted only while it is open.
    const readers = pageSources()
      .filter(([, src]) => /`\/api\/ccusage\?/.test(src))
      .map(([path]) => path)
      .sort();
    expect(readers).toEqual(["account-projects-load.ts", "use-ccusage.ts", "use-usage-range.ts"]);
  });
});

describe("the ribbon's caps, as #737 cut them", () => {
  it("makes the ribbon give up the room instead, and never past what fits", () => {
    // Room for the ribbon beside the budget case, measured in Chromium, less
    // 40px of headroom: W - 867 on glyphs, W - 1253 once the words arrive. The
    // budget had the phrase in it, so these are now short of the room by the
    // phrase and its gap, and held there for the redesign (topbar-status.css).
    const glyphs = /@media \(min-width: (\d+)px\) and \(max-width: (\d+)px\) \{\s*\.selected-ribbon \{ max-width: min\(24vw, calc\(100vw - (\d+)px\)\); \}/.exec(css);
    const words = /@media \(min-width: (\d+)px\) \{\s*\.selected-ribbon \{ max-width: min\(380px, calc\(100vw - (\d+)px\)\); \}/.exec(css);
    expect(glyphs, "the glyph band's ribbon cap").toBeTruthy();
    expect(words, "the words band's ribbon cap").toBeTruthy();
    const [, gFrom, gTo, gReserve] = glyphs!.map(Number);
    const [, wFrom, wReserve] = words!.map(Number);
    // The bands start where the phrase's floor was and meet the words' arrival.
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
    // card, in the detail panel and in the ribbon's own title. Under 1040 too,
    // with no lower bound: there the controls leave the ribbon short of 24vw,
    // and its cost ran over them (topbar-ribbon-cost.test.ts).
    const reserve = (re: RegExp) => Number(re.exec(css)![1]);
    const g = reserve(/max-width: min\(24vw, calc\(100vw - (\d+)px\)\)/);
    const w = reserve(/max-width: min\(380px, calc\(100vw - (\d+)px\)\)/);
    const cost = /@media \(max-width: (\d+)px\), \(min-width: 1440px\) and \(max-width: (\d+)px\) \{\s*\.selected-ribbon \.selected-cost \{ display: none; \}\s*\}/.exec(css);
    expect(cost, "the cost's band").toBeTruthy();
    const [, gEnd, wEnd] = cost!.map(Number);
    // Glyphs: W - g meets 24vw at g / 0.76. Words: W - w meets 380 at w + 380.
    expect(gEnd).toBe(Math.floor(g / 0.76) - 1);
    expect(wEnd).toBe(w + 380 - 1);
    // The ribbon is components/SelectedRibbon.tsx's. Z through withKey, named
    // while Settings › General's single-key switch is on.
    expect(readFileSync(join(web, "components/SelectedRibbon.tsx"), "utf8")).toMatch(/className="selected-ribbon"[\s\S]{0,400}?title=\{`\$\{withKey\(`Zoom to \$\{selected\.label\} and its session`, "Z", singleKeys\)\}\$\{\s*c\.total > 0 \? `\\n\$\{fmtCost\(c\.total\)\} spent/);
  });

  it("never lets a selection decide what the readout holds", () => {
    // It did, under 1760px: the phrase sat ahead of the blocked-session chip,
    // and selecting a card hid it and slid the alarm 204px left. The phrase is
    // gone and the rule is not. No rule that hides anything in the readout may
    // name the ribbon, or anything else a click on the canvas can put on the bar.
    const hiders = [...css.matchAll(/([^{}]+)\{[^{}]*display:\s*none;[^{}]*\}/g)]
      .flatMap(m => m[1].split(","))
      .map(sel => sel.trim())
      .filter(sel => /\.topbar\b.*(?:\.readout|\.status|\.brand|\.waiting-stat|\.provider-incident|\.notify-said)/.test(sel));
    expect(hiders.length).toBeGreaterThan(0);
    for (const sel of hiders) expect(sel).not.toMatch(/selected|:has\(\.selected|\.btn\.danger/);
  });
});
