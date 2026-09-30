// #1815: a focused Browser Watch finding showed a 2px sliver of its ring.
//
// A finding's card, `.bw-ep`, clips at `overflow: hidden` with no padding, and
// the row's disclosure fills it flush on the top, the left and the bottom. The
// global ring is 2px wide and drawn 1px outside a button, so the card cut away
// all of it but the right edge — the one that falls beside the row's ×, which
// is where the focus then seemed to be. The ring is pulled inside the row, the
// move #1706 made for the topbar chips and the one the focus rule lets a
// component make; its colour and width stay the global ones.
//
// Resolved through the cascade rather than read as one rule, so a later or
// heavier rule that put the ring back outside would fail this too.
import { describe, it, expect } from "vitest";
import { cascade, el, selects, type El } from "./sheet-cascade";

const FOCUSED = { states: ["focus-visible"] };

/** The dialog down to one finding's card, closed and open. */
const CARD = [
  el("html", [], { states: ["root"] }), el("body"),
  el("div", ["modal-backdrop"]), el("div", ["modal", "bw-modal"]), el("div", ["modal-body", "bw-body"]),
  el("section", ["bw-findings"]), el("div", ["bw-eps"]), el("div", ["bw-day"]),
];
const ROWS: Record<string, El[]> = {
  "a closed finding": [...CARD, el("div", ["bw-ep"]), el("div", ["bw-ep-row"]), el("button", ["bw-ep-head"], FOCUSED)],
  "an open finding": [...CARD, el("div", ["bw-ep", "open"]), el("div", ["bw-ep-row"]), el("button", ["bw-ep-head"], FOCUSED)],
};

const px = (v: string | null) => {
  const m = /^(-?[\d.]+)px$/.exec(v ?? "");
  if (!m) throw new Error(`unread length: ${v}`);
  return +m[1];
};

/** The focused ring the cascade gives `chain` at `width`. */
function ring(chain: El[], width: number) {
  const outline = cascade(s => selects(s, chain), "outline", width);
  const longhand = cascade(s => selects(s, chain), "outline-width", width);
  const w = longhand ?? /(-?[\d.]+px)/.exec(outline ?? "")?.[1] ?? null;
  return { width: px(w), offset: px(cascade(s => selects(s, chain), "outline-offset", width)) };
}

describe("a focused finding's row draws its whole ring (#1815)", () => {
  for (const width of [1280, 400]) {
    for (const [name, chain] of Object.entries(ROWS)) {
      it(`${name} at ${width}px`, () => {
        const r = ring(chain, width);
        // The global ring's width, unchanged — only where it is drawn moves.
        expect(r.width).toBe(2);
        // Inside the row by at least its width, where the card cannot clip it.
        expect(r.offset, `outline-offset ${r.offset}px`).toBeLessThanOrEqual(-r.width);
      });
    }
  }

  it("is needed because the card clips, flush against the row", () => {
    const card = ROWS["a closed finding"].slice(0, -2);
    expect(cascade(s => selects(s, card), "overflow", 1280)).toBe("hidden");
    expect(cascade(s => selects(s, card), "padding", 1280) ?? "0").toMatch(/^0(px)?$/);
  });
});
