// The accounts panel's ⋯ opens a popover placed against the window rather than
// inside the column that clips it (popover-place.ts). These are the rules that
// file states, each measured at the edge where it binds.
import { describe, it, expect } from "vitest";
import { placePopover, POPOVER_GAP, POPOVER_MARGIN } from "../popover-place";

const VIEW = { width: 1280, height: 800 };
/** The menu's own box: 208 wide, four 30px rows, a rule and the padding. */
const SIZE = { width: 208, height: 140 };
/** A 24px ⋯ whose right edge is at `x` and top at `y`. */
const anchor = (x: number, y: number) => ({ left: x - 24, right: x, top: y, bottom: y + 24 });

describe("where the popover opens (popover-place.ts)", () => {
  it("opens below the anchor, its right edge under the anchor's", () => {
    const p = placePopover(anchor(220, 100), SIZE, VIEW);
    expect(p.side).toBe("below");
    expect(p.top).toBe(124 + POPOVER_GAP);
    expect(p.left + SIZE.width).toBe(220);
    expect(p.maxHeight).toBeNull();
  });

  it("stays below when below holds it exactly — a flip moves what was just aimed at", () => {
    // 800 - 8 - (648 + 4) = 140: not a pixel to spare, and still no reason to move.
    const p = placePopover(anchor(220, 624), SIZE, VIEW);
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBeNull();
  });

  it("flips above near the foot of the window, and sits the gap above the anchor", () => {
    const p = placePopover(anchor(220, 700), SIZE, VIEW);
    expect(p.side).toBe("above");
    expect(p.top + SIZE.height).toBe(700 - POPOVER_GAP);
    expect(p.maxHeight).toBeNull();
  });

  it("never starts past the left margin, however close the anchor is to it", () => {
    expect(placePopover(anchor(120, 100), SIZE, VIEW).left).toBe(POPOVER_MARGIN);
  });

  it("never runs past the right edge of the window", () => {
    const p = placePopover(anchor(1279, 100), SIZE, VIEW);
    expect(p.left + SIZE.width).toBe(VIEW.width - POPOVER_MARGIN);
  });

  it("keeps its start edge on screen in a window narrower than itself", () => {
    // The words are at the start. Losing the end of a row is recoverable;
    // losing the first letters of every item is not.
    expect(placePopover(anchor(150, 100), SIZE, { width: 200, height: 800 }).left).toBe(POPOVER_MARGIN);
  });

  it("scrolls inside itself only when neither side can hold it, on the roomier side", () => {
    // 180px tall: 84px below the anchor, 48px above it.
    const p = placePopover(anchor(220, 60), SIZE, { width: 1280, height: 180 });
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(84);
    expect(p.top + p.maxHeight!).toBe(180 - POPOVER_MARGIN);
  });

  it("squeezed above, it still never starts above the top margin", () => {
    const p = placePopover(anchor(220, 120), SIZE, { width: 1280, height: 170 });
    expect(p.side).toBe("above");
    expect(p.top).toBe(POPOVER_MARGIN);
    expect(p.top + p.maxHeight!).toBe(120 - POPOVER_GAP);
  });
});
