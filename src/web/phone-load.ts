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

/** Whether the window is a phone's: the dock instead of the stripes, at the
 *  sheet's one narrow breakpoint. */
export const PHONE_QUERY = "(max-width: 640px)";

/** Whether this load is a phone's. Asked once, where the panels are restored;
 *  a browser with no window, no matchMedia, or one that throws is not a phone. */
export function loadsOnPhone(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return false; }
}
