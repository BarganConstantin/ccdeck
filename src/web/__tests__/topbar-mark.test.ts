// The mark the topbar draws beside the wordmark.
//
// #867 took a cyan-pink-green conic gradient with a 12px halo out of this slot
// and drew the favicon's flat ring in its place, one token, no glow. The brand
// kit (2026-10-01) retired the ring along with the favicon it copied: the slot
// now shows the kit's own small mark, from its file, and the sheet only sizes
// it. What #867 asked for still holds and is still pinned here — the sheet
// draws no gradient, glow or colour of its own for the mark — but the reason
// changed: the purple-to-cyan is allowed exactly once, inside the kit's
// artwork, and redrawing the logo in CSS is the one thing the kit forbids.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARK_SMALL_SRC, PRODUCT } from "../brand";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("../App.tsx");
/** The topbar's readout group, the brand among it, which App.tsx mounts. */
const readouts = read("../components/TopbarReadouts.tsx");

const logo = /\.topbar \.brand \.logo\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

describe("the topbar mark is the kit's small mark", () => {
  it("is an image beside the wordmark, decorative because the <h1> is the name", () => {
    // alt="" and not alt="ccdeck": the heading two pixels to the right already
    // says the name, and a screen reader would otherwise say it twice.
    expect(readouts).toMatch(
      /<div className="brand">\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<img className="logo" src=\{MARK_SMALL_SRC\} width=\{16\} height=\{16\} alt="" \/>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)*<h1>\{PRODUCT\}<\/h1>/,
    );
    expect(PRODUCT).toBe("ccdeck");
    expect(app).toMatch(/<ReadoutGroup\b/);
  });

  it("serves the kit's 16–24px master, never the big mark shrunk", () => {
    // The kit redraws the mark for small sizes with open counters and heavier
    // strokes; its big master taken down to 16px turns into a blob.
    expect(MARK_SMALL_SRC).toBe("/brand/ccdeck-mark-gradient-small-optical.svg");
    expect(existsSync(fileURLToPath(new URL(`../public${MARK_SMALL_SRC}`, import.meta.url))), `${MARK_SMALL_SRC} does not ship`).toBe(true);
  });

  it("is sized by the sheet at the bottom of the kit's band, and drawn by nothing else", () => {
    expect(logo).toMatch(/width:\s*16px/);
    expect(logo).toMatch(/height:\s*16px/);
    // No ring, no tile, no fill: anything the sheet paints here is a second
    // logo drawn over the first.
    expect(logo).not.toMatch(/border|background|mask|content:/);
  });

  it("carries no gradient, glow or colour of the sheet's own", () => {
    expect(logo).not.toMatch(/gradient/);
    expect(logo).not.toMatch(/box-shadow|filter/);
    expect(logo).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|var\(--/i);
    expect(css).not.toMatch(/\.brand \.logo[^{]*\{[^}]*(gradient|box-shadow|filter)/);
  });
});
