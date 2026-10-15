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
// stray "c" from truncating the event log. The sheet says so in one line under
// its keys (#852), and Esc is the documented way back.
import { Fragment } from "react";
import { KEY_HELP_NOTE, KEY_HELP_OFF_TITLE, KEY_HELP_SWITCH_NOTE, keyHelpFor, SINGLE_KEYS_PLACE } from "../key-help";
import { isApplePlatform, platformName } from "../platform";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

interface Props {
  onClose: () => void;
  /** Close this and open the tour — `?` is the help key, and the tour is the
   *  other half of help. */
  onTour?: () => void;
  /** Close this and open Settings at General, where the single-key switch is. */
  onSettings?: () => void;
}

export default function KeyboardHelp({ onClose, onTour, onSettings }: Props) {
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const apple = isApplePlatform(platformName());
  const singleKeys = useSingleKeyShortcuts();
  const groups = keyHelpFor(singleKeys);

  return (
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div
        ref={dialogRef}
        className="modal key-help"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-help-title"
        aria-describedby={singleKeys ? undefined : "key-help-off"}
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
          {/* THE SHORTCUTS ARE OFF (WCAG 2.1.4), said first and calmly: a
              state the reader chose, not a fault. `?` cannot have opened the
              sheet like this — the button in the canvas stack did — so it
              says where the switch is and opens Settings there. The grid
              under it lists only what still works. On the tour door's row
              and the sheet's one left edge, with a hairline under it rather
              than a box, so the sheet keeps the single edge it is built on;
              the dialog's description, so a screen reader says it with the
              title. */}
          {!singleKeys && (
            <div className="kh-off">
              <p className="kh-off-text" id="key-help-off">
                <strong>{KEY_HELP_OFF_TITLE}</strong> Turn them back on in{" "}
                <span className="kh-place">{SINGLE_KEYS_PLACE}</span>. Everything below still works.
              </p>
              {onSettings && <button type="button" className="btn" onClick={onSettings}>Open Settings</button>}
            </div>
          )}
          {/* The tour's permanent door, beside the other kind of help. Above
              the grid, so it is found before the reader starts scanning keys;
              after the ×, so the × stays the first stop. */}
          {onTour && (
            <div className="guide-door">
              <span>Eight pictures of what the deck shows.</span>
              <button type="button" className="btn" onClick={onTour}>Take the tour</button>
            </div>
          )}
          {/* One grid for the whole sheet rather than one per group, and the
              captions span it. A grid each would have measured its own key
              column, so `Shift + Enter` would have pushed one group's caps
              wider than the four around it and the eye would have five left
              edges to follow down a list whose whole job is to be scanned. */}
          <div className="shortcuts">
            {groups.map(group => (
              <Fragment key={group.title}>
                <h3 className="kh-group">{group.title}</h3>
                {group.rows.map(row => (
                  <div className="sc" key={`${group.title}:${row.cap}:${row.action}`}>
                    <kbd>{apple && row.macCap ? row.macCap : row.cap}</kbd><span>{row.action}</span>
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
          {/* Under the keys, not over them (#852): the reference comes first,
              and what to do when a key does nothing is a footnote to it, with
              where to turn the letters off for whoever opened the sheet
              because they fire when they should not. Not while they are off,
              when Esc is no answer to a letter doing nothing and the note
              above has said why. */}
          {singleKeys && <p className="kh-foot">{KEY_HELP_NOTE} {KEY_HELP_SWITCH_NOTE}</p>}
        </section>
      </div>
    </div>
  );
}
