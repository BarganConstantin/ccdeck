// A hover card in a window shorter than itself stays inside the window.
//
// placeBeside caps a card the window cannot hold and lets it scroll. The three
// hover cards it places measured themselves with that cap still on, so on the
// next render the capped height fitted, the cap came off, and the card ran past
// the foot of the window until the render after put it back. The canvas card's
// hover card renders every second, so in a 150px window it was cut off for one
// second in two. Each now takes its cap off before it measures, the way the
// accounts menu (AnchoredPopover) already did.
//
// And the canvas card's hover card is a flex column, so while capped it
// squeezed its lines instead of scrolling: a line that hides its own overflow,
// like the session title, shrank to nothing. Its lines keep their height now,
// and the card scrolls.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cascade, el, selects, type El } from "./sheet-cascade";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("a hover card in a window shorter than itself", () => {
  for (const file of ["SessionPeek.tsx", "LanPeek.tsx", "OtherAccounts.tsx"]) {
    it(`measures itself uncapped before placing itself (${file})`, () => {
      const src = read(`../components/${file}`);
      const place = src.slice(src.indexOf("placeBeside(anchor.getBoundingClientRect()") - 400, src.indexOf("el.dataset.side = p.side;"));
      const clear = place.indexOf('el.style.maxHeight = "";');
      expect(clear).toBeGreaterThan(-1);
      expect(clear).toBeLessThan(place.indexOf("el.offsetHeight"));
    });
  }

  it("scrolls the canvas card's hover card rather than squeezing its lines", () => {
    const CARD = [el("html", [], { states: ["root"] }), el("body"), el("div", ["ap-peek", "node-peek"])];
    const got = (chain: El[], prop: string) => cascade(s => selects(s, chain), prop, 1440);
    for (const line of [["div", "node-peek-head"], ["div", "node-peek-kind"], ["p", "node-peek-title"], ["p", "node-peek-wait"], ["p", "node-peek-facts"], ["p", "node-peek-hint"]]) {
      expect(got([...CARD, el(line[0], [line[1]])], "flex"), line[1]).toBe("none");
    }
  });
});
