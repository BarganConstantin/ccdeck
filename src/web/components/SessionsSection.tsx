// Settings › General › Sessions: what happens to sessions on their own, in one
// group as V4 draws it — how long a finished session stays on the board
// (hide-finished.ts, #2156), then the sessions that come back after a restart,
// Claude's before Codex's (SessionRecoverySettings.tsx, handed in as children
// because which of them a deck draws is the dialog's to say).
//
// The hide row is in the shared shape (SettingsParts.tsx, #2176), with a native
// select for the control, because the choice is one of five and the platform's
// own list is the one a keyboard, a screen reader and a touch screen already
// know. The note says where a hidden session went, which is the question a
// card that has left the board raises.
import type { ReactNode } from "react";
import { HIDE_FINISHED_CHOICES, setHideFinishedAfter } from "../hide-finished";
import { useHideFinishedAfter } from "../use-hide-finished";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import SelectShell from "./SelectShell";
import { useT } from "../i18n";

export const HIDE_FINISHED_LABEL = "Hide finished sessions after";
export const HIDE_FINISHED_NOTE =
  "A finished session leaves the canvas after this long. It stays in the session list (L), and comes back when it starts working again or needs you.";

export default function SessionsSection({ children }: { children?: ReactNode }) {
  const t = useT();
  const minutes = useHideFinishedAfter();
  return (
    <SettingsGroup id="settings-sessions-caption" title={t("settings.sessions.group")}>
      <SettingRow
        settingId="hide-finished"
        name={t("settings.board.hideLabel")}
        nameId="settings-hide-finished-label"
        note={t("settings.board.hideNote")}
        details={t("settings.board.hideDetails")}
        noteId="settings-hide-finished-note"
        control={
          <SelectShell>
            <select
              className="sm-select"
              value={minutes}
              aria-labelledby="settings-hide-finished-label"
              aria-describedby="settings-hide-finished-note"
              onChange={event => setHideFinishedAfter(Number(event.target.value))}
            >
              {HIDE_FINISHED_CHOICES.map(choice => (
                <option key={choice} value={choice}>{choice === 0 ? t("settings.board.never") : t("settings.board.minutes", { n: choice })}</option>
              ))}
            </select>
          </SelectShell>
        }
      />
      {children}
    </SettingsGroup>
  );
}
