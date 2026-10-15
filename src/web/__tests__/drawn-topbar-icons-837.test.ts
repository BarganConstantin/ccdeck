// #837: the topbar mixed typed glyphs (☰, $, ☀/☾) with drawn SVG icons. Typed
// glyphs come from each platform's fonts, so they render at different sizes,
// weights and baselines on macOS, Windows and Linux — the defect the accounts
// header's own comment names. The five drawn ones were not one family either:
// strokes of 1.3, 1.4, 1.5, 1.5 and 1.6. All of them are drawn on one spec now.
//
// The panel toggles left the topbar for the window's edges (2026-10-08). The
// glyphs went with them, unchanged, into components/rail-glyphs.tsx, which the
// stripes, the phone's dock and the two utilities still on the bar all draw
// from, so the spec is held there now — plus the dock's More, the one glyph
// drawn in components/EdgeRails.tsx itself — and the topbar's own markup is
// still held to drawing no typed glyph.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const glyphs = read("../components/rail-glyphs.tsx");
const rails = read("../components/EdgeRails.tsx");
const items = read("../rail-items.tsx");
const readouts = read("../components/TopbarReadouts.tsx");
/** Everything the chrome draws: the topbar's markup, its readouts, the edges. */
const chrome = (/<header className="topbar"[\s\S]*?<\/header>/.exec(app)?.[0] ?? "")
  + "\n" + readouts + "\n" + rails + "\n" + glyphs + "\n" + items;

/** The eight controls' glyphs, by the name rail-items.tsx draws each with. */
const EIGHT = [
  "SessionListGlyph", "AccountsGlyph", "UsageGlyph", "HistoryGlyph",
  "MachineGlyph", "BrowserWatchGlyph", "SettingsGlyph", "FeedbackGlyph",
];

describe("the chrome draws its icons on one spec (#837)", () => {
  it("finds the topbar", () => {
    expect(app, "no <header className=\"topbar\"> in App.tsx").toMatch(/<header className="topbar"/);
  });

  it("types no glyph into a button", () => {
    const typed = [...chrome.matchAll(/>\s*([☰$☀☾⚙↻+×✕])\s*<\/button>/g)].map(m => m[1]);
    expect(typed).toEqual([]);
    expect(chrome).not.toMatch(/["'][☀☾☰]["']/);
  });

  it("draws every icon at 13px on a 14 viewBox, with one stroke, round caps and joins", () => {
    const svgs = [...chrome.matchAll(/<svg\b[^>]*>/g)].map(m => m[0]);
    // The set's one <svg>, which all eight are drawn through, and the dock's ⋯.
    expect(svgs.length, "the set's frame and the dock's More").toBeGreaterThanOrEqual(2);
    for (const svg of svgs) {
      expect(svg).toMatch(/width="13" height="13" viewBox="0 0 14 14"/);
      expect(svg).toMatch(/strokeWidth="1\.4"/);
      expect(svg).toMatch(/strokeLinecap="round"/);
      expect(svg).toMatch(/strokeLinejoin="round"/);
      expect(svg).toMatch(/aria-hidden/);
    }
  });

  it("draws all eight controls through the one frame, so none can leave the spec alone", () => {
    // One <svg> in the whole set: a glyph is a body inside <Glyph>, and the
    // frame is where the size, the stroke and the caps are written, once.
    expect(glyphs.match(/<svg\b/g)).toHaveLength(1);
    for (const name of EIGHT) {
      expect(glyphs, `${name} is not in the set`).toMatch(new RegExp(`export const ${name} = [^\\n]*\\n\\s*<Glyph`));
      expect(items, `rail-items.tsx does not draw ${name}`).toContain(`<${name}`);
    }
  });
});
