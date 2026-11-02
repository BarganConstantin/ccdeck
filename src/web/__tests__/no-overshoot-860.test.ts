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
import { sheetText } from "./sheet-source";

const css = sheetText()
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

  it("runs every bubble rise on the sheet's ease-out", () => {
    // V4's motion spec replaced the spawn with a rise: opacity and 4px of y.
    const rises = [...css.matchAll(/burst-rise\s+(?:var\(--dur-base\)\s+)?(cubic-bezier\([^)]*\)|var\(--ease\)|[\w-]+)/g)];
    expect(rises.length).toBeGreaterThanOrEqual(2);
    // Spelled var(--ease), the token that IS EASE_OUT (v4-tokens.test.ts holds them equal).
    for (const m of rises) expect(m[1]).toBe("var(--ease)");
  });

  it("never scales a bubble on the way in", () => {
    const frames = keyframes("burst-rise");
    expect(frames).not.toMatch(/scale/);
    expect(frames).toMatch(/translateY\(4px\)/);
    expect(frames).not.toMatch(/animation-timing-function/);
  });

  it("brings the ✓ in with a plain fade: no scale from 0.6, no spin", () => {
    const frames = keyframes("burst-fade-in");
    expect(frames).toMatch(/from\s*\{\s*opacity:\s*0;\s*\}/);
    expect(frames).not.toMatch(/rotate|scale/);
    expect(css).toMatch(new RegExp(`animation:\\s*burst-fade-in\\s+var\\(--dur-base\\)\\s+var\\(--ease\\)\\s+backwards;`));
  });
});
