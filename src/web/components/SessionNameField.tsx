// The field a session is named in, where its name was (internal #101): the
// Workspace header, a row of the Sessions list and the Inspector open the same
// one. It opens holding the name drawn, all of it selected, since naming is
// almost always replacing.
//
// Enter saves and Escape puts the name back (session-rename.ts nameFieldKey).
// Leaving the field saves what was typed, as a file manager does; leaving the
// window does not, so a field is never saved by switching to another app.
// An empty field, or the default name typed back, gives the provider's name
// back; the ↺ beside the field does the same in one press, drawn only while
// the deck holds a name to drop.
//
// A save that fails keeps the field open with what was typed in it, its edge
// in the error tone and a line that says so, and the next Enter tries again.
// The session the field saves to is the one it opened on: the facts are read
// once, so a session switched under it is never the one renamed.
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { focusDropped } from "../panel-press";
import { KitIcon } from "./kit-icons";
import { nameFieldKey, saveAsk, saveSessionName, SESSION_NAME_MAX, type RenameFacts } from "../session-rename";

export interface SessionNameFieldProps {
  facts: RenameFacts;
  /** Where it is drawn, for its size: "header", "row" or "hero". */
  place: "header" | "row" | "hero";
  /** The field closed: `saved` when the deck kept a change. */
  onDone(saved: boolean): void;
}

/** The pencil the three places draw beside a name, on the kit's spec: 14px,
 *  a 1.5 stroke, round caps and joins (kit-icons.tsx has no pencil). */
export function RenameGlyph() {
  return (
    <svg className="sn-glyph" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.4 2.6l2 2L5 11l-2.6.6L3 9z" />
      <path d="M8.2 3.8l2 2" />
    </svg>
  );
}

/** One place's renaming: which session it is renaming, if any, and focus put
 *  back on `back` (the pencil, or the row) when the field closes with the
 *  keyboard in it. Renaming is per session: a place whose session changes
 *  while its field is open closes it, unsaved. */
export function useRenaming(sessionId: string | null | undefined, back: RefObject<HTMLElement | null>) {
  const [editing, setEditing] = useState<string | null>(null);
  const restore = useRef(false);
  const on = editing != null && editing === sessionId;
  useEffect(() => {
    if (on || !restore.current) return;
    restore.current = false;
    if (focusDropped(document.activeElement?.tagName ?? null)) back.current?.focus();
  }, [on, back]);
  return {
    on,
    start() { if (sessionId) setEditing(sessionId); },
    done() { restore.current = true; setEditing(null); },
  };
}

export default function SessionNameField({ facts: given, place, onDone }: SessionNameFieldProps) {
  const t = useT();
  const [facts] = useState(given);
  const [draft, setDraft] = useState(given.current);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const alive = useRef(true);
  const closed = useRef(false);
  const errorId = useId();
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => { alive.current = false; };
  }, []);

  const finish = (saved: boolean) => {
    if (closed.current) return;
    closed.current = true;
    onDone(saved);
  };
  const commit = async (typed: string) => {
    if (saving || closed.current) return;
    const ask = saveAsk(typed, facts);
    if (ask.kind === "none") { finish(false); return; }
    setSaving(true);
    const res = await saveSessionName(facts, ask.name);
    if (!alive.current) return;
    setSaving(false);
    if (res.ok) { finish(true); return; }
    setFailed(true);
    // Back to the field, unless the reader has moved on to another control:
    // a save that failed on the way out never pulls focus back from it.
    const here = document.activeElement;
    if (focusDropped(here?.tagName ?? null) || wrapRef.current?.contains(here)) inputRef.current?.focus();
  };

  return (
    <span ref={wrapRef} className="sn-field" data-place={place} data-failed={failed || undefined}
      // Leaving the ↺ for anywhere but the field is leaving the field.
      onBlur={e => {
        if (e.target === inputRef.current || !document.hasFocus()) return;
        if (e.relatedTarget instanceof Node && wrapRef.current?.contains(e.relatedTarget)) return;
        void commit(draft);
      }}
      onKeyDown={e => {
        // Escape on the ↺ is the field's Escape too.
        if (e.target === inputRef.current) return;
        e.stopPropagation();
        if (nameFieldKey({ key: e.key }) === "cancel") { e.preventDefault(); finish(false); }
      }}>
      <input
        ref={inputRef}
        className="ap-manage-input sn-input"
        value={draft}
        maxLength={SESSION_NAME_MAX}
        placeholder={facts.fallback}
        spellCheck={false}
        autoComplete="off"
        aria-label={t("board.rename.field")}
        aria-invalid={failed || undefined}
        aria-describedby={failed ? errorId : undefined}
        aria-busy={saving || undefined}
        readOnly={saving}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          // Every key typed here is the field's: the row, the list and the
          // stage around it have keys of their own (arrows, Home, Enter).
          e.stopPropagation();
          const act = nameFieldKey({ key: e.key, isComposing: e.nativeEvent.isComposing });
          if (!act) return;
          e.preventDefault();
          if (act === "save") void commit(draft);
          else finish(false);
        }}
        onBlur={e => {
          // Focus left for another window: the field is still here when the
          // reader comes back, so nothing is saved behind their back. Nor
          // when it went to the ↺ beside it, which is the field's own.
          if (!document.hasFocus()) return;
          if (e.relatedTarget instanceof Node && wrapRef.current?.contains(e.relatedTarget)) return;
          void commit(draft);
        }}
        // A click inside the field stays in the field: the row and the
        // header around it answer a click of their own.
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
      />
      {facts.deckNamed && (
        <button
          type="button"
          className="glyph-btn sn-reset"
          aria-label={t("board.rename.reset")}
          title={facts.fallback ? `${t("board.rename.reset")}: ${facts.fallback}` : t("board.rename.reset")}
          // Never disabled while a save is out (#620): commit ignores a press then.
          // Pressing it must not take focus from the field first: the blur
          // would save what was typed before the reset lands.
          onMouseDown={e => e.preventDefault()}
          onClick={e => { e.stopPropagation(); void commit(""); }}
        >
          <KitIcon name="restart" />
        </button>
      )}
      {failed && <span id={errorId} className="sn-error" role="alert">{t("board.rename.failed")}</span>}
    </span>
  );
}
