// #1791: a hover peek with no room on either side ran off the right of its area.
//
// placeBeside opens a card beside its anchor, on the roomier side when neither
// holds it whole. It pulled `top` back inside the area and `left` back off the
// left margin, and never looked at the right edge: in a 640px area with a tile
// at x 270-370, the canvas card's 288px peek opened at 374 and ended at 662,
// 22px past the edge. The peeks are `position: fixed`, so the part past the
// edge is not somewhere a scroll can reach. The card peek, the Local network
// peek and the Other accounts peek are all placed by this one function.
import { describe, it, expect } from "vitest";
import { placeBeside, POPOVER_GAP, POPOVER_MARGIN } from "../popover-place";

const tile = { left: 270, right: 370, top: 100, bottom: 160 };
const AREA = { width: 640, height: 400 };

describe("a peek that fits on neither side of its anchor (#1791)", () => {
  // The three peeks' own widths — the card, Other accounts, Local network —
  // off a row of the 288px Accounts panel in a 400px window: 100px free to the
  // right of it and none to the left, so each opens right and used to end at
  // 292 plus its own width.
  const row = { left: 12, right: 288, top: 300, bottom: 342 };
  const PHONE = { width: 400, height: 800 };
  for (const width of [288, 244, 208]) {
    it(`keeps a ${width}px card inside the window's right margin`, () => {
      const p = placeBeside(row, { width, height: 200 }, PHONE);
      expect(p.side).toBe("right");
      expect(p.left + width).toBeLessThanOrEqual(PHONE.width - POPOVER_MARGIN);
      expect(p.left).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    });
  }

  it("pulls the canvas card back over the tile instead of 22px past the edge", () => {
    const p = placeBeside(tile, { width: 288, height: 200 }, AREA);
    expect(p.side).toBe("right");
    expect(p.left + 288).toBeLessThanOrEqual(AREA.width - POPOVER_MARGIN);
    expect(p.left).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    // As far right as the margin lets it: over the tile, and no further.
    expect(p.left).toBe(AREA.width - POPOVER_MARGIN - 288);
  });

  it("keeps its start edge on screen in an area narrower than the card", () => {
    // Left clamp last, the rule placePopover already states: the words stay
    // and the end is what runs off.
    const p = placeBeside({ left: 40, right: 140, top: 100, bottom: 160 }, { width: 288, height: 200 }, { width: 240, height: 400 });
    expect(p.left).toBe(POPOVER_MARGIN);
  });

  it("does not move a card that fits beside its anchor", () => {
    const p = placeBeside(tile, { width: 208, height: 200 }, { width: 1280, height: 800 });
    expect(p.left).toBe(tile.right + POPOVER_GAP);
  });
});
