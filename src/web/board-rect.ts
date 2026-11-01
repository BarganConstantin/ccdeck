// The rectangle the board occupies inside the canvas cell.
//
// With the board header drawn (board-header.ts) the cell is the strip plus the
// board, and everything that frames the camera or measures a card against the
// pane means the board: a rect read off the cell would centre on, and clip
// against, the strip's 56px that hold no cards. The board is React Flow's
// wrapper, the strip's sibling, so it is found by that and not by subtracting
// the strip's height. Nothing is imported: the argument is all that is touched.

/** The cell's attribute while the strip is drawn (components/CanvasMain.tsx). */
export const BOARD_HEAD_ATTR = "data-board-head";

export function boardRect(cell: Element): DOMRect {
  // The optional call: a stand-in cell that can only be measured (the camera
  // and stage suites hand one) is a cell without a strip.
  const board = cell.hasAttribute?.(BOARD_HEAD_ATTR) ? cell.querySelector(":scope > .react-flow") : null;
  return (board ?? cell).getBoundingClientRect();
}
