// The mark the topbar draws beside the wordmark.
//
// #867 took a cyan-pink-green conic gradient with a 12px halo out of this slot
// and drew the favicon's flat ring in its place, one token, no glow. The brand
// kit (2026-10-01) retired the ring along with the favicon it copied: the slot
// now shows the kit's own small mark, from its file, and the kit sanctions the
// pattern around it for product chrome — the mark sized by height, the name in
// the UI font at weight 600 and a font size equal to that height, half the
// height between them. What #867 asked for still holds and is still pinned
// here — the sheet draws no gradient, glow or colour of its own for the mark —
// but the reason changed: the mark's gradients live only inside the kit's
// artwork, and redrawing the logo in CSS is the one thing the kit forbids.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARK_SMALL_ON_LIGHT_SRC, MARK_SMALL_SRC, PRODUCT } from "../brand";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("../App.tsx");
/** The topbar's readout group, the brand among it, which App.tsx mounts. */
const readouts = read("../components/TopbarReadouts.tsx");

const rule = (selector: string) =>
  new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]()"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
const px = (block: string, prop: string) => Number(new RegExp(`(?:^|;|\\s)${prop}:\\s*([\\d.]+)px`).exec(block)?.[1]);
const brand = rule(".topbar .brand");
const logo = rule(".topbar .brand .logo");

describe("the topbar mark is the kit's small mark", () => {
  it("is an image per theme beside the wordmark, decorative because the <h1> is the name", () => {
    // alt="" and not alt="ccdeck": the heading beside it already says the
    // name, and a screen reader would otherwise say it twice.
    expect(readouts).toMatch(
      /<div className="brand">\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<img className="logo logo-on-dark" src=\{MARK_SMALL_SRC\} width=\{19\} height=\{16\} alt="" \/>\s*<img className="logo logo-on-light" src=\{MARK_SMALL_ON_LIGHT_SRC\} width=\{19\} height=\{16\} alt="" \/>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)*<h1>\{PRODUCT\}<\/h1>/,
    );
    expect(PRODUCT).toBe("ccdeck");
    expect(app).toMatch(/<ReadoutGroup\b/);
  });

  it("serves the kit's small masters, never the big mark shrunk", () => {
    // Up to 32px the kit redraws the mark with opened gaps and pixel-aligned
    // strokes; its big master taken down to 16px closes up into a blob.
    expect(MARK_SMALL_SRC).toBe("/brand/ccdeck-mark-gradient-small-optical.svg");
    expect(MARK_SMALL_ON_LIGHT_SRC).toBe("/brand/ccdeck-mark-mono-dark-small-optical.svg");
    for (const src of [MARK_SMALL_SRC, MARK_SMALL_ON_LIGHT_SRC]) {
      expect(existsSync(fileURLToPath(new URL(`../public${src}`, import.meta.url))), `${src} does not ship`).toBe(true);
    }
  });

  it("keeps each kit image's own proportions, never a square forced on it", () => {
    // The small mark is 112 by 96, not square: sized 16 by 16 it is squashed.
    // The sheet sets the height alone; the attributes, which only hold the
    // space before the file loads, are the file's ratio at that height.
    expect(logo, "the sheet sets a width, which squashes the mark").toMatch(/width:\s*auto/);
    for (const src of [MARK_SMALL_SRC, MARK_SMALL_ON_LIGHT_SRC]) {
      const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(read(`../public${src}`));
      expect(box, `${src} has no viewBox`).toBeTruthy();
      const [w, h] = [Number(box![1]), Number(box![2])];
      const attrs = new RegExp(`src=\\{${src === MARK_SMALL_SRC ? "MARK_SMALL_SRC" : "MARK_SMALL_ON_LIGHT_SRC"}\\} width=\\{(\\d+)\\} height=\\{(\\d+)\\}`).exec(readouts);
      expect(attrs, `${src} is not drawn with a width and height`).toBeTruthy();
      expect(Number(attrs![1]), `${src}'s width attribute is not its ratio at that height`).toBe(Math.round((Number(attrs![2]) * w) / h));
    }
  });

  it("shows the gradient mark on the dark bar and the mono-dark one on the light bar", () => {
    // The gradient's aqua is under 3:1 on white, so the kit gives a light bar
    // its mono-dark twin. The theme is a stored choice (data-theme), not
    // prefers-color-scheme, so the sheet switches on the attribute.
    expect(rule(".topbar .brand .logo-on-light")).toMatch(/display:\s*none/);
    expect(rule(':root[data-theme="light"] .topbar .brand .logo-on-dark')).toMatch(/display:\s*none/);
    expect(rule(':root[data-theme="light"] .topbar .brand .logo-on-light')).toMatch(/display:\s*block/);
  });

  it("follows the kit's chrome pattern: height in fours, the name as tall, half of it between", () => {
    const height = px(logo, "height");
    expect(height % 4, "the mark's height is not a multiple of 4, so its strokes miss whole pixels").toBe(0);
    expect(logo, "the mark is not sized by height alone").toMatch(/width:\s*auto/);
    expect(px(brand, "font-size"), "the name is not as tall as the mark").toBe(height);
    expect(px(brand, "gap"), "the gap is not half the mark's height").toBe(height / 2);
    expect(brand).toMatch(/font-weight:\s*600/);
    expect(brand).toMatch(/letter-spacing:\s*0;/);
  });

  it("carries no gradient, glow, ring or colour of the sheet's own", () => {
    // Anything the sheet paints here is a second logo drawn over the first.
    expect(logo).not.toMatch(/border|background|mask|content:|gradient|box-shadow|filter/);
    expect(logo).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|var\(--/i);
    expect(css).not.toMatch(/\.brand \.logo[^{]*\{[^}]*(gradient|box-shadow|filter)/);
  });
});
