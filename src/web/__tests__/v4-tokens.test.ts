// V4's tokens (its Figma variables of 2026-10-31): the colours Phase 1
// adds, in every shipped theme, at the values
// Figma draws them on its Dark (the Rider Black theme) and its Light; the
// size ladder, Compact (V4's default density) and Default; the type roles of
// its text styles; its motion, with the one curve the sheet now spells; and
// the one shadow it casts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES, color, hex, palette, web, type Rgba } from "./integrations-palette";
import { EASE } from "../motion-ease";
import { FLIP_CLOSE_MS, FLIP_EASE, FLIP_OPEN_MS } from "../navigator-flip";

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

/** V4's text styles: each role's size and line height, in px. */
const TYPE_ROLES: Record<string, [number, number]> = {
  hero: [22, 28],
  title: [18, 24],
  "card-title": [14, 20],
  body: [13, 20],
  small: [12, 16],
  code: [12, 16],
  meta: [11, 14],
};
/** The sheet's type ladder, as type-ladder.test.ts holds every font-size to it. */
const TYPE_LADDER = [9, 10, 11, 12, 13, 14, 16, 18, 22, 26, 34];

describe("V4's type roles", () => {
  const base = sizes("tokens.css", ":root");

  it.each(Object.entries(TYPE_ROLES))("--fs-%s and its line height are Figma's", (role, [size, leading]) => {
    expect(base[`fs-${role}`]).toBe(`${size}px`);
    expect(base[`lh-${role}`]).toBe(`${leading}px`);
  });

  it("puts every role on a step of the sheet's ladder", () => {
    for (const [role, [size]] of Object.entries(TYPE_ROLES)) expect(TYPE_LADDER, role).toContain(size);
  });

  it("leaves type to the text size: no density restates a role", () => {
    for (const step of ["tightest", "tighter", "compact", "comfortable"]) {
      const own = sizes("reading.css", `:root[data-density="${step}"]`);
      expect(Object.keys(own).filter(name => /^(fs|lh)-/.test(name)), step).toEqual([]);
    }
  });
});

/** V4's motion variables. */
const MOTION: Record<string, string> = {
  "dur-fast": "120ms",
  "dur-exit": "150ms",
  "dur-base": "200ms",
  "dur-move": "240ms",
  "dur-stage-in": "280ms",
  "dur-stage-out": "200ms",
  "dur-slow": "400ms",
  "delay-step": "40ms",
  "delay-loader": "150ms",
  "delay-tooltip": "450ms",
  "loop-loader": "1200ms",
  "loop-loader-person": "2400ms",
  ease: "cubic-bezier(0.23, 1, 0.32, 1)",
  "ease-stage": "cubic-bezier(0.32, 0.72, 0, 1)",
  press: "0.97",
  "press-small": "0.94",
  "enter-scale": "0.96",
};

/** Every file under the app's source that is not a test. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(path);
    return /\.(css|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("V4's motion", () => {
  const base = sizes("tokens.css", ":root");
  const ms = (name: string) => Number.parseFloat(base[name]);

  it.each(Object.entries(MOTION))("--%s is Figma's", (name, value) => {
    expect(base[name]).toBe(value);
  });

  it("leaves quicker than it comes", () => {
    expect(ms("dur-exit")).toBeLessThan(ms("dur-base"));
    expect(ms("dur-stage-out")).toBeLessThan(ms("dur-stage-in"));
  });

  it("animates TypeScript on the sheet's values, which it cannot read as var()", () => {
    expect(EASE).toBe(base.ease);
    expect(`cubic-bezier(${FLIP_EASE.join(", ")})`).toBe(base["ease-stage"]);
    expect(`${FLIP_OPEN_MS}ms`).toBe(base["dur-stage-in"]);
    expect(`${FLIP_CLOSE_MS}ms`).toBe(base["dur-stage-out"]);
  });

  it("spells one out-curve: the two it replaced, and the names that carried them, are gone", () => {
    const old = /cubic-bezier\(\s*0\.(?:22\s*,\s*1\s*,\s*0\.36|16\s*,\s*1\s*,\s*0\.3)\s*,\s*1\s*\)|--nm-ease|--nm-draw|--column-(?:move|ease)/;
    expect(sources(web).filter(file => old.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});

/** V4's one shadow, on its dialogs and ⌘K: Figma's value on Dark and on Light. */
const OVERLAY = { dark: "0 16px 40px rgba(0,0,0,0.45)", light: "0 16px 40px rgba(0,0,0,0.16)" };

describe("V4's overlay shadow", () => {
  const scheme = (theme: string) => JSON.parse(readFileSync(`${web}themes/${theme}.json`, "utf8")).colorScheme as "dark" | "light";

  it.each(THEMES)("%s casts Figma's shadow for its scheme", (theme) => {
    const got = palette(theme)["shadow-overlay"];
    // Gruvbox Light's shadows follow its warm paper, as its README says: the
    // same throw and share as Light's, in the theme's own brown ink.
    const want = theme === "gruvbox-light" ? "0 16px 40px rgba(60,56,54,0.16)" : OVERLAY[scheme(theme)];
    expect(got, `--shadow-overlay in ${theme}`).toBe(want);
  });
});
