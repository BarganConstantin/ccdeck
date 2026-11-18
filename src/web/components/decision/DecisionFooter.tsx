// The card's foot: the pick keys, a note about what is safe, and the way to the
// terminal. The note is the card's promise and changes with the card's mode, so
// the words are exported for the test to hold word for word.
//
// The note is the desktop's everywhere ("Sent only when you pick, after
// re-reading the prompt"); the phone frame's shorter "Re-checked before it is
// sent" is not used.
import { Kbd } from "../Kbd";
import { ExternalLinkGlyph } from "../action-glyphs";
import { LockGlyph } from "../chat/chat-icons";
import type { DecisionMode } from "./decision-machine";

export const NOTE_DEFAULT = "Sent only when you pick, after re-reading the prompt";
export const NOTE_FOCUS = "↵ sends the highlighted answer, after re-reading the prompt";
export const NOTE_FREE = "↵ sends what you wrote · Esc goes back to the choices";
export const NOTE_OUTSIDE = "Started outside ccdeck, so it is answered in its own terminal";
export const LINK_TERM = "See it in Term";

/** "Send 2 answers  ↵" (two spaces kept), the several-answers card's note. */
export function noteMany(count: number): string {
  return `Send ${count} ${count === 1 ? "answer" : "answers"}  ↵`;
}

export function footNote(mode: DecisionMode, focused: boolean, checked: number): { text: string; lock: boolean } {
  if (mode === "readOnly") return { text: NOTE_OUTSIDE, lock: false };
  if (mode === "free") return { text: NOTE_FREE, lock: false };
  // With nothing checked there is nothing to send, so the card does not say "Send 0 answers".
  if (mode === "multi") return { text: checked > 0 ? noteMany(checked) : "", lock: false };
  return focused ? { text: NOTE_FOCUS, lock: false } : { text: NOTE_DEFAULT, lock: true };
}

export default function DecisionFooter(p: {
  mode: DecisionMode;
  focused: boolean;
  checked: number;
  rows: number;
  /** The digits are character keys: with Settings › Keyboard's switch off, "Pick 1 – 3" is not said. */
  singleKeys?: boolean;
  onShowTerm?(): void;
}) {
  const note = footNote(p.mode, p.focused, p.checked);
  const readOnly = p.mode === "readOnly";
  return (
    <div className="dc-foot">
      {!readOnly && p.mode !== "multi" && p.singleKeys !== false && (
        <span className="dc-foot-pick">
          Pick <Kbd>1</Kbd>{p.rows > 1 && <> {"–"} <Kbd>{String(p.rows)}</Kbd></>}
        </span>
      )}
      <span className="dc-foot-note" data-muted={p.mode === "multi" || undefined}>
        {note.lock && <LockGlyph />}
        {note.text}
      </span>
      {!readOnly && (
        <button type="button" className="dc-link" onClick={p.onShowTerm}>
          {LINK_TERM}
          <ExternalLinkGlyph />
        </button>
      )}
    </div>
  );
}
