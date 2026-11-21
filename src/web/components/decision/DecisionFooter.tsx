// The card's foot: the pick keys, a note about what is safe, and the way to the
// terminal. The note is the card's promise and changes with the card's mode, so
// its words are exported for the test to hold word for word.
//
// The note is the desktop's everywhere ("Sent only when you pick, after
// re-reading the prompt"); the phone frame's shorter "Re-checked before it is
// sent" is not used.
import { t as tNow, useT, type MessageKey, type TFunction } from "../../i18n";
import { Kbd } from "../Kbd";
import { ExternalLinkGlyph } from "../action-glyphs";
import { LockGlyph } from "../chat/chat-icons";
import type { DecisionMode } from "./decision-machine";

export const NOTE_DEFAULT: MessageKey = "board.decision.note.default";
export const NOTE_FOCUS: MessageKey = "board.decision.note.focus";
export const NOTE_FREE: MessageKey = "board.decision.note.free";
export const NOTE_OUTSIDE: MessageKey = "board.decision.note.outside";

/** "Send 2 answers  ↵" (two spaces kept), the several-answers card's note. */
export function noteMany(count: number, t: TFunction = tNow): string {
  return t("board.decision.note.many", { count });
}

export function footNote(mode: DecisionMode, focused: boolean, checked: number, t: TFunction = tNow): { text: string; lock: boolean } {
  if (mode === "readOnly") return { text: t(NOTE_OUTSIDE), lock: false };
  if (mode === "free") return { text: t(NOTE_FREE), lock: false };
  // With nothing checked there is nothing to send, so the card does not say "Send 0 answers".
  if (mode === "multi") return { text: checked > 0 ? noteMany(checked, t) : "", lock: false };
  return focused ? { text: t(NOTE_FOCUS), lock: false } : { text: t(NOTE_DEFAULT), lock: true };
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
  const t = useT();
  const note = footNote(p.mode, p.focused, p.checked, t);
  const readOnly = p.mode === "readOnly";
  return (
    <div className="dc-foot">
      {!readOnly && p.mode !== "multi" && p.singleKeys !== false && (
        <span className="dc-foot-pick">
          {t("board.decision.pick")} <Kbd>1</Kbd>{p.rows > 1 && <> {"–"} <Kbd>{String(p.rows)}</Kbd></>}
        </span>
      )}
      <span className="dc-foot-note" data-muted={p.mode === "multi" || undefined}>
        {note.lock && <LockGlyph />}
        {note.text}
      </span>
      {!readOnly && (
        <button type="button" className="dc-link" onClick={p.onShowTerm}>
          {t("board.decision.seeTerm")}
          <ExternalLinkGlyph />
        </button>
      )}
    </div>
  );
}
