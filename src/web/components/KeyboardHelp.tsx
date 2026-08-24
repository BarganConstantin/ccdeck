// The shortcuts sheet, with a way in.
//
// There has always been a list of shortcuts on this deck, in the detail rail's
// empty state — which is to say: only while no agent is selected, and only
// while the rail is open. It is the first thing a new deck shows and the first
// thing that disappears the moment anyone starts using it. Three keys had never
// been added to it at all, and the release notes had been quietly removing the
// alternatives: the search box in 1.38.0, the sessions counter in 1.39.0, the
// sessions-list button in 1.41.0. That is a coherent design — shortcuts, plus a
// sheet — but it only works if the sheet is complete and can be opened at any
// moment, which is what this is.
//
// It is the deck's seventh modal and it is deliberately built out of the six
// others' parts: `.modal-backdrop` and `.modal` carry the entrance
// (fadeIn/popIn, and the fade alone under reduced motion), `useModalDismiss`
// carries Escape, the focus trap and the focus hand-back, and `.shortcuts` is
// the same two-column grid the rail has always drawn. Nothing here is a fourth
// spelling of anything.
//
// The rows come from key-help.ts rather than from this file, for the reason
// written out there: a test can hold that table against App.tsx's keydown
// handler and fail when a key is bound and not listed. A sheet that is the only
// documentation has to be provably complete, not carefully maintained.
//
// One honest note about what this dialog does to the keys it advertises.
// `ownsKeystroke()` hands every bare key to whichever control holds focus, and
// this sheet takes focus when it opens — so while it is up, every letter in it
// is inert. That is not a bug to route around: it is the rule that stops a
// stray "c" from truncating the event log. The sheet says so in its own first
// paragraph and Esc is the documented way back.
import { Fragment } from "react";
import { KEY_HELP, KEY_HELP_NOTE } from "../key-help";
import { useModalDismiss } from "./use-modal-dismiss";

interface Props {
  onClose: () => void;
}

export default function KeyboardHelp({ onClose }: Props) {
  const dialogRef = useModalDismiss(onClose);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal key-help"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-help-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            {/* Named by its own visible title, the way the tool modal and the
                clear prompt are. A heading would have been the other option and
                is not available: the outline rule in landmark-outline.test.ts
                keeps h4 to the three dialogs that already had one, and an h2 in
                here would claim this is one of the deck's persistent regions.
                The section captions below are h3, which is the level a dialog
                that names itself with aria-labelledby can start at. */}
            <span id="key-help-title" className="modal-tool-name">Keyboard shortcuts</span>
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
          <p className="modal-note">{KEY_HELP_NOTE}</p>
          {/* One grid for the whole sheet rather than one per group, and the
              captions span it. A grid each would have measured its own key
              column, so `Shift + Enter` would have pushed one group's caps
              wider than the four around it and the eye would have five left
              edges to follow down a list whose whole job is to be scanned. */}
          <div className="shortcuts">
            {KEY_HELP.map(group => (
              <Fragment key={group.title}>
                <h3 className="kh-group">{group.title}</h3>
                {group.rows.map(row => (
                  <div className="sc" key={`${group.title}:${row.cap}:${row.action}`}>
                    <kbd>{row.cap}</kbd><span>{row.action}</span>
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
