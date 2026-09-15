// Claude Code's own account of where a session stands, read off its transcript.
//
// WHAT IT IS. Once a turn has been finished for three minutes and the terminal
// is not focused, Claude Code writes one line into the transcript — the
// "※ recap:" the terminal prints when you come back to it:
//
//   {"type":"system","subtype":"away_summary","content":"VCRM-8867 is planned: … (disable recaps in /config)","timestamp":"…",…}
//
// Measured on this machine on 2026-09-14: 60 of them in two days of
// transcripts, 181 to 305 characters each, written a median 3.1 minutes after
// the line before them. Claude Code caps them at 400 characters, writes one only
// once a session has three turns, and never writes two in a row.
//
// WHY THE DECK WANTS IT. It is written at the moment the person has left the
// terminal, which is exactly when they are looking at the deck instead. It is
// the only line in the file written for a human who is catching up, and it is
// written in their language.
//
// WHEN IT STOPS BEING TRUE. A recap describes the session as the last turn left
// it, so the next turn makes it history: a main-chain assistant line after it
// retires it here. The client holds the other half of that rule — a prompt
// newer than the recap — because a prompt reaches the deck through its hook
// seconds before the model has written anything to this file.

/** The cheap test every line gets before anything is parsed. */
export const RECAP_MARK = '"away_summary"';
const ASSISTANT_MARK = '"type":"assistant"';

/** Above Claude Code's own 400, so it never cuts a real recap. It bounds what a
 *  malformed line could put on a card, and nothing else. */
const RECAP_MAX_CHARS = 600;

/**
 * The recap as a card can show it.
 *
 * Claude Code ends every one with its own opt-out hint, "(disable recaps in
 * /config)". That is advice about the terminal, it is the same on every recap,
 * and on a 260px card it is a tenth of the room, so it goes. Only a trailing
 * parenthetical that mentions `/config` is taken: a recap that ends on a
 * bracket of its own keeps it.
 */
export function cleanRecap(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/\s*\([^()]*\/config[^()]*\)\s*$/, "").trim();
  if (text.length > RECAP_MAX_CHARS) text = text.slice(0, RECAP_MAX_CHARS - 1).trimEnd() + "…";
  return text;
}

/**
 * The recap one transcript line carries, or null.
 *
 * Main chain only: a subagent's sidechain is not the session a person comes
 * back to. The line's own timestamp is the recap's time, never the clock here —
 * the deck may be reading a line written while it was down, and the client
 * compares this time against the session's prompts to decide whether the recap
 * still describes it. A line with no usable time cannot be compared, so it is
 * not a recap the deck can use.
 */
export function recapOf(line) {
  if (!line || !line.includes(RECAP_MARK)) return null;
  let obj = null;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  if (obj.type !== "system" || obj.subtype !== "away_summary") return null;
  if (obj.isSidechain === true) return null;
  const text = cleanRecap(obj.content);
  const at = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
  if (!text || !Number.isFinite(at)) return null;
  return { text, at };
}

/**
 * Fold one line into `out.recap`: set by a recap, retired by the next turn.
 *
 * Pure, and shaped like foldSessionNamingLine beside it so the transcript
 * cursor can run both over the same line. A line is parsed only when it could
 * matter — it carries the recap mark, or a recap is standing and the line looks
 * like the model answering — so the ordinary line costs two substring tests.
 */
export function foldRecapLine(out, line) {
  if (!line) return;
  const recap = recapOf(line);
  if (recap) { out.recap = recap; return; }
  if (!out.recap || !line.includes(ASSISTANT_MARK)) return;
  let obj = null;
  try { obj = JSON.parse(line); } catch { return; }
  if (obj && obj.type === "assistant" && obj.isSidechain !== true) out.recap = null;
}
