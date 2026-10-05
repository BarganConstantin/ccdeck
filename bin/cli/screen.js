// The boot's terminal: the palette, the glyphs, the cursor, the status rows,
// the wordmark and the spinner — everything bin/deck.js draws with.
//
// Lifted out of deck.js, where it was a block in the middle of the boot. The
// answers are the same ones asked of the same environment, only asked when this
// module loads instead of halfway down that file; nothing here has a side effect
// until the boot calls takeCursor, at the point where the block used to hide it.
import { pathToFileURL } from "node:url";
import { dieOfSignal } from "../../src/server/supervisor.mjs";
import {
  CURSOR_HIDE, CURSOR_SHOW, colorProfile, elapsedSuffix, fit, glyphs, labelColumn, link, motionOK,
  palette, spinnerFrames, statusLine, supportsHyperlinks, termColumns, unicodeOK, visibleWidth,
} from "../../src/server/term.mjs";
import { wordmark } from "../../src/server/wordmark.mjs";
import { PKG_VERSION } from "./package.js";

// ── the terminal we are printing into ─────────────────────────────────────────
// Asked once, degraded from there — see src/server/term.mjs, which is where all
// of this is decided and asserted. Below this point the deck writes no escape of
// its own: colour comes from `P`, glyphs from `G`, layout from statusLine. That
// is what makes NO_COLOR, a pipe, a CI log and a legacy Windows console one
// question rather than thirty separate ones nobody remembers to ask.
export const tty = Boolean(process.stdout.isTTY);
export const PROFILE = colorProfile({ isTTY: tty });
export const P = palette(PROFILE);
export const UNICODE = unicodeOK();
export const G = glyphs(UNICODE);
export const LINKS = supportsHyperlinks({ profile: PROFILE });
// The terminal's prefers-reduced-motion: nothing sleeps, spins or repaints in a
// pipe, under CI, or with NO_COLOR set.
export const MOTION = motionOK({ isTTY: tty, profile: PROFILE });
export const write = (s) => process.stdout.write(s);
// Read per line, never cached: a terminal can be resized while the deck runs,
// and the pulse below is still on screen hours later.
export const cols = () => termColumns(process.stdout);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const fileLink = (path) => link(path, pathToFileURL(path).href, LINKS);

// ── the cursor ────────────────────────────────────────────────────────────────
// Hidden for as long as anything of ours is moving — the reveal, the spinner,
// the pulse — and put back on every way out of this process: the ordinary exit,
// all three signals, and an uncaught throw, which reaches 'exit' after Node has
// printed it. Half of this is worse than none: a deck that dies with the cursor
// hidden leaves the user's shell with no cursor and nothing to do about it but
// `reset`.
let cursorHidden = false;
export const showCursor = () => {
  if (!cursorHidden) return;
  cursorHidden = false;
  try { write(CURSOR_SHOW); } catch { /* stdout is gone; nothing left to restore */ }
};
/**
 * Hide the cursor, if anything is going to move, and arm every way of putting
 * it back. Called once, by the boot, at the point it starts drawing.
 */
export function takeCursor() {
  if (MOTION) { cursorHidden = true; write(CURSOR_HIDE); }
  process.on("exit", showCursor);
  // SIGHUP's default action would end us before 'exit' could run. Handled to
  // put the cursor back and then die of it exactly as before — the supervisor
  // reads the signal, not an exit code — until the boot hands it to its
  // shutdown with onHangup.
  process.on("SIGHUP", () => { showCursor(); hangup(); });
}

let hangup = () => dieOfSignal("SIGHUP");
/** What a hangup does once the boot can do better than die of it: bin/deck.js
 *  routes it into the same shutdown SIGINT and SIGTERM run. */
export const onHangup = (fn) => { hangup = fn; };

// ── rows ──────────────────────────────────────────────────────────────────────
// The status column is computed from the longest label. It used to be counted
// into each string as trailing spaces, so any new row, or any label a character
// longer, silently broke the alignment of every other one.
const LABELS = [
  "workspace", "Claude hooks", "Codex sessions", "Codex hooks", "claude-swap", "accounts",
  "ccusage", "update", "name", "server ready", "log", "unknown option",
  "missing value",
];
const LABEL_W = labelColumn(LABELS);

export function row({ mark = " ", tone = P.ok, label = "", detail = "", detailTone = P.muted, keep = false }) {
  return statusLine({
    mark, label, detail, keep, labelWidth: LABEL_W, columns: cols(), ellipsis: G.ellipsis,
    paint: {
      mark: (s) => `${tone}${s}${P.reset}`,
      detail: (s) => `${detailTone}${s}${P.reset}`,
    },
  }) + "\n";
}

// ── the wordmark ──────────────────────────────────────────────────────────────

/**
 * Hold anything else that wants to speak until the art is finished.
 *
 * #742, found while watching a first run through a pty: the startup jobs run
 * UNDER the reveal on purpose, and one of them failing writes to console.error
 * the moment it fails — which put
 *
 *     ccdeck ccusage: install failed: npm install ccusage failed: spawn npm ENOENT
 *
 * between the second and third rows of the logo. A wordmark with a stack of
 * someone else's bad news through the middle of it is the first thing a new
 * user sees, and it reads as a crash rather than as a note.
 *
 * The window is the reveal and nothing else — about 180ms — so at worst a
 * message arrives a fifth of a second later than it would have, on the one
 * stretch of the boot where there is nowhere for it to go. Restored in a
 * `finally`, so a throw inside the reveal cannot leave the process mute.
 */
function holdConsole() {
  const held = [];
  const real = { warn: console.warn, error: console.error, log: console.log };
  for (const k of Object.keys(real)) console[k] = (...args) => { held.push([k, args]); };
  return () => {
    Object.assign(console, real);
    for (const [k, args] of held) real[k](...args);
  };
}

export async function printBanner() {
  const { lines } = wordmark({ columns: cols(), version: PKG_VERSION, profile: PROFILE, unicode: UNICODE, pal: P });
  const release = holdConsole();
  try {
    for (const line of lines) {
      write(line + "\n");
      // A reveal, not a wait. The once-per-session work is already running under
      // it (see startupWork), so the art costs the boot nothing and the deck is
      // ready about when the last row lands. What used to be here — 560ms of
      // spinner at "loading…" before a single art line — was dead time in a tool
      // whose documented entry point is `npx ccdeck`.
      if (MOTION && line) await sleep(45);
    }
  } finally {
    release();
  }
}

// ── a step, with a spinner only if it is slow enough to need one ──────────────
// The interval's first frame is 80ms away, so anything already settled when we
// get here paints nothing at all and the row below is the only trace of it.

export async function step(label, work) {
  if (!MOTION) return work;
  const frames = spinnerFrames(UNICODE);
  // Kept inside the terminal: a label that wraps is a label the \r below can
  // only half erase, and what is left of it stays under the row that follows.
  // Six columns for the indent and the spinner, four more so the elapsed
  // seconds have somewhere to go without pushing the label off the edge.
  const text = fit(label, cols() - 10, G.ellipsis);
  const started = Date.now();
  let i = 0;
  let widest = 0;
  const iv = setInterval(() => {
    const line = `  ${P.accent}${frames[i++ % frames.length]}${P.reset}  ${P.muted}${text}${elapsedSuffix(Date.now() - started)}${P.reset}`;
    widest = Math.max(widest, visibleWidth(line));
    write(`\r${line}`);
  }, 80);
  try {
    return await work;
  } finally {
    clearInterval(iv);
    // Cleared rather than overwritten: the row that follows is a different
    // length, and relying on it to be the longer of the two is how a spinner
    // leaves its own tail on screen. Measured rather than computed, because the
    // line grows when the elapsed seconds appear and again when they reach two
    // digits. Nothing to clear if it never painted.
    if (i) write("\r" + " ".repeat(widest) + "\r");
  }
}
