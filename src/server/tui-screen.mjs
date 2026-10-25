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
// Except on Windows, where every console is conhost's: it froze on the first
// frame held between the marks and drew the ones after it seconds later or
// only once the view was left (Windows 11 24H2, under sshd). Conhost draws the
// screen from its own copy of it anyway, so there no frame is held.
//
// ONE RUN OF TEXT MAY FLOW: a sign-in link is hundreds of characters, and cut
// into rows by us it is a link no terminal can click and no mouse can copy
// whole. So a frame can carry one `run`, written edge to edge with wrapping on,
// which the terminal wraps itself and knows to be one line. The rows it wrapped
// into stay marked as wrapped after it has gone, and a row still marked is
// joined to the one above it for selecting and for finding links. Erasing such
// a row from its first column takes the mark off in xterm.js, but not over
// conhost, which passes on only what changed; clearing the screen takes it off
// everywhere. So a frame that leaves a wrapped row behind is written whole.
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

/** Whether a frame is held between the synchronized-output marks here. */
export const framesHeld = (platform = process.platform) => platform !== "win32";

/**
 * A screen over `write`. `enter` takes the terminal, `paint(lines, run)` shows
 * a frame, `invalidate` forgets what is on screen so the next frame is written
 * whole (a resize, Ctrl+L), and `leave` puts the terminal back. `leave` is
 * safe to call twice and before `enter`, since every way out calls it.
 * `held` says whether a frame goes between the synchronized-output marks.
 *
 * `run` is `{ row, rows, text, full }`: `text` written from the start of `row`
 * with wrapping on, over the `rows` rows whose `lines` are its pieces, and
 * `full` when its last piece reaches the last column — the cursor waits there
 * to wrap, and clearing the row from it would take the last character.
 */
export function createScreen(write, { held = framesHeld() } = {}) {
  let shown = null;
  let shownRun = null;
  let wrapped = new Set();
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
    paint(lines, run = null) {
      if (!on) return;
      let out = "";
      const flows = new Set(run ? Array.from({ length: run.rows - 1 }, (_, k) => run.row + 1 + k) : []);
      if ([...wrapped].some(i => !flows.has(i))) shown = null;
      const whole = shown == null;
      if (whole) out += `${RESET}${HOME}${CLEAR}`;
      const inRun = (i) => run != null && i >= run.row && i < run.row + run.rows;
      for (let i = 0; i < lines.length; i++) {
        if (inRun(i) || (!whole && shown[i] === lines[i])) continue;
        // The reset before the clear, so the rest of the row is cleared in the
        // terminal's own background rather than in the last colour drawn.
        out += `\x1b[${i + 1};1H${lines[i]}${RESET}\x1b[K`;
      }
      if (run) {
        let same = !whole && shownRun === run.text;
        for (let i = run.row; same && i < run.row + run.rows; i++) same = shown[i] === lines[i];
        if (!same) out += `\x1b[${run.row + 1};1H${RESET}${WRAP_ON}${run.text}${RESET}${WRAP_OFF}${run.full ? "" : "\x1b[K"}`;
      }
      // A frame shorter than the last one: the rows it no longer has.
      if (!whole) for (let i = lines.length; i < shown.length; i++) out += `\x1b[${i + 1};1H\x1b[K`;
      shown = lines.slice();
      shownRun = run?.text ?? null;
      wrapped = flows;
      if (out) send(held ? `${SYNC_ON}${out}${SYNC_OFF}` : out);
    },
    invalidate() { shown = null; shownRun = null; },
    leave() {
      if (!on) return;
      on = false;
      shown = null;
      shownRun = null;
      wrapped = new Set();
      send(`${held ? SYNC_OFF : ""}${RESET}${WRAP_ON}${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
    },
  };
}
