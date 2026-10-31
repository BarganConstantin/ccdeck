// V4's tokens (its Figma variables of 2026-10-31): the colours Phase 1
// adds, in every shipped theme, at the values
// Figma draws them on its Dark (the Rider Black theme) and its Light; and the
// size ladder, Compact (V4's default density) and Default.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES, color, hex, palette, web, type Rgba } from "./integrations-palette";

/** Figma's value for each new colour, on Dark (Rider Black) and on Light. */
const FIGMA: Record<string, [string, string]> = {
  "accent-16": ["#83acfc29", "#0369a129"],
  "err-12": ["#eb938d1f", "#b91c1c1f"],
  "muted-30": ["#a3a6ae4d", "#4a52604d"],
  "secondary-30": ["#b4b8bf4d", "#3038454d"],
  "warn-35": ["#f2c55c59", "#9c560059"],
  "inflight-30": ["#f0abfc4d", "#7e22ce4d"],
  dock: ["#232528", "#f5f7fa"],
  scrim: ["#00000052", "#0d11172e"],
  selected: ["#393b3e", "#ececec"],
  sunken: ["#1b1c1f", "#fbfbfc"],
  "your-message": ["#373f4d", "#dceaf2"],
};
/** The tints, each a theme colour at one share: they follow the theme's own
 *  colour, so a theme whose base differs from Figma's tints its own. */
const TINTS: Record<string, [string, number]> = {
  "accent-16": ["accent", 0.16],
  "err-12": ["err", 0.12],
  "muted-30": ["muted", 0.3],
  "secondary-30": ["text-secondary", 0.3],
  "warn-35": ["warn", 0.35],
  "inflight-30": ["inflight", 0.3],
};
/** Bases today's palette does not share with Figma yet (the owner's open
 *  decisions: Rider Black's muted text, Light's Waiting colour); their tints
 *  are held to the theme's base and to Figma's share only. */
const BASE_DIFFERS = new Set(["rider-black muted-30", "light warn-35"]);

const near = (got: Rgba, want: Rgba) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(1);
  expect(Math.abs(got[3] - want[3])).toBeLessThanOrEqual(1 / 255 + 1e-9);
};

describe("V4's new colours", () => {
  it.each(THEMES)("%s declares every one of them, and each one resolves", (theme) => {
    const scope = palette(theme);
    for (const name of Object.keys(FIGMA)) {
      expect(scope[name], `--${name} in ${theme}`).toBeTruthy();
      const c = color(scope[name], scope);
      expect(c[3]).toBeGreaterThan(0);
      expect(c[3]).toBeLessThanOrEqual(1);
    }
  });

  it.each(THEMES)("%s tints its own colours at Figma's shares", (theme) => {
    const scope = palette(theme);
    for (const [name, [base, share]] of Object.entries(TINTS)) {
      const got = color(scope[name], scope);
      const own = color(scope[base], scope);
      near(got, [own[0], own[1], own[2], own[3] * share]);
    }
  });

  it.each([
    ["rider-black", 0],
    ["light", 1],
  ] as const)("%s draws them as Figma does", (theme, side) => {
    const scope = palette(theme);
    for (const [name, values] of Object.entries(FIGMA)) {
      const want = hex(values[side]);
      const got = color(scope[name], scope);
      if (BASE_DIFFERS.has(`${theme} ${name}`)) {
        expect(Math.abs(got[3] - want[3])).toBeLessThanOrEqual(1 / 255 + 1e-9);
        continue;
      }
      near(got, want);
    }
  });
});

/** Every custom property the top-level rules naming `selector` declare, later
 *  rules over earlier ones — a selector can be restated in more than one rule. */
function sizes(file: string, selector: string): Record<string, string> {
  const src = readFileSync(`${web}styles/${file}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  let depth = 0, start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") {
      const head = src.slice(start, i).trim();
      const close = src.indexOf("}", i);
      const inner = src.slice(i + 1, close);
      if (depth === 0 && !head.startsWith("@") && !inner.includes("{")
        && head.split(",").some(sel => sel.trim() === selector)) {
        for (const m of inner.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
      }
      depth++;
      start = i + 1;
    } else if (src[i] === "}") {
      depth--;
      start = i + 1;
    } else if (src[i] === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return out;
}

/** V4's size ladder in Figma: [Compact, Default], in px. */
const LADDER: Record<string, [number, number]> = {
  "topbar-h": [40, 44],
  "statusbar-h": [24, 28],
  "edge-w": [40, 40],
  "rail-w": [264, 288],
  "inspector-w": [320, 360],
  "pane-head-h": [36, 44],
  "row-rail": [44, 60],
  "row-group": [24, 28],
  "row-tool": [24, 28],
  "row-table": [28, 36],
  "row-option": [44, 56],
  "row-settings": [48, 64],
  "ctl-h-lg": [32, 36],
  "ctl-h": [28, 30],
  "ctl-h-sm": [24, 26],
  "r-tag": [4, 4],
  "r-ctl": [6, 6],
  "r-panel": [8, 8],
  "r-node": [10, 10],
  "r-overlay": [12, 12],
  "r-pill": [999, 999],
  "dialog-head-h": [44, 52],
  "dialog-foot-h": [48, 56],
};

describe("V4's sizes", () => {
  const base = sizes("tokens.css", ":root");
  const compact = { ...base, ...sizes("reading.css", ':root[data-density="compact"]') };
  const comfortable = { ...base, ...sizes("reading.css", ':root[data-density="comfortable"]') };

  it.each(Object.entries(LADDER))("--%s is Figma's at Default and at Compact", (name, [atCompact, atDefault]) => {
    expect(base[name]).toBe(`${atDefault}px`);
    expect(compact[name]).toBe(`${atCompact}px`);
  });

  it("the two steps tighter than Compact keep Compact's chrome and rows", () => {
    for (const step of ["tightest", "tighter"]) {
      const own = { ...base, ...sizes("reading.css", `:root[data-density="${step}"]`) };
      for (const name of Object.keys(LADDER)) {
        if (name === "ctl-h") continue; // each step has its own control height
        expect(own[name], `--${name} at ${step}`).toBe(compact[name]);
      }
    }
  });

  it("Comfortable keeps Default's chrome and rows, with its own control height", () => {
    for (const name of Object.keys(LADDER)) {
      if (name === "ctl-h") continue;
      expect(comfortable[name], `--${name} at comfortable`).toBe(base[name]);
    }
    expect(comfortable["ctl-h"]).toBe("36px");
  });
});
