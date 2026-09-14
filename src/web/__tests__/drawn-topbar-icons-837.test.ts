// #837: the topbar mixed typed glyphs (☰, $, ☀/☾) with drawn SVG icons. Typed
// glyphs come from each platform's fonts, so they render at different sizes,
// weights and baselines on macOS, Windows and Linux — the defect the accounts
// header's own comment names. The five drawn ones were not one family either:
// strokes of 1.3, 1.4, 1.5, 1.5 and 1.6. All of them are drawn on one spec now.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const bar = /<header className="topbar"[\s\S]*?<\/header>/.exec(app)?.[0] ?? "";

describe("the topbar draws its icons on one spec (#837)", () => {
  it("finds the topbar", () => {
    expect(bar, "no <header className=\"topbar\"> in App.tsx").not.toBe("");
  });

  it("types no glyph into a button", () => {
    const typed = [...bar.matchAll(/>\s*([☰$☀☾⚙↻+×✕])\s*<\/button>/g)].map(m => m[1]);
    expect(typed).toEqual([]);
    expect(bar).not.toMatch(/["'][☀☾☰]["']/);
  });

  it("draws every icon at 13px on a 14 viewBox, with one stroke, round caps and joins", () => {
    const svgs = [...bar.matchAll(/<svg\b[^>]*>/g)].map(m => m[0]);
    expect(svgs.length, "the eight buttons, the theme one drawing two").toBeGreaterThanOrEqual(9);
    for (const svg of svgs) {
      expect(svg).toMatch(/width="13" height="13" viewBox="0 0 14 14"/);
      expect(svg).toMatch(/strokeWidth="1\.4"/);
      expect(svg).toMatch(/strokeLinecap="round"/);
      expect(svg).toMatch(/strokeLinejoin="round"/);
      expect(svg).toMatch(/aria-hidden/);
    }
  });
});
