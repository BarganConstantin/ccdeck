import { refreshRadarSettings, setRadarEnabled, useRadarSettings } from "../use-radar-settings";

export default function RadarSettings() {
  const { enabled, busy, error } = useRadarSettings();
  return <section className="settings-group" aria-labelledby="radar-settings-title">
    <div className="settings-caption"><h3 id="radar-settings-title">Telemetry Radar</h3></div>
    <div className="appearance-controls"><label className="appearance-row">
      <span className="appearance-row-label" id="radar-enabled-label">Enable Radar</span>
      <button type="button" className="switch" role="switch" aria-checked={enabled === true}
        aria-labelledby="radar-enabled-label" aria-describedby="radar-enabled-note" aria-busy={busy}
        disabled={enabled === null} onClick={() => { if (!busy && enabled !== null) void setRadarEnabled(!enabled); }}>
        <span className="switch-knob" />
      </button>
      <span className="appearance-row-note" id="radar-enabled-note">Monitors collector traffic automatically in the background. Turning it off stops monitoring and hides Radar from the toolbar.</span>
    </label></div>
    {enabled === null && !error && <p className="tr-note" role="status">Reading Radar settings…</p>}
    {enabled === false && <p className="tr-note" role="status">Radar is off. Enable it here to restore the toolbar icon and background monitoring.</p>}
    {error && <p className="tr-capture-error" role="alert">{error} <button type="button" className="btn" aria-busy={busy} onClick={() => void refreshRadarSettings()}>Retry</button></p>}
  </section>;
}
