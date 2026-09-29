// The pulse line — the one line that stays on screen for hours under the boot
// report — and the "not registered" sentence printed above it when this deck's
// discovery file could not be written.
//
// Lifted out of term.mjs, whose glyph tier it takes its dash and bullet from:
// term.mjs keeps the rules about the terminal, and this is what the deck says
// on it. bin/cli/pulse.js paints the line and bin/deck.js prints the sentence,
// and both are decided here, where every input is a parameter and nothing
// writes.
import { glyphs } from "./term.mjs";

/**
 * The one line that stays on screen for hours, sized to the terminal it is on.
 *
 * It is redrawn over itself with `\r`, so both messages are padded to one width
 * — the shorter has to cover the longer — and that width is clamped to the real
 * terminal: at 40 columns the old 58-character message wrapped, after which the
 * `\r` only ever reached the second row and every repaint left the first one
 * behind. A deck no hook can find is not listening in any sense the user cares
 * about, which is why that state has a message here at all.
 *
 * `claude` is what makes that last sentence conditional. A deck watching only
 * Codex is not waiting on a hook: startCodexWatcher is started by startServer
 * and never consults the discovery file, and writesCodexLog keeps a deck with no
 * record on disk writing its log. Capture and persistence both work perfectly
 * there, while this line used to repaint "hooks cannot find this deck" every
 * 800ms, forever (#404) — a permanent alarm about a mechanism that deck does not
 * use. The one-time report at boot still says what IS lost; see
 * unregisteredDetail.
 */
export function pulseText({
  registered = true, claude = true, columns = 80, unicode = true, indent = 2, busy = null,
} = {}) {
  const g = glyphs(unicode);
  const room = Math.max(4, columns - indent - 3 - 1);
  const pick = (options) => options.find((o) => o.length <= room) ?? options[options.length - 1].slice(0, room);

  const rest = pick([`listening ${g.dash} Ctrl+C to stop`, "listening"]);
  const bad = pick([
    `listening, but not registered ${g.dash} hooks cannot find this deck`,
    `not registered ${g.dash} hooks cannot find this deck`,
    "not registered",
  ]);
  // Both branches are still measured, registered or not, because the line is
  // redrawn over itself and the shorter message has to cover the longer one on
  // the beat after a deck loses its registration.
  //
  // The width is deliberately computed from the two FIXED messages only. `busy`
  // comes and goes on a single boot — an install starts, the line names it, the
  // install ends and the line goes back to Ctrl+C — so a width that grew to fit
  // the label would have to shrink again afterwards, and the shorter line would
  // leave the tail of the longer one on screen. Instead the label is shown only
  // where it already fits — 60 columns and wider, measured — and below that the
  // line says the true thing it has always said.
  const width = Math.min(room, Math.max(rest.length, bad.length));
  // What is still happening, rather than what is always true. `Ctrl+C to stop`
  // is the right thing to say to somebody with nothing left to wait for, and
  // the wrong thing to say to somebody watching an install.
  const label = typeof busy === "string" && busy.trim() ? busy.trim() : null;
  const working = label ? `listening ${g.bullet} ${label}` : null;
  const ok = working && working.length <= width ? working : rest;
  return (registered || !claude ? ok : bad).padEnd(width);
}

/**
 * Whether the line has anything left to say by moving.
 *
 * #742. The dot alternated green and grey every 800ms for as long as the deck
 * ran, and a blinking indicator beside a status line is the vocabulary of
 * "working on it" — so a boot that had finished in a second read as one that
 * never finished, and people said so. The deck's own web UI already retired
 * this once: the pill goes quiet at rest (#720). The terminal did not.
 *
 * Motion is now spent on the two states where something is genuinely
 * outstanding — a deck no hook can find, and a background job still running —
 * and nowhere else. At rest the dot is painted once, in the healthy colour, and
 * left alone. Movement then means something changed, which is the only thing
 * movement should ever mean on a line somebody leaves open for hours.
 */
export function pulseMoves({ registered = true, claude = true, busy = null } = {}) {
  if (!registered && claude) return true;
  return typeof busy === "string" && busy.trim() !== "";
}

/**
 * Whether the dot is lit on this beat.
 *
 * `"on"` on every beat of a deck at rest, which is what makes the line still:
 * bin/cli/pulse.js paints a beat only when the frame differs from the one
 * already on screen, so a dot that is always lit is a line written once and
 * then left alone. Alternating is reserved for the states pulseMoves admits.
 *
 * The beat is a parameter rather than counted here so this is a function of its
 * inputs and nothing else — and so a test can ask what the twentieth beat of an
 * idle deck looks like without waiting sixteen seconds for it.
 */
export function pulseDot(beat, { registered = true, claude = true, busy = null } = {}) {
  if (!pulseMoves({ registered, claude, busy })) return "on";
  return beat % 2 === 0 ? "on" : "off";
}

/**
 * The second line of the "not registered" report, which bin/deck.js prints once
 * per change of state rather than every beat.
 *
 * What a missing discovery file costs is not the same on the two capture paths,
 * and the old sentence — "hooks find this deck through <file>, so until that
 * file exists no events arrive" — stated the Claude Code answer as if it were
 * both. On a Codex-only deck it is false twice over: no hook is looking for this
 * deck, and events do keep arriving, because the rollout watcher reads the files
 * directly. What that deck really loses is the writer election in
 * log-election.mjs, which is how several decks tailing one rollout agree on
 * which of them appends it to a shared events log. A deck with no record on
 * disk is assumed to be writing, so nothing is dropped — the log can gain the
 * same line twice instead.
 *
 * @param file the discovery file that could not be written.
 * @param claude whether this deck is watching Claude Code at all.
 * @param dash the em dash, or the ASCII stand-in on a console that cannot draw
 *   one (#797). A parameter for the same reason `renameNotice` takes one:
 *   term.mjs says, above its glyphs, "every glyph the deck prints — punctuation
 *   included, since an em dash is as absent from CP437 as a check mark — comes
 *   from one of them", and this sentence had it hardcoded. On a legacy cmd.exe
 *   or the Linux virtual console the reader got a box in the middle of the one
 *   line explaining why no events are arriving.
 */
export function unregisteredDetail({ file, claude = true, dash = "—" }) {
  if (claude) {
    return `Claude Code hooks find this deck through ${file}, so until that file exists no Claude Code events arrive.`;
  }
  return `Codex capture does not use ${file} ${dash} the deck tails the rollout files itself ${dash} so events still arrive. Only decks sharing one events log need it, to agree on which of them records.`;
}
