// Settings › General, under the theme: whether the deck answers its single-key
// shortcuts (single-key-shortcuts.ts, WCAG 2.1.4).
//
// Drawn as the Character switch in Music & character is — a caption, then one
// <label> row with the switch on the name's line and the note under both — so
// General's second group sits on the grid its neighbours do. The note says
// which keys it covers — letters, `?` and Space, every one the switch silences
// — and who would want them off; Cmd/Ctrl+, and Esc are not mentioned because
// nothing about them changes.

interface Props {
  singleKeys: boolean;
  onToggleSingleKeys: () => void;
}

export const SINGLE_KEYS_LABEL = "Single-key shortcuts";
export const SINGLE_KEYS_NOTE =
  "Keys like L, U, M, ? and Space open panels and toggle things. Turn this off if you use voice control or press them by accident.";

export default function KeyboardSection({ singleKeys, onToggleSingleKeys }: Props) {
  return (
    <section className="settings-group" aria-labelledby="settings-keyboard-caption">
      <div className="settings-caption">
        <h3 id="settings-keyboard-caption">Keyboard</h3>
      </div>
      <div className="appearance-controls">
        <label className="appearance-row">
          <span className="appearance-row-label" id="settings-single-keys-label">{SINGLE_KEYS_LABEL}</span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={singleKeys}
            aria-labelledby="settings-single-keys-label"
            aria-describedby="settings-single-keys-note"
            onClick={onToggleSingleKeys}
          >
            <span className="switch-knob" />
          </button>
          <span id="settings-single-keys-note" className="appearance-row-note">{SINGLE_KEYS_NOTE}</span>
        </label>
      </div>
    </section>
  );
}
