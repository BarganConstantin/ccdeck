import { refreshRadarSettings, setRadarEnabled, useRadarSettings } from "../use-radar-settings";

import { SettingRow, SettingsGroup } from "./SettingsParts";

export default function RadarSettings() {
  const { enabled, busy, error } = useRadarSettings();
  return <SettingsGroup id="radar-settings-title" title="Telemetry Radar">
    <SettingRow settingId="radar-enabled" name="Enable Radar" nameId="radar-enabled-label"
      note="Monitors collector traffic automatically in the background. Turning it off stops monitoring and hides Radar from the toolbar."
      noteId="radar-enabled-note" control={
        <button type="button" className="switch" role="switch" aria-checked={enabled === true}
          aria-labelledby="radar-enabled-label" aria-describedby="radar-enabled-note" aria-busy={busy}
          disabled={enabled === null} onClick={() => { if (!busy && enabled !== null) void setRadarEnabled(!enabled); }}>
          <span className="switch-knob" />
        </button>
      } />
    {enabled === null && !error && <p className="tr-note" role="status">Reading Radar settings…</p>}
    {enabled === false && <p className="tr-note" role="status">Radar is off. Enable it here to restore the toolbar icon and background monitoring.</p>}
    {error && <p className="tr-capture-error" role="alert">{error} <button type="button" className="btn" aria-busy={busy} onClick={() => void refreshRadarSettings()}>Retry</button></p>}
  </SettingsGroup>;
}
