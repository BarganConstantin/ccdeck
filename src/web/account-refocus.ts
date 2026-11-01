// Where keyboard focus goes when a new roster takes the focused control away
// (#1497).
//
// The panel draws the live account in one list and the others in the list
// behind the fold. A switch the panel did not make — auto-switch, or `cswap
// switch` in a terminal — moves an account from one list to the other on the
// next poll, and React draws its row again in the new list rather than moving
// it: the ⋯ the reader was on is removed, focus falls to <body>, and an
// identical ⋯ appears a few rows away. The presses the panel makes itself hand
// focus on through rescueSelectors; a poll is not a press, so it gets a chain
// of its own, most local first.
import { rescueSelectors } from "./panel-press";

/** The fold's own row: where an account that went behind a shut fold went. */
export const FOLD_ROW = "#ap-rest-entry";

/**
 * The controls to try, in order, for one that was focused under `id` and is
 * gone after a roster landed: the same control drawn again wherever the row
 * moved to, then the fold row, then the panel's reload — the one control that
 * belongs to no row and is always on screen.
 */
export function refocusSelectors(id: string): string[] {
  return [`#${cssId(id)}`, FOLD_ROW, ...rescueSelectors(null)];
}

/** An id as a selector can say it. React's useId() makes ids like `:r1:`, which
 *  the panel's own fields carry (Auto-switch's threshold and order), and
 *  `#:r1:` is not a selector: querySelector throws a SyntaxError, in a layout
 *  effect, while a roster is being drawn. Ids made of letters, digits, `-` and
 *  `_` come out unchanged. */
function cssId(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/[^\w-]/g, ch => `\\${ch}`);
}
