// The one line that stops a deck from being lost.
//
// THE DEFECT, and it is not in any code path. `ccdeck` prints an address, opens
// a tab, and hands the terminal back. Weeks later the tab is closed, the
// scrollback is gone, and the address — a loopback IP and a four-digit port —
// is the kind of string nobody has ever memorised on purpose. The deck is still
// running, still listening, still the thing they want, and they cannot get to
// it. This has a name in every local tool that has ever shipped a dashboard:
// Jupyter carries the same report on its own forum, filed as "Minor UX", and it
// is not minor — it is the difference between a tool you return to and a tool
// you start again from scratch.
//
// WHAT IS ALREADY TRUE, and was never said out loud. Both ways back already
// work and neither is discoverable:
//
//   * `ccdeck` typed a second time does NOT start a second deck. running-deck.mjs
//     finds the one that is up, and bin/deck.js prints its address and opens it.
//     The command IS the way back; nobody knows, because the only place that
//     could have said so is the boot the fact is about.
//   * `ccdeck` typed in the browser's address bar finds it too. The tab's title
//     is the product name (see ambient.ts), so the address goes into history
//     under a word — and a word is the thing people actually remember.
//
// So this file invents nothing. It says, once, next to the address it is about,
// that the address is not the way back and the NAME is.
//
// WHY THE NAME IS THE WHOLE POINT. The behaviour worth teaching is not "here is
// your port". It is "you never need the port". A line that repeated the number
// would be teaching the thing that fails; the line below deliberately does not
// contain one.
//
// NOT ON AN ATTACH. bin/deck.js prints this on a start and not in the branch
// where a second `ccdeck` attached to a running deck — somebody standing in that
// branch has just performed the lesson. Telling them how to do what they did is
// the kind of help that reads as noise.
//
// `dash` comes from the caller's glyph tier, for the reason invoked-as.mjs
// states: an em dash is as absent from a legacy Windows console as a check mark
// is, and no file that prints one may be the one that forgets.
import { PRODUCT } from "./brand.mjs";

/** The two spaces bin/deck.js writes in front of every row and note. */
const INDENT = 2;
/** The glyph, and the two spaces after it, that the caller writes before this. */
const GUTTER = 3;
/** statusLine keeps a column back from the edge; a note beside its rows does too. */
const MARGIN = 1;

/**
 * What the terminal says about coming back, at the width it has to say it in.
 *
 * A LADDER, NOT AN ELLIPSIS. statusLine truncates a detail that will not fit
 * because a row's detail is usually one fact that degrades gracefully; this is
 * three separable claims, and the tail of any of them is nonsense on its own.
 * Cut, the last clause becomes "…from any termi", which teaches nothing and
 * looks broken. So the note is built from its core outwards and each piece is
 * added only if the whole thing still fits:
 *
 *   `ccdeck` brings this deck back    the behaviour; never dropped
 *   nothing to memorise —             the permission to forget the address
 *   , from any terminal               why it is a route home and not a trick
 *
 * The widest rung fits an 80-column terminal, which is not a coincidence: 80 is
 * what most of these are, and a second clause that only ever appeared on a
 * maximised window would be a clause most users never read. At 40 — term-
 * layout.test.ts's narrowest, and a real terminal on a split screen — only the
 * command survives, which is the right thing to lose the other two for.
 *
 * WHY "FROM ANY TERMINAL" EARNED THE LAST 19 COLUMNS. Without it the line reads
 * as a fact about the window it is printed in, and the reader's next thought is
 * "yes, but I closed that one". The route home does not need this terminal,
 * this directory or this shell — running-deck.mjs looks the deck up in a
 * registry, not in the environment — and saying so is what turns the sentence
 * from a tip into something you can rely on a month from now.
 *
 * ONE LESSON, NOT TWO. An earlier draft also taught the browser half: the tab's
 * title is the product name, so typing it in the address bar finds the deck in
 * history. True, and cut anyway — it needed 96 columns, it is the less reliable
 * of the two (it wants a visit already in history), and somebody who has learnt
 * to type the name reaches for it in the address bar without being told.
 *
 * @param {object} [o]
 * @param {string} [o.command]  The name that works in this shell — INVOKED_AS.
 * @param {string} [o.dash]     The caller's dash glyph.
 * @param {number} [o.columns]  Terminal width.
 * @returns {string} The note, with no leading gutter and no trailing newline.
 */
export function wayBackNote({ command = PRODUCT, dash = "—", columns = 80 } = {}) {
  const room = columns - INDENT - GUTTER - MARGIN;
  // The core, and the only part that is never given up. `command` rather than
  // PRODUCT because somebody living with the legacy `agents-deck` on their PATH
  // types that, and a line naming a command they do not have is worse than no
  // line — see invoked-as.mjs, which answers the same question for the rename.
  const core = `\`${command || PRODUCT}\` brings this deck back`;
  // The reassurance goes in front, the way renameNotice puts its own in front
  // and for the same reason: a line that opened with "type this" would read as
  // an instruction about a problem, and there is no problem here — there is a
  // number they were about to try to keep, and permission to let it go.
  const said = `nothing to memorise ${dash} ${core}`;
  const whole = `${said}, from any terminal`;
  if (whole.length <= room) return whole;
  if (said.length <= room) return said;
  return core;
}
