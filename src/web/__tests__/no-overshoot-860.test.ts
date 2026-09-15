// #860: every tool bubble overshot to scale 1.06 and sprang back as it landed,
// and its ✓ spun in from 0.3 at -30°, both on a back-out curve, on the element
// the canvas draws most (107 bubbles in one view). The sheet's own rule is that
// what you see hundreds of times a day does not celebrate, and a wobble on
// every tool call competes with the done flash and the error shake, the two
// motions that carry meaning. Both now arrive on the sheet's ease-out and stop
// at their own size.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/** A curve whose y control points leave 0..1 carries the value past its target. */
const overshoots = (curve: string) => {
  const [, y1, , y2] = curve.slice(curve.indexOf("(") + 1, -1).split(",").map(Number);
  return y1 > 1 || y2 > 1 || y1 < 0 || y2 < 0;
};

const keyframes = (name: string): string => {
  const at = css.indexOf(`@keyframes ${name} {`);
  expect(at, `@keyframes ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error("unbalanced");
};

describe("nothing on the canvas springs past its size (#860)", () => {
  it("has no overshooting curve anywhere in the sheet", () => {
    const bouncing = [...css.matchAll(/cubic-bezier\([^)]*\)/g)].map(m => m[0]).filter(overshoots);
    expect(bouncing).toEqual([]);
  });

  it("runs every bubble spawn on the sheet's ease-out", () => {
    const spawns = [...css.matchAll(/bubble-spawn\s+\d+ms(?:\s+\d+ms)?\s+(cubic-bezier\([^)]*\)|[\w-]+)/g)];
    expect(spawns.length).toBeGreaterThanOrEqual(6);
    for (const m of spawns) expect(m[1]).toBe(EASE_OUT);
  });

  it("never scales a bubble above its own size on the way in", () => {
    const frames = keyframes("bubble-spawn");
    const scales = [...frames.matchAll(/scale\(([\d.]+)\)/g)].map(m => Number(m[1]));
    expect(scales.length).toBeGreaterThan(0);
    expect(Math.max(...scales)).toBe(1);
    expect(frames).not.toMatch(/animation-timing-function/);
  });

  it("brings the ✓ in from 0.6 with no spin, on the same ease-out", () => {
    const frames = keyframes("mark-pop");
    expect(frames).toMatch(/from\s*\{\s*opacity:\s*0;\s*transform:\s*scale\(0\.6\);\s*\}/);
    expect(frames).toMatch(/to\s*\{\s*opacity:\s*1;\s*transform:\s*scale\(1\);\s*\}/);
    expect(frames).not.toMatch(/rotate/);
    expect(css).toMatch(new RegExp(`animation:\\s*mark-pop\\s+\\d+ms\\s+${EASE_OUT.replace(/[()]/g, "\\$&")}\\s+both;`));
  });
});
