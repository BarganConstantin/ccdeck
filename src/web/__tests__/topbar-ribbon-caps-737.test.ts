// The selected-node ribbon's caps (#737), and the month phrase that set them.
//
// #737 put a month-to-date phrase on the topbar, read from ccusage, and gave
// the ribbon the job of making room for it: the ribbon is the one member of the
// bar that can say less and still be itself. The phrase left the bar on
// 2026-10-08 — a month's total is not a fact about right now, and keeping it
// current cost a ccusage run every five minutes — and the Usage panel says the
// month beside today and all time (usage-panel-source-737.test.ts).
//
// The ribbon whose caps this file also pinned is gone (V4's Figma:
// the Inspector names the selected session, Esc clears it and Z frames it), so
// its caps went with it. What is pinned here is what outlives it: nothing in the
// page reads ccusage in the background any more, and the month phrase left no
// hook, helper or rule.
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
