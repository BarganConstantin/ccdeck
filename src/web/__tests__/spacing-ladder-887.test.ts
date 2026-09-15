// #887: spacing and radius had no scale. The audit counted about seventeen
// border radii, gaps at every pixel from 0 to 24, and ninety distinct
// paddings, while type sizes were already a closed ladder held by
// type-ladder.test.ts, so every new component picked its own numbers.
//
// Two closed ladders now, held the way the type ladder is: every gap, padding
// and border-radius in the sheet sits on one.
//
// THE SPACE LADDER keeps every pixel below 6, because in a UI set in 10 and
// 11px type a one-pixel pad on a pill or a two-pixel hairline gap is an
// optical decision rather than drift — and 5px is load-bearing: a tool
// bubble's vertical padding is what ToolBursts' BUBBLE_HALF_H measures by.
// From 6px up it is even pixels to 20, then 24, 32 and 40.
//
// THE RADIUS LADDER keeps the fine steps a small chip needs, the 10px every
// card and panel wears, 12 and 16 for larger surfaces, 18 for the category
// bar (its own half-height, so a bar that wraps to two lines is not a lozenge),
// and the two shapes: a pill (999px) and a circle (50%).
//
// What moved to fit: spacing at 7, 9, 11 and 19px went to the even step above,
// 22 and 26px to 24; radii of 5px went to 6, the radius the controls already
// wear; 7px on the two 14px-tall pills became 999px, which is what it always
// drew; 1.5px went to 2.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const raw = read("../styles.css");
/** Blanked rather than cut, so a reported line points at its rule. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const lineOf = (at: number) => css.slice(0, at).split("\n").length;

const SPACE_LADDER = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40];
const RADIUS_LADDER = [0, 1, 2, 3, 4, 6, 8, 10, 12, 16, 18];
const RADIUS_SHAPES = ["999px", "50%", "inherit"];

const SPACE_PROP = /^(?:row-|column-)?gap$|^padding(?:-[a-z-]+)?$/;
const RADIUS_PROP = /^border(?:-(?:top|bottom)-(?:left|right))?-radius$/;

/** Every declaration in the sheet, @media bodies included. */
const DECLS: Array<{ sel: string; prop: string; value: string; at: number }> = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim().replace(/\s+/g, " ");
  for (const d of m[2].split(";")) {
    const x = /^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
    if (x) DECLS.push({ sel, prop: x[1], value: x[2], at: m.index! });
  }
}

/** The value's top-level words: a var() or calc() is a token's business, not
 *  the ladder's, and !important is not a length. */
function atoms(value: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out.filter(a => !a.includes("(") && a !== "!important");
}

const px = (a: string): number | null => (a === "0" ? 0 : /^\d+(?:\.\d+)?px$/.test(a) ? parseFloat(a) : null);

describe("spacing is a closed ladder (#887)", () => {
  const space = DECLS.filter(d => SPACE_PROP.test(d.prop));

  it("sets every gap and padding in the sheet to a step on the ladder", () => {
    const off = space.flatMap(d => atoms(d.value)
      .filter(a => { const n = px(a); return n === null || !SPACE_LADDER.includes(n); })
      .map(a => `styles.css:${lineOf(d.at)} ${d.sel} { ${d.prop}: ${d.value} } — ${a}`));
    expect(off).toEqual([]);
  });

  it("sees enough of the sheet for that to mean something", () => {
    expect(space.length).toBeGreaterThan(300);
  });

  it("keeps the tool bubble's 5px, which the canvas measures by", () => {
    const bubble = DECLS.find(d => d.sel === ".tool-burst" && d.prop === "padding")!;
    expect(atoms(bubble.value)[0]).toBe("5px");
    expect(read("../components/ToolBursts.tsx")).toMatch(/const BUBBLE_HALF_H = 16;/);
  });
});

describe("radius is a closed ladder (#887)", () => {
  const radii = DECLS.filter(d => RADIUS_PROP.test(d.prop));

  it("sets every border radius in the sheet to a step on the ladder, or to a pill or a circle", () => {
    const off = radii.flatMap(d => atoms(d.value)
      .filter(a => { if (RADIUS_SHAPES.includes(a)) return false; const n = px(a); return n === null || !RADIUS_LADDER.includes(n); })
      .map(a => `styles.css:${lineOf(d.at)} ${d.sel} { ${d.prop}: ${d.value} } — ${a}`));
    expect(off).toEqual([]);
  });

  it("sees enough of the sheet for that to mean something", () => {
    expect(radii.length).toBeGreaterThan(150);
  });

  it("draws the two 14px pills as pills, and the controls' 6px where 5px was", () => {
    expect(DECLS.find(d => d.sel === ".cost-bar.cost-bar-lg" && d.prop === "border-radius")?.value).toBe("999px");
    expect(DECLS.find(d => d.sel === ".bw-badge" && d.prop === "border-radius")?.value).toBe("999px");
    expect(DECLS.find(d => d.sel === ".ap-field select" && d.prop === "border-radius")?.value).toBe("6px");
  });
});
