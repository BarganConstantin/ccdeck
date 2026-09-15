// #868: the canvas painted two radial glows, cyan from the top and fuchsia
// from the bottom-left, out of two tokens that existed for nothing else. They
// carried no state, and they sat behind the one surface where colour is meant
// to mean something: session hues, waiting, failure. The canvas is flat --bg
// now, and the two tokens are gone from both themes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const raw = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the canvas is flat (#868)", () => {
  it("paints its ground in --bg and nothing else", () => {
    // More than one rule is spelled `.canvas-wrap` (the layout grid places it
    // too), so every one of them is read.
    const wraps = [...css.matchAll(/(?:^|\n)\.canvas-wrap\s*\{([^}]*)\}/g)].map(m => m[1]);
    const grounds = wraps.filter(b => /background/.test(b));
    expect(grounds).toHaveLength(1);
    expect(grounds[0]).toMatch(/background:\s*var\(--bg\);/);
    for (const b of wraps) expect(b).not.toMatch(/gradient/);
  });

  it("gives no theme or state a way to put a glow back behind it", () => {
    expect(css).not.toMatch(/\.canvas-wrap[^{]*\{[^}]*radial-gradient/);
  });

  it("drops the two tokens that existed only to draw the glows", () => {
    expect(css).not.toMatch(/--bg-grid-[12]/);
  });
});
