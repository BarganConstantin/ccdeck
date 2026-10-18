// Settings › General: how long a finished session stays on the board
// (hide-finished.ts, #2156).
//
// Drawn as Keyboard's row is — a caption, then one <label> row with the control
// on the name's line and the note under both — with a native select for the
// control, because the choice is one of five and the platform's own list is
// the one a keyboard, a screen reader and a touch screen already know. The note
// says where a hidden session went and what brings it back, which is the
// question a card that has left the board raises.
import { HIDE_FINISHED_CHOICES, hideFinishedLabel, setHideFinishedAfter } from "../hide-finished";
import { useHideFinishedAfter } from "../use-hide-finished";

export const HIDE_FINISHED_LABEL = "Hide finished sessions after";
export const HIDE_FINISHED_NOTE =
  "A finished session leaves the canvas after this long. It stays in the session list (L), and comes back when it starts working again or needs you.";

export default function BoardSection() {
  const minutes = useHideFinishedAfter();
  return (
    <section className="settings-group" aria-labelledby="settings-board-caption">
      <div className="settings-caption">
        <h3 id="settings-board-caption">Board</h3>
      </div>
      <div className="appearance-controls">
        <label className="appearance-row">
          <span className="appearance-row-label" id="settings-hide-finished-label">{HIDE_FINISHED_LABEL}</span>
          <select
            className="sm-select"
            value={minutes}
            aria-labelledby="settings-hide-finished-label"
            aria-describedby="settings-hide-finished-note"
            onChange={event => setHideFinishedAfter(Number(event.target.value))}
          >
            {HIDE_FINISHED_CHOICES.map(choice => (
              <option key={choice} value={choice}>{hideFinishedLabel(choice)}</option>
            ))}
          </select>
          <span id="settings-hide-finished-note" className="appearance-row-note">{HIDE_FINISHED_NOTE}</span>
        </label>
      </div>
    </section>
  );
}
