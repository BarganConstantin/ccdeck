// Where a popover hung off a control goes.
//
// The deck's first popover, the sound menu, never had to ask. Its button sits
// in the topbar, there is always room under it, and `top: calc(100% + 8px)` in
// the sheet was the whole of its placement. The accounts panel's `⋯` is
// different on both counts: it sits on a row that can be anywhere in a column
// that scrolls — the last account is a menu's height from the bottom of the
// window as often as not — and that column clips its own overflow, so a
// popover drawn inside it would be cut off by the very panel it belongs to.
// AnchoredPopover draws it at the top of the document instead and places it
// against the window, which is a decision about a handful of numbers. It lives
// out here for the reason modal-dismiss.ts and tablist-keys.ts do: the suite is
// plain node with no DOM, and a rule that only exists inside a component is one
// nothing can check.
//
// The rules, in the order they bind:
//
//   END-ALIGNED. The popover's right edge sits under the anchor's right edge,
//   so it reads as coming out of the control rather than as something placed
//   beside it — and a trigger near the right end of a row opens into the row
//   it belongs to instead of out over the canvas.
//
//   BELOW, unless it does not fit there and there is more room above. A
//   popover that flips for no reason moves the thing the reader just aimed at;
//   one that never flips runs off the bottom of the window.
//
//   NEVER PAST THE WINDOW. Clamped with a margin on every side, and scrolling
//   inside itself only when neither side can hold it whole — a zoomed-in
//   window, a short one — which is the one case where showing part of it is
//   better than showing it in the wrong place.

/** The four edges of a box, in window coordinates — a DOMRect is one. */
export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  /** Which side of the anchor it opened on. The entrance moves away from the
   *  anchor, so the sheet needs to know which way that is. */
  side: "below" | "above";
  /** Set only when neither side holds the whole popover, and it scrolls. */
  maxHeight: number | null;
}

/** Air between the popover and the control it hangs off: close enough to read
 *  as attached, far enough that the control's own focus ring is not covered. */
export const POPOVER_GAP = 4;
/** Air between the popover and the edge of the window. */
export const POPOVER_MARGIN = 8;

/** Where a card that answers a HOVER goes: beside the control, not under it.
 *
 *  A menu belongs under the button that opened it, because the reader pressed
 *  that button and is now looking at it. A peek is the other way round — nobody
 *  asked for it, the pointer is resting on a row in a column, and a surface
 *  that drops under that row covers the rows after it: the thing the pointer is
 *  about to move to. Beside the column there is nothing to cover.
 *
 *  RIGHT, unless the anchor's own column is against the right of the window and
 *  the left has more room — a sidebar on either side gets the same card, opening
 *  away from its own edge. Top-aligned with the anchor rather than centred on
 *  it, so the first line of the card and the row it belongs to read on one line. */
export interface BesidePlacement {
  top: number;
  left: number;
  /** Which way it opened, for the sheet's entrance and for a test to read. */
  side: "right" | "left";
  /** Set only when the window is too short to hold the card, and it scrolls. */
  maxHeight: number | null;
}

export function placeBeside(anchor: Edges, size: Size, viewport: Size): BesidePlacement {
  const right = viewport.width - POPOVER_MARGIN - (anchor.right + POPOVER_GAP);
  const left = anchor.left - POPOVER_GAP - POPOVER_MARGIN;
  const side = size.width <= right || right >= left ? "right" : "left";
  const x = side === "right" ? anchor.right + POPOVER_GAP : anchor.left - POPOVER_GAP - size.width;
  const room = viewport.height - POPOVER_MARGIN * 2;
  const fits = size.height <= room;
  const height = fits ? size.height : Math.max(0, room);
  // Level with the row, then pulled back inside the window — a row near the
  // foot of a tall column opens a card that ends at the window's margin.
  const top = Math.max(POPOVER_MARGIN, Math.min(anchor.top, viewport.height - POPOVER_MARGIN - height));
  return { top, left: Math.max(POPOVER_MARGIN, x), side, maxHeight: fits ? null : height };
}

export function placePopover(anchor: Edges, size: Size, viewport: Size): Placement {
  const below = viewport.height - POPOVER_MARGIN - (anchor.bottom + POPOVER_GAP);
  const above = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
  const side = size.height <= below || below >= above ? "below" : "above";
  const room = side === "below" ? below : above;
  const fits = size.height <= room;
  const height = fits ? size.height : Math.max(0, room);
  const top = side === "below" ? anchor.bottom + POPOVER_GAP : anchor.top - POPOVER_GAP - height;
  // Right edge under the anchor's, then pulled back inside the window. The left
  // clamp is applied last so that a window narrower than the popover keeps its
  // start edge — the words — on screen and lets the end run off instead.
  const left = Math.max(POPOVER_MARGIN, Math.min(anchor.right - size.width, viewport.width - POPOVER_MARGIN - size.width));
  return { top: Math.max(POPOVER_MARGIN, top), left, side, maxHeight: fits ? null : height };
}
