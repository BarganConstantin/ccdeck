// #1792: the version chip's focus ring showed as two brackets.
//
// #1706 found the defect on the blocked-session chip: `.topbar .readout` clips
// what overflows it and is exactly as tall as the chips in it, so the global
// ring — 2px wide, 1px outside a button — lost its top and bottom. The fix
// pulled the ring inside the chip for the two chips it named. The version chip
// beside the wordmark sits in the same readout at the same 24px, in all three
// of its forms, and kept the ring outside: 3px clipped top and bottom.
//
// So this does not list selectors. It resolves, for every focusable the readout
// renders, the outline the cascade actually gives it while focused, and holds
// each one to a ring the readout cannot clip.
import { describe, it, expect } from "vitest";
import { cascade, el, selects, type El } from "./sheet-cascade";

const FOCUSED = { states: ["focus-visible"] };

/** Above the chips: the document, the grid the bar is a row of, the bar. */
const ROOT = [el("html", [], { states: ["root"] }), el("body"), el("div", ["app"]), el("header", ["topbar"]), el("div", ["readout"])];

/** Every focusable TopbarReadouts draws inside `.readout`, in every form. */
const FOCUSABLES: Record<string, El[]> = {
  "the version chip": [...ROOT, el("div", ["brand"]), el("button", ["v"], FOCUSED)],
  "the version chip while it checks": [...ROOT, el("div", ["brand"]), el("button", ["v", "checking"], FOCUSED)],
  "the stale version chip": [...ROOT, el("div", ["brand"]), el("button", ["v", "stale"], FOCUSED)],
  "the update-ready chip": [...ROOT, el("div", ["brand"]), el("button", ["v", "ready"], FOCUSED)],
  "the blocked-session chip": [...ROOT, el("button", ["waiting-stat"], FOCUSED)],
  "a provider's incident chip": [...ROOT, el("a", ["provider-incident"], { ...FOCUSED, attrs: { "data-state": "minor" } })],
  "a stale incident chip": [...ROOT, el("a", ["provider-incident", "provider-incident-stale"], { ...FOCUSED, attrs: { "data-state": "major_outage" } })],
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

describe("every focusable in the topbar's readout draws its whole ring (#1792)", () => {
  // Desktop, and a phone: below 640px the plain chip leaves the bar but the
  // stale and ready ones, and the blocked count, stay.
  for (const width of [1280, 400]) {
    for (const [name, chain] of Object.entries(FOCUSABLES)) {
      it(`${name} at ${width}px`, () => {
        const r = ring(chain, width);
        // The global ring's width, unchanged — only where it is drawn moves.
        expect(r.width).toBe(2);
        // Inside the chip's own edge by at least its width, where the
        // readout's overflow clip cannot reach it.
        expect(r.offset, `outline-offset ${r.offset}px`).toBeLessThanOrEqual(-r.width);
      });
    }
  }

  it("resolves the chips #1706 already fixed, so it would have caught them", () => {
    expect(ring(FOCUSABLES["the blocked-session chip"], 1280).offset).toBe(-3);
    expect(ring(FOCUSABLES["a provider's incident chip"], 1280).offset).toBe(-3);
  });

  it("is reading the global ring, not a guess: an ordinary button's sits outside it", () => {
    expect(ring([el("html", [], { states: ["root"] }), el("body"), el("button", [], FOCUSED)], 1280)).toEqual({ width: 2, offset: 1 });
  });
});
