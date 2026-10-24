// What a phone opens by itself when the deck loads.
//
// Each panel's open flag is restored from the browser (use-right-panels.ts,
// use-left-column.ts), and a first run opens Accounts, Usage and the machine
// panel. Beside a canvas that is the layout the deck was drawn for. Under 641px
// nothing is beside anything: the left column is a drawer over the canvas
// (left-column.css), Usage takes the top of the screen and the machine panel
// its foot (machine-panel.css). A 390px load opened all three, the accounts
// drawer over Usage and both sheets over the canvas, with no part of the board
// in sight and nothing to say which of the three had been asked for.
//
// So a phone's load opens one sheet at most:
// - the left column waits: a drawer opens from the dock, the way it closes to
//   the canvas once a session is picked;
// - Usage, when it is wanted, and the machine panel waits behind it;
// - the machine panel, when it is the one sheet wanted.
//
// What is stored is not touched. A held panel is not the reader closing it, so
// nothing is written for it: a wider window opens what it always did, a first
// run is still a first run there, and the reader's own open or close of a held
// panel is written as ever.
//
// A desktop window can be too narrow for the two right panels side by side as
// well. On the default 1440x900 desktop window, with the accounts panel open,
// Usage and the machine panel beside each other left the board about 480px of
// canvas, and the fit drew every card as a dot. The two stay side by side
// (#847); on such a load the machine panel waits behind Usage, as it does on a
// phone, and opens from its rail button as ever.

/** Whether the window is a phone's: the dock instead of the stripes, at the
 *  sheet's one narrow breakpoint. */
export const PHONE_QUERY = "(max-width: 640px)";

/** The least canvas the board is left beside the right panels at load before
 *  the machine panel waits: a frame the fit can draw a session's cards in. */
export const BOARD_MIN_W = 600;

/** The ground the two right panels take side by side, from the window's right
 *  edge: the rail's 8px, Usage's 280, the 20 between them and the machine
 *  panel's 280 (machine-panel.css, usage-panel.css). And a stripe's width on
 *  each side of the window (tokens.css --edge-w). */
const RIGHT_PANELS_W = 8 + 280 + 20 + 280;
const EDGE_W = 40;

/**
 * Whether this load's window leaves the board too little canvas with both
 * right panels open beside it. `leftColumnW` is the left column's width on this
 * load, 0 when it opens nothing. Asked once, where the panels are restored; a
 * browser with no window is never crowded.
 */
export function rightPanelsCrowd(leftColumnW: number): boolean {
  if (typeof window === "undefined") return false;
  const w = window.innerWidth;
  if (!(w > 0)) return false;
  return w - 2 * EDGE_W - leftColumnW - RIGHT_PANELS_W < BOARD_MIN_W;
}

/** Whether this load is a phone's. Asked once, where the panels are restored;
 *  a browser with no window, no matchMedia, or one that throws is not a phone. */
export function loadsOnPhone(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return false; }
}
