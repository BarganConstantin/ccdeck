// Settings › Radar: whether the deck watches the telemetry Claude Code sends to
// its collectors (use-radar-settings.ts), and the way into Radar itself.
//
// In the shared shape (SettingsParts.tsx, #2176). The switch is the section's
// master switch, so it stands in an untitled group as Keyboard's and Sounds'
// do. While the deck has not answered yet it is busy, never disabled: a switch
// disabled under focus drops focus to <body> (#518), and the press is refused
// in the handler instead. What the deck says back — still reading, off, could
// not save — is a row of the same list rather than a line in Radar's own type,
// and the door to Radar is a row like General's doors, there only while Radar
// is on, since off it has left the toolbar too.
import { refreshRadarSettings, setRadarEnabled, useRadarSettings } from "../use-radar-settings";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const RADAR_LABEL = "Enable Radar";
export const RADAR_NOTE = "Monitors collector traffic automatically in the background. Turning it off stops monitoring and hides Radar from the toolbar.";

export default function RadarSettings({ onOpen }: { onOpen: () => void }) {
  const { enabled, busy, error } = useRadarSettings();
  return (
    <SettingsGroup>
      <SettingRow
        settingId="radar-enabled"
        name={RADAR_LABEL}
        nameId="radar-enabled-label"
        note={RADAR_NOTE}
        noteId="radar-enabled-note"
        control={
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={enabled === true}
            aria-labelledby="radar-enabled-label"
            aria-describedby="radar-enabled-note"
            aria-busy={busy || enabled === null}
            onClick={() => { if (!busy && enabled !== null) void setRadarEnabled(!enabled); }}
          >
            <span className="switch-knob" />
          </button>
        }
      />
      {enabled === null && !error && <p className="settings-row settings-row-status" role="status">Reading Radar settings…</p>}
      {enabled === false && <p className="settings-row settings-row-status" role="status">Radar is off. Turn it on to bring back the toolbar icon and background monitoring.</p>}
      {enabled === true && (
        // No settingId: drawn only while Radar is on, so search answers
        // "radar" with the switch above it, which is always there.
        <SettingRow
          as="div"
          name="Radar"
          nameId="settings-radar-open-name"
          note="Claude's telemetry configuration and the connections it was seen making."
          control={
            <button
              type="button"
              className="btn"
              id="settings-radar-open"
              aria-labelledby="settings-radar-open settings-radar-open-name"
              aria-haspopup="dialog"
              onClick={onOpen}
            >Open</button>
          }
        />
      )}
      {error && (
        <div className="settings-row" role="alert">
          <span className="settings-row-name">{error}</span>
          <span className="settings-row-control">
            <button type="button" className="btn" aria-busy={busy} onClick={() => void refreshRadarSettings()}>Retry</button>
          </span>
        </div>
      )}
    </SettingsGroup>
  );
}
