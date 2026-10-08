import { useState } from "react";
import { captureSummary, radarStatus, type RadarSnapshot } from "../traffic-radar";
import { useTrafficRadar } from "../use-traffic-radar";

function time(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function TrafficRadar() {
  const [open, setOpen] = useState(false);
  return <section className="sd-section" aria-labelledby="tr-title">
    <h3 id="tr-title" className="tr-heading">
      <button type="button" className="sd-detail" aria-expanded={open} aria-controls="traffic-radar" onClick={() => setOpen(value => !value)}>
        Traffic Radar <span className="tr-readonly">read-only</span>
      </button>
    </h3>
    {!open && <p className="tr-note">Inspect Claude telemetry settings and observed destinations.</p>}
    {open && <RadarReader />}
  </section>;
}

function RadarReader() {
  const { snapshot, failed } = useTrafficRadar();
  return <TrafficRadarView snapshot={snapshot} failed={failed} />;
}

export function TrafficRadarView({ snapshot, failed = false }: { snapshot: RadarSnapshot | null; failed?: boolean }) {
  const variables = snapshot?.config?.variables ?? [];
  const destinations = variables.filter(v => v.key.endsWith("ENDPOINT"));
  const active = snapshot?.connections.filter(c => c.active).length ?? 0;
  const warning = failed || snapshot?.status === "unavailable";
  const captureWarning = variables.some(v => v.key.startsWith("OTEL_LOG_") && v.value.startsWith("Enabled"));
  return <div id="traffic-radar" className="tr-body">
    <p className={`tr-status${warning ? " tr-warning" : ""}`} role="status">{radarStatus(snapshot, failed)}</p>
    <p className="tr-note">A connection is not proof of a telemetry upload. No payloads are inspected.</p>
    {snapshot && snapshot.status !== "unsupported" && <>
      <dl className="tr-facts">
        <div><dt>Claude processes identified</dt><dd>{snapshot.processCount}</dd></div>
        <div><dt>Active connections observed</dt><dd>{warning ? "Unknown" : active}</dd></div>
        <div><dt>Last sample</dt><dd><time dateTime={new Date(snapshot.sampledAt).toISOString()}>{time(snapshot.sampledAt)}</time></dd></div>
        <div><dt>Sampling while open</dt><dd>every 5 seconds</dd></div>
      </dl>
      <p className="tr-note">Native Claude processes only. Node wrappers, short-lived connections, UDP and other apps may be missed. Session environment, project overrides and Enterprise server-side capture are not verified.</p>
      {snapshot.limited && <p className="tr-warning">Only the first 64 identified processes were sampled.</p>}
      <div className="tr-block">
        <h4>Configured telemetry</h4>
        <p className={captureWarning ? "tr-warning" : "tr-note"}>{captureSummary(variables)}</p>
        {destinations.length > 0 ? <ul className="tr-destinations">
          {destinations.map(v => <li key={`${v.source}:${v.key}`}><code>{v.value}</code><span>{v.source} · {v.key}</span></li>)}
        </ul> : <p className="tr-note">No destination found in the sources read. This does not mean telemetry is off.</p>}
        <details className="tr-details">
          <summary>Variables and configuration sources</summary>
          <p className="tr-note">Values below are configuration evidence, not the effective settings of a running session. Endpoint credentials, paths, queries and headers are hidden.</p>
          {variables.length > 0 && <dl className="tr-variables">{variables.map(v => <div key={`${v.source}:${v.key}`}>
            <dt><code>{v.key}</code><span>{v.source}</span></dt><dd>{v.value}</dd>
          </div>)}</dl>}
          <ul className="tr-sources">{snapshot.config?.sources.map(source => <li key={source.name}>
            <span>{source.name}</span><span>{source.status === "read" ? "Read" : source.status === "absent" ? "Not found" : "Unavailable"}</span>
          </li>)}</ul>
          <p className="tr-note">Documented defaults: metrics 60 seconds; logs and traces 5 seconds. Actual intervals may differ.</p>
        </details>
      </div>
      <div className="tr-block">
        <h4>Observed connections</h4>
        {snapshot.connections.length ? <ul className="tr-connections">{snapshot.connections.slice(0, 12).map(connection => <li key={`${connection.pid}:${connection.destination}`}>
          <div className="tr-connection-head"><code>{connection.destination}</code><span>{warning || connection.active === null ? "Unknown" : connection.active ? "Observed now" : "Seen earlier"}</span></div>
          <p className="tr-note">PID <code>{connection.pid}</code> · last seen <time dateTime={new Date(connection.lastSeenAt).toISOString()}>{time(connection.lastSeenAt)}</time></p>
          {connection.workspace && <code className="tr-workspace">{connection.workspace}</code>}
        </li>)}</ul> : <p className="tr-note">{warning ? "Connections could not be determined. Sampling will retry while this panel is open." : "No established TCP connections captured in this sample. Brief transfers between samples may not appear."}</p>}
        {snapshot.connections.length > 12 && <p className="tr-note">Showing the 12 most recently seen connections of {snapshot.connections.length}.</p>}
      </div>
      {snapshot.alerts.length > 0 && <div className="tr-block" role="status" aria-label="Radar changes">
        <h4>Changes while observing</h4>
        <ul className="tr-alerts">{snapshot.alerts.map(alert => <li key={alert.id}><time dateTime={new Date(alert.at).toISOString()}>{time(alert.at)}</time> {alert.message}</li>)}</ul>
      </div>}
      <p className="tr-note tr-foot">Observation metadata stays in server memory, bounded to 100 connections and a 5-minute observation window. On the next sample, history resets after an observation gap longer than 30 seconds. Nothing here changes or blocks Claude telemetry.</p>
    </>}
    {snapshot?.status === "unsupported" && <p className="tr-note">This version cannot inspect Claude connections on {snapshot.platform}. No privacy conclusion can be drawn.</p>}
    {!snapshot && failed && <p className="tr-note">Could not read the radar. Check the ccdeck connection; sampling will retry while this panel is open.</p>}
  </div>;
}
