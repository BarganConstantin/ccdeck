// The selected-node ribbon's caps (#737), and the month phrase that set them.
//
// #737 put a month-to-date phrase on the topbar, read from ccusage, and gave
// the ribbon the job of making room for it: the ribbon is the one member of the
// bar that can say less and still be itself. The phrase left the bar on
// 2026-10-08 — a month's total is not a fact about right now, and keeping it
// current cost a ccusage run every five minutes — and the Usage panel says the
// month beside today and all time (usage-panel-source-737.test.ts).
//
// The caps held where the phrase put them until the topbar's redesign settled
// every width tier at once (2026-10-08): the panel toggles left the bar for the
// window's edges, and the caps were recut to the bar that is left. What is
// pinned here is the caps as recut, that a selection still never decides what
// the readout holds, and that nothing in the page reads ccusage in the
// background any more.
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

describe("the ribbon's caps, as #737 cut them and the bar's redesign recut them", () => {
  /** The busiest bar besides the ribbon, measured in headless Brave at 1440
   *  (topbar-status.css): padding, the readout with "12 waiting", the gaps,
   *  and Settings and Feedback with their words. */
  const BUSIEST_BAR_PX = 541;
  const HEADROOM_PX = 40;
  const cap = /@media \(min-width: (\d+)px\) \{\s*\.selected-ribbon \{ max-width: min\(380px, 24vw, calc\(100vw - (\d+)px\)\); \}/.exec(css);

  it("makes the ribbon give up the room instead, and never past what fits", () => {
    // #737 cut two bands, W - 867 on glyphs and W - 1253 once the words
    // arrived, around eight panel toggles and the month's phrase. Both left
    // the bar on 2026-10-08, the toggles for the window's edges, and with them
    // went the bands: one cap from where the ribbon returns, the room the bar
    // leaves it less the headroom, and never more than its usual cap.
    expect(cap, "the ribbon's cap").toBeTruthy();
    const [, from, reserve] = cap!.map(Number);
    expect(from).toBe(641);
    expect(reserve).toBe(BUSIEST_BAR_PX + HEADROOM_PX);
    // The glyph and word bands are gone, and so are the words' tiers.
    expect(css).not.toMatch(/max-width: min\(24vw, calc\(100vw - \d+px\)\)/);
    expect(css).not.toMatch(/max-width: min\(380px, calc\(100vw - \d+px\)\)/);
    expect(css).not.toMatch(/\.tb-word/);
    // It is under its usual 24vw only below the width where W - reserve meets
    // 24vw; above it the ribbon is its usual self.
    const meets = reserve / 0.76;
    expect(Math.ceil(meets)).toBe(765);
    // And it is after the ribbon's own rule, which would otherwise win on order.
    expect(css.indexOf(cap![0])).toBeGreaterThan(css.indexOf(".selected-ribbon {"));
  });

  it("drops the ribbon's cost below 1140, and only there", () => {
    // Under 1140 the ribbon's 24vw holds a state, a cost that does not shrink
    // and a name ellipsed to nothing; the cost stays on the card, in the
    // detail panel and in the ribbon's own title (topbar-ribbon-cost.test.ts
    // adds the bar up). The 1440–1632 band went with the words that made it.
    const cost = /@media \(max-width: (\d+)px\) \{\s*\.selected-ribbon \.selected-cost \{ display: none; \}\s*\}/.exec(css);
    expect(cost, "the cost's band").toBeTruthy();
    expect(Number(cost![1])).toBe(1139);
    expect(css).not.toMatch(/\(min-width: 1440px\) and \(max-width: \d+px\) \{\s*\.selected-ribbon \.selected-cost/);
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
