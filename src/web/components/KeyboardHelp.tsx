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
import { kindOffered, useIntegrations } from "../integrations/client";
import { KEY_HELP_NOTE, KEY_HELP_OFF_TITLE, KEY_HELP_SWITCH_NOTE, keyHelpFor, SINGLE_KEYS_PLACE, type KeyHelpGroup } from "../key-help";
import { isApplePlatform, platformName } from "../platform";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { Dialog, DialogClose } from "./Dialog";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { useT } from "../i18n";
import { richText } from "./settings-rich";

interface Props {
  onClose: () => void;
  /** Close this and open the tour — `?` is the help key, and the tour is the
   *  other half of help. */
  onTour?: () => void;
  /** Close this and open Settings at Keyboard, where the single-key switch is. */
  onSettings?: () => void;
  /** The Command Panel is on, so Ctrl + backtick has a row (key-help.ts). */
  workspace?: boolean;
  /** Groups a screen adds while it is on (the Decision card's keys). Passed by
   *  the caller, never named here, so with no screen the sheet is key-help.ts's
   *  table and nothing else. */
  extraGroups?: readonly KeyHelpGroup[];
}

/** V4's left column: what acts on the deck and the questions waiting on you.
 *  Every other group, and any a screen adds, is the right column's. */
const LEFT_GROUPS: readonly string[] = ["deck", "question"];
const RIGHT_GROUPS: readonly string[] = ["terminal", "canvas", "panels"];

/** The groups in V4's two columns. A group a screen adds goes where there are
 *  fewer rows, so neither column runs away. */
export function splitColumns(groups: readonly KeyHelpGroup[]): KeyHelpGroup[][] {
  const left: KeyHelpGroup[] = [];
  const right: KeyHelpGroup[] = [];
  const size = (column: KeyHelpGroup[]) => column.reduce((n, g) => n + g.rows.length + 1, 0);
  for (const group of groups) {
    const known = LEFT_GROUPS.includes(group.id) || RIGHT_GROUPS.includes(group.id);
    const toLeft = known ? LEFT_GROUPS.includes(group.id) : size(left) < size(right);
    (toLeft ? left : right).push(group);
  }
  return [left, right].filter(column => column.length > 0);
}

/** A cap as V4's key chips: one chip to a key ("Ctrl + K" is Ctrl and K, a
 *  Mac's "⌘ K" is ⌘ and K); a mouse word stays one chip. */
export function capChips(cap: string): string[] {
  if (cap.includes(" + ")) return cap.split(" + ");
  if (cap.startsWith("⌘ ")) return cap.split(" ");
  return [cap];
}
export default function KeyboardHelp({ onClose, onTour, onSettings, workspace = false, extraGroups }: Props) {
  const t = useT();
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const apple = isApplePlatform(platformName());
  const singleKeys = useSingleKeyShortcuts();
  const integrations = useIntegrations();
  const base = keyHelpFor(singleKeys, kind => kindOffered(integrations, kind), workspace);
  const groups = extraGroups?.length ? [...base, ...extraGroups] : base;

  return (
    <Dialog
      scrim={scrimPress}
      dialogRef={dialogRef}
      className="key-help"
      labelledBy="key-help-title"
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
            <span id="key-help-title" className="modal-tool-name">{t("settings.key.title")}</span>
          </div>
          <div className="modal-actions">
            <DialogClose onClick={onClose} label={t("settings.key.close")} />
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
                {richText(t("settings.key.offText", { title: "{title}", place: "{place}" }), {
                  title: <strong>{t("settings.key.offTitle")}</strong>,
                  place: <span className="kh-place">{t("settings.key.place")}</span>,
                })}
              </p>
              {onSettings && <button type="button" className="btn" onClick={onSettings}>{t("settings.key.openSettings")}</button>}
            </div>
          )}
          {/* The tour's intro line, above the keys; the door itself is the
              footer's link (V4's Figma). */}
          {onTour && <p className="kh-intro">{t("settings.key.tourText")}</p>}
          {/* V4's two columns, the Deck and The question on the left and the
              rest on the right, one row to a shortcut: the action on the left
              and its keys as chips on the right. */}
          <div className="kh-cols">
            {splitColumns(groups).map((column, i) => (
              <div className="kh-col" key={i}>
                {column.map(group => (
                  <section className="kh-block" key={group.id}>
                    <h3 className="kh-group">{group.title}</h3>
                    {group.rows.map(row => (
                      <div className="sc" key={`${group.id}:${row.cap}:${row.action}`}>
                        <span className="kh-action">{row.action}</span>
                        <span className="kh-keys">
                          {capChips(apple && row.macCap ? row.macCap : row.cap).map((chip, n) => <kbd key={n}>{chip}</kbd>)}
                        </span>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ))}
          </div>
        </section>

        <footer className="modal-foot kh-bottom">
          {/* Under the keys, not over them (#852): the reference comes first,
              and what to do when a key does nothing is a footnote to it, with
              where to turn the letters off for whoever opened the sheet
              because they fire when they should not. Not while they are off,
              when Esc is no answer to a letter doing nothing and the note
              above has said why. */}
          {singleKeys && <p className="kh-foot">{t("settings.key.note")} {t("settings.key.switchNote", { place: t("settings.key.place") })}</p>}
          {onTour && <button type="button" className="kh-tour" onClick={onTour}>{t("settings.key.tour")}</button>}
        </footer>
    </Dialog>
  );
}
