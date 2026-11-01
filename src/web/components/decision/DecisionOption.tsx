// One answer on the Decision card: a radio, or a checkbox when several may be
// picked. Its states are Default, Focus (the ring), Locked (it changes the
// session's rules or mode, so only in the terminal), Typed (the free field is
// open in it) and Checked.
//
// Interactive: the row. No filled button anywhere on the card. The key chip on
// the left is the digit that picks it. A locked row is reachable so it can be
// read, and says "aria-disabled" with its lock note as the description.
import { useId, type KeyboardEvent, type Ref } from "react";
import { LockGlyph } from "../chat/chat-icons";
import type { DecisionOptionModel } from "./decision-model";

export const PICK_TAG = "Claude’s pick";
export const SEND_WORD = "Send";

export interface DecisionOptionProps {
  index: number;
  option: DecisionOptionModel;
  selection: "radio" | "checkbox";
  /** The ring is on this row. */
  focused: boolean;
  checked: boolean;
  /** The row is open as a field (state 7). */
  typing: boolean;
  text: string;
  /** The card cannot be answered from here at all. */
  readOnly: boolean;
  /** The digit keys are on (Settings › Keyboard): the row names its digit. */
  singleKeys?: boolean;
  /** The row's tab stop: one row is reachable by Tab, the ring moves from it. */
  tabStop: boolean;
  rowRef?: Ref<HTMLDivElement>;
  inputRef?: Ref<HTMLInputElement>;
  onPick(): void;
  onFocus(): void;
  onText(text: string): void;
  onFieldKey(e: KeyboardEvent<HTMLInputElement>): void;
}

export default function DecisionOption(p: DecisionOptionProps) {
  const { option: o } = p;
  // Unique per card: two cards on a page do not share a description.
  const uid = useId();
  const noteId = o.locked ? `${uid}-lock-${p.index}` : undefined;
  return (
    <div className="dc-row" data-typing={p.typing || undefined}>
      <div
        ref={p.rowRef}
        className="dc-opt"
        role={p.selection === "radio" ? "radio" : "checkbox"}
        aria-checked={p.checked}
        aria-disabled={o.locked || p.readOnly || undefined}
        aria-describedby={noteId}
        aria-keyshortcuts={p.readOnly || p.singleKeys === false ? undefined : String(p.index + 1)}
        tabIndex={p.readOnly ? undefined : p.tabStop ? 0 : -1}
        data-focus={p.focused || undefined}
        data-locked={o.locked || undefined}
        data-checked={p.checked || undefined}
        data-typing={p.typing || undefined}
        onClick={p.readOnly ? undefined : p.onPick}
        onFocus={p.readOnly ? undefined : p.onFocus}
      >
        <span className="dc-chip" aria-hidden="true">{p.index + 1}</span>
        <span className="dc-opt-text">
          <span className="dc-opt-label">{o.label}</span>
          {o.locked
            ? <span className="dc-opt-sub dc-lock" id={noteId}><LockGlyph />{o.lockNote}</span>
            : <span className="dc-opt-sub">{o.sub}</span>}
        </span>
        {o.pick && <span className="dc-pick">{PICK_TAG}</span>}
        {p.selection === "checkbox" && <span className="dc-box" aria-hidden="true" data-on={p.checked || undefined} />}
      </div>
      {p.typing && (
        <div className="dc-field">
          <input
            ref={p.inputRef}
            className="dc-input"
            type="text"
            value={p.text}
            aria-label={o.label}
            onChange={e => p.onText(e.target.value)}
            onKeyDown={p.onFieldKey}
          />
          <span className="dc-send" aria-hidden="true">{SEND_WORD} {"↵"}</span>
        </div>
      )}
    </div>
  );
}
