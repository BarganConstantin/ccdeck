// What changed, in the one place a user cannot miss it — once (#712).
//
// The deck's eighth modal, and like the seventh it is built entirely out of the
// others' parts: `.modal-backdrop` and `.modal` carry the scrim and the
// entrance, `useModalDismiss` carries Esc, the focus trap and the focus
// hand-back, and `.modal-head` / `.modal-body` carry the frame. Nothing here is
// a second spelling of any of that. What is its own is the list, and the list is
// prose rather than data, so it is styled like something to read instead of
// something to inspect.
//
// Every decision about WHICH notes reach this component is release-notes.ts's,
// and deliberately not this file's. A component cannot be asked what it would
// have shown a user upgrading 1.42 to 1.48 without a browser; a function can,
// and __tests__/release-notes.test.ts asks it thirty different ways. All this
// draws is the answer.
//
// The dialog is dismissible without regret because it is reachable again from
// the version chip in the topbar — see versionChipLabel in version-chip.ts, and
// #715 for why that is the chip itself rather than the separate button #712
// put beside it. That matters more than it sounds: the "you have already seen
// this" marker lives in the browser store, so clearing site data loses it, and
// the chip is the only way back.
import { releaseNotesIntro, splitNoteTitle, versionRangeLabel, type VersionNotes } from "../release-notes";
import { useModalDismiss } from "./use-modal-dismiss";

interface Props {
  /** The releases to show, newest first — decideReleaseNotes' answer, or every
   *  release this build knows about when the version chip opened it. */
  entries: VersionNotes[];
  /** The version the user had already been caught up to, when the deck raised
   *  this by itself. Null when they opened it from the chip, which is a
   *  different sentence and not a missing one. */
  since: string | null;
  /** The version the deck is running, so the first line can say whether the
   *  release at the top of this list is the one the reader is on. */
  running: string | null;
  onClose: () => void;
}

export default function ReleaseNotesModal({ entries, since, running, onClose }: Props) {
  // No focusRef: the × is the first control in the dialog, so the hook's own
  // default — the dialog's first tabbable — already lands there, and the body
  // below holds no control that would be a better first stop.
  const dialogRef = useModalDismiss(onClose);
  const range = versionRangeLabel(entries);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal release-notes"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-notes-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            {/* Named by its own visible title, the way the shortcuts sheet and
                the tool inspector are. A heading here would claim this dialog
                is part of the page's outline, which aria-modal says it is not
                while it is up. */}
            <span id="release-notes-title" className="modal-tool-name">What&apos;s new</span>
            {/* The span of releases below, so the reader knows the size of what
                they are looking at before they start scrolling it. Omitted
                rather than left blank when there is nothing to span. */}
            {range && <span className="modal-tool-id">{range}</span>}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="glyph-btn"
              onClick={onClose}
              aria-label="Close (Esc)"
              title="Close (Esc)"
            >×</button>
          </div>
        </header>

        <section className="modal-body">
          {/* Why this is on screen, in the first line. A dialog that appears
              without being asked and does not say why is the one people learn
              to dismiss unread, which would make it worthless on the release it
              exists for. */}
          <p className="modal-note">{releaseNotesIntro({ since, running, entries })}</p>
          {entries.map(entry => (
            <section className="modal-section" key={entry.version}>
              {/* h3, not h4: the level a dialog that names itself with
                  aria-labelledby starts at, and the same choice the shortcuts
                  sheet makes for its group captions. */}
              <h3 className="rn-version">v{entry.version}</h3>
              <ul className="rn-notes">
                {entry.notes.map((note, i) => {
                  // A leading emoji gets a box of its own so the sheet can give
                  // it the side bearing its glyph does not have — see
                  // splitNoteTitle, which is also where the reasoning lives for
                  // why the space stays inside `rest` rather than being spelled
                  // here. `icon` + `rest` is the title, character for character,
                  // so nothing about the text this renders has changed.
                  const { icon, rest } = splitNoteTitle(note.title);
                  return (
                    // The index is the key because a note has no identity
                    // beyond its position in a file nobody edits at runtime:
                    // this list is built once from a frozen import and never
                    // reorders.
                    <li className="rn-note" key={i}>
                      <p className="rn-note-title">
                        {icon && <span className="rn-note-icon">{icon}</span>}
                        {rest}
                      </p>
                      <p className="rn-note-body">{note.body}</p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </section>
      </div>
    </div>
  );
}
