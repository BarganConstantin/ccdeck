// Settings › General: how long a finished session stays on the board
// (hide-finished.ts, #2156).
//
// One row in the shared shape (SettingsParts.tsx, #2176), with a native select
// for the control, because the choice is one of five and the platform's own
// list is the one a keyboard, a screen reader and a touch screen already know.
// The note says where a hidden session went and what brings it back, which is
// the question a card that has left the board raises.
import { HIDE_FINISHED_CHOICES, hideFinishedLabel, setHideFinishedAfter } from "../hide-finished";
import { useHideFinishedAfter } from "../use-hide-finished";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const HIDE_FINISHED_LABEL = "Hide finished sessions after";
export const HIDE_FINISHED_NOTE =
  "A finished session leaves the canvas after this long. It stays in the session list (L), and comes back when it starts working again or needs you.";

export default function BoardSection() {
  const minutes = useHideFinishedAfter();
  return (
    <SettingsGroup id="settings-board-caption" title="Board">
      <SettingRow
        settingId="hide-finished"
        name={HIDE_FINISHED_LABEL}
        nameId="settings-hide-finished-label"
        note={HIDE_FINISHED_NOTE}
        noteId="settings-hide-finished-note"
        control={
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
        }
      />
    </SettingsGroup>
  );
}
