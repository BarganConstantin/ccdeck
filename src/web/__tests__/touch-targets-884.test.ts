// #884: most controls were under the 44px touch size and eighteen were under
// 24px. Measured on the live deck once the earlier fixes had landed, what was
// still under 24 in the panel: the manage pills (the `switch` verb every
// inactive account carries) at 51x23, the auto-switch threshold select at
// 53x23, the fix pill at 84x20, and every switch at 30x18. (The on-canvas
// session labels are 18px tall too, but they scale with the canvas zoom and are
// measured by it, not by a stylesheet floor.)
//
// Controls that carry their own height take a 24px minimum. The switch and the
// fix pill keep their size and get a transparent 24px target drawn around them,
// the sheet's own idiom from .ap-failure-x. Under a coarse pointer the drawn
// targets grow to 32px and the floors with them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the `@media` block opened by `open`, and the sheet without any
 *  `@media` block in it. */
function mediaBody(open: string): string {
  const at = css.indexOf(open);
  expect(at, open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = at + open.length - 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at + open.length, i);
  }
  throw new Error("unbalanced");
}
function withoutMedia(src: string): string {
  let out = "", i = 0;
  while (i < src.length) {
    const at = src.indexOf("@media", i);
    if (at < 0) { out += src.slice(i); break; }
    out += src.slice(i, at);
    let depth = 0, j = src.indexOf("{", at);
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}
const rulesOf = (src: string) => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  sels: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean),
  body: m[2],
}));
const top = rulesOf(withoutMedia(css));
const coarse = rulesOf(mediaBody("@media (pointer: coarse) {"));
const bodyIn = (rules: typeof top, sel: string) => rules.filter(r => r.sels.includes(sel)).map(r => r.body).join("\n");

const DRAWN = [".switch::after", ".ap-fix::after", ".ap-rotate::after", ".ap-lanes-more::after", "button.ap-err::after"];

describe("the 24px floor on the panel's smallest controls (#884)", () => {
  it("gives the two controls that carry their own height a 24px minimum", () => {
    expect(bodyIn(top, ".ap-manage-btn")).toMatch(/min-height:\s*24px/);
    expect(bodyIn(top, ".ap-field select")).toMatch(/min-height:\s*24px/);
  });

  it("draws a 24px target around the switch and the fix pill without resizing either", () => {
    for (const sel of [".switch::after", ".ap-fix::after"]) {
      const b = bodyIn(top, sel);
      expect(b, sel).toMatch(/content:\s*""/);
      expect(b, sel).toMatch(/position:\s*absolute/);
      expect(b, sel).toMatch(/width:\s*max\(100%, 24px\)/);
      expect(b, sel).toMatch(/height:\s*24px/);
      expect(b, sel).toMatch(/transform:\s*translate\(-50%, -50%\)/);
    }
    // The pseudo-element anchors to its own control.
    expect(bodyIn(top, ".ap-fix")).toMatch(/position:\s*relative/);
    expect(bodyIn(top, ".switch")).toMatch(/position:\s*relative/);
    // And the track itself is the size it was argued at.
    expect(bodyIn(top, ".switch")).toMatch(/width:\s*30px/);
    expect(bodyIn(top, ".switch")).toMatch(/height:\s*18px/);
  });
});

describe("a coarse pointer gets more (#884)", () => {
  it("grows every target the panel draws to 32px", () => {
    for (const sel of DRAWN) {
      const b = bodyIn(coarse, sel);
      expect(b, sel).toMatch(/width:\s*max\(100%, 32px\)/);
      expect(b, sel).toMatch(/height:\s*32px/);
    }
    // The dismiss ×'s target is a centred square, so it grows as one.
    expect(bodyIn(coarse, ".ap-failure-x::after")).toMatch(/width:\s*32px;\s*height:\s*32px;\s*margin:\s*-16px 0 0 -16px/);
  });

  it("takes 32px as the floor of the two controls that carry their own height", () => {
    expect(bodyIn(coarse, ".ap-manage-btn")).toMatch(/min-height:\s*32px/);
    expect(bodyIn(coarse, ".ap-field select")).toMatch(/min-height:\s*32px/);
  });

  it("moves the LAN dialog's switches apart so their grown targets meet and do not overlap", () => {
    const gap = Number(/gap:\s*(\d+)px/.exec(bodyIn(coarse, ".lan-switches"))?.[1]);
    expect(18 + gap).toBeGreaterThanOrEqual(32);
  });

  it("covers every 24px target drawn in the accounts panel's family", () => {
    const drawn = top
      .filter(r => /height:\s*24px/.test(r.body) && /position:\s*absolute/.test(r.body) && /content:\s*""/.test(r.body))
      .flatMap(r => r.sels)
      .filter(s => /^(\.ap-|button\.ap-|\.switch)/.test(s));
    expect(drawn.length).toBeGreaterThanOrEqual(DRAWN.length);
    for (const sel of drawn) expect(DRAWN.concat(".ap-failure-x::after"), sel).toContain(sel);
  });
});
