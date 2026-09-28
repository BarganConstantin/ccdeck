// The pulse line: the last line of the boot's screen, and the only one that can
// still move once the report is done.
//
// Lifted out of bin/deck.js, which starts it at the same point in the boot.
//
// The whole line is rewritten each beat rather than just the dot: anything else
// on this deck that has something to say writes a newline first, and after that
// the line under the cursor is no longer the one we drew — a partial repaint
// would leave the message behind and pulse into empty space. Sized to the real
// terminal, because at 40 columns the old fixed 61-character line wrapped, and
// from then on \r only ever reached its second row.
//
// AND IT STOPS MOVING (#742). The dot alternated green and grey every 800ms for
// as long as the deck ran, and a blinking indicator beside a status line is the
// vocabulary of "working on it" — so a boot that finished in a second read as
// one that never finished, which is what people reported. Motion is now spent
// on the two states where something really is outstanding, and the frame is
// compared against what is already on screen so a deck at rest paints once and
// then leaves the terminal alone. See pulseMoves.
import { pulseDot, pulseText } from "../../src/server/term.mjs";
import { G, MOTION, P, UNICODE, cols, write } from "./screen.js";
import { busyLabel } from "./startup.js";

/**
 * Put the pulse line up, when anything on this terminal is allowed to move.
 *
 * `registered` is asked on every beat rather than passed once: the discovery
 * check changes it for as long as the deck runs, and the line says so.
 */
export function startPulse({ registered: isRegistered, wantClaude }) {
  if (!MOTION) return;
  let pi = 0;
  let painted = null;
  // The line is on screen and is the last thing written to this terminal.
  let ours = false;
  // We are the one writing right now, so the guard below leaves us alone.
  let writing = false;

  // The pulse line's tenancy, enforced rather than agreed.
  //
  // The convention was that anything with something to say writes a newline
  // first, so the pulse's `\r` never lands on somebody else's text. The boot
  // keeps it everywhere. src/server/quota.mjs does not — it calls console.error
  // directly — and a Windows user with no Claude Code sent a screenshot of the
  // result: `listening — Ctrl+C to stop        ccdeck quota: claude CLI failed`
  // on one row, three times over, the pulse and the complaint interleaved.
  //
  // An invariant every writer has to remember is one a writer will forget, and
  // the writers here are server modules that know nothing about a terminal. So
  // it is enforced at the stream instead: while our line is the last thing on
  // screen, anything else that speaks gets a newline first, and the memo is
  // dropped so the next beat repaints the line under whatever was said.
  //
  // Both streams, because console.error goes to stderr and lands on the same
  // screen. Only when MOTION is on — with no pulse there is no line to defend,
  // and a piped deck must not have its output rewritten.
  for (const stream of [process.stdout, process.stderr]) {
    const real = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      if (!writing && ours) {
        ours = false;
        // Dropped, not kept: the line is no longer where we left it, so the
        // next beat has to draw it again even though the frame is unchanged.
        painted = null;
        // Unless the speaker already did it. Every late message the boot writes
        // opens with one, and two blank lines is its own kind of mess.
        if (!String(chunk).startsWith("\n")) real("\n");
      }
      return real(chunk, ...rest);
    };
  }

  setInterval(() => {
    const registered = isRegistered();
    // The colour follows the words. A Codex-only deck keeps saying "listening"
    // when it is unregistered — see pulseText — and painting that sentence in
    // the warning tone would restore the alarm the sentence just retired.
    const alarm = !registered && wantClaude;
    const state = { registered, claude: wantClaude, busy: busyLabel() };
    const text = pulseText({ ...state, columns: cols(), unicode: UNICODE });
    // At rest every beat is lit, which is what makes the line still: the frame
    // is then identical to the one already on screen and the write below is
    // skipped. See pulseDot.
    const dot = pulseDot(pi++, state) === "on" ? (alarm ? P.warn : P.ok) : P.muted;
    const tone = alarm ? P.warn : P.muted;
    const frame = `\r  ${dot}${G.pulse}${P.reset}  ${tone}${text}${P.reset}`;
    // Unchanged frames are not written at all. That is what makes "at rest"
    // visible: one paint, and then a still line for as long as nothing happens.
    // `painted` is dropped by the guard above whenever somebody else writes, so
    // this can only skip a beat while the line is genuinely still where we left
    // it.
    if (frame === painted) return;
    painted = frame;
    writing = true;
    try { write(frame); } finally { writing = false; }
    ours = true;
  }, 800).unref();
}
