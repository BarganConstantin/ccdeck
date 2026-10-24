// The terminal `ccdeck tui` draws on: the alternate screen, painted a row at a
// time, and handed back exactly as it was found.
//
// THE ALTERNATE SCREEN, so the view never scrolls the shell's own history away
// and leaves nothing behind when it closes — what `less`, `top` and every
// editor do. Wrapping is turned off for as long as the view is up: a row one
// column too wide would otherwise push every row under it down by one, and the
// view would go on painting rows that are no longer where it thinks they are.
//
// ONLY THE ROWS THAT CHANGED are written, each addressed by its row and cleared
// to its end, so a refresh every second over a slow SSH link sends a few bytes
// rather than the screen. A frame is written between the synchronized-output
// marks (DEC mode 2026): a terminal that knows them shows it whole, and one
// that does not ignores them, which is what an unknown private mode is for.
//
// Pure in the sense that matters for a test: everything goes through `write`,
// and nothing reads the terminal.
import { CURSOR_HIDE, CURSOR_SHOW } from "./term.mjs";

export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const WRAP_OFF = "\x1b[?7l";
export const WRAP_ON = "\x1b[?7h";
export const SYNC_ON = "\x1b[?2026h";
export const SYNC_OFF = "\x1b[?2026l";
const RESET = "\x1b[0m";
const CLEAR = "\x1b[2J";
const HOME = "\x1b[H";

/**
 * A screen over `write`. `enter` takes the terminal, `paint(lines)` shows a
 * frame, `invalidate` forgets what is on screen so the next frame is written
 * whole (a resize, Ctrl+L), and `leave` puts the terminal back. `leave` is
 * safe to call twice and before `enter`, since every way out calls it.
 */
export function createScreen(write) {
  let shown = null;
  let on = false;
  const send = (s) => {
    try { write(s); } catch { /* the terminal went away; nothing left to draw on */ }
  };
  return {
    get active() { return on; },
    enter() {
      on = true;
      shown = null;
      send(`${ALT_SCREEN_ON}${CURSOR_HIDE}${WRAP_OFF}${HOME}${CLEAR}`);
    },
    paint(lines) {
      if (!on) return;
      let out = "";
      const whole = shown == null;
      if (whole) out += `${RESET}${HOME}${CLEAR}`;
      for (let i = 0; i < lines.length; i++) {
        if (!whole && shown[i] === lines[i]) continue;
        // The reset before the clear, so the rest of the row is cleared in the
        // terminal's own background rather than in the last colour drawn.
        out += `\x1b[${i + 1};1H${lines[i]}${RESET}\x1b[K`;
      }
      // A frame shorter than the last one: the rows it no longer has.
      if (!whole) for (let i = lines.length; i < shown.length; i++) out += `\x1b[${i + 1};1H\x1b[K`;
      shown = lines.slice();
      if (out) send(`${SYNC_ON}${out}${SYNC_OFF}`);
    },
    invalidate() { shown = null; },
    leave() {
      if (!on) return;
      on = false;
      shown = null;
      send(`${SYNC_OFF}${RESET}${WRAP_ON}${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
    },
  };
}
