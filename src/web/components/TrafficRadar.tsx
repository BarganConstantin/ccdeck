import { useState } from "react";
import { captureSummary, radarStatus, type RadarSnapshot } from "../traffic-radar";
import { useTrafficRadar } from "../use-traffic-radar";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { useTelemetryCapture } from "../use-telemetry-capture";
import { TelemetryCapture } from "./TelemetryCapture";

type Connection = RadarSnapshot["connections"][number];
type RadarPage = "telemetry" | "connections" | "history" | "configuration";
const connectionKey = (connection: Connection) => `${connection.pid}:${connection.destination}`;
function Stamp({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString()}</time>;
}

export default function TrafficRadar({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const { snapshot, failed } = useTrafficRadar();
  const captureState = useTelemetryCapture();
  return <div className="modal-backdrop" {...scrimPress} role="presentation">
    <div className="modal tr-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tr-title" onClick={e => e.stopPropagation()}>
      <header className="modal-head">
        <div className="modal-title"><span className="modal-tool-name" id="tr-title">Telemetry Radar</span><span className="modal-tool-id">local telemetry inspection</span></div>
        <button className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
      </header>
      <TrafficRadarView snapshot={snapshot} failed={failed} captureState={captureState} />
    </div>
  </div>;
}

export function TrafficRadarView({ snapshot, failed = false, captureState }: { snapshot: RadarSnapshot | null; failed?: boolean; captureState?: ReturnType<typeof useTelemetryCapture> }) {
  const [page, setPage] = useState<RadarPage>(captureState ? "telemetry" : "connections");
  const [selected, setSelected] = useState<string | null>(null);
  const warning = failed || snapshot?.status === "unavailable";
  const supported = snapshot && snapshot.status !== "unsupported";
  const connections = snapshot?.connections ?? [];
  const rows = page === "connections" ? connections.filter(c => c.active !== false) : connections;
  const chosen = selected ? connections.find(c => connectionKey(c) === selected) : rows[0];
  return <div className="tr-body">
    <div className="tr-overview">
      {page === "telemetry" ? <><p className="tr-status">Inspect telemetry contents</p><p className="tr-note">Choose a collector, activate capture locally, then select an export. Configuration alone cannot prove what was sent.</p></> : <>
      <p className={`tr-status${warning ? " tr-warning" : ""}`} role="status">{radarStatus(snapshot, failed)}</p>
      <p className="tr-note">A connection is not proof of a telemetry upload. Telemetry contents require explicit local capture.</p>
      {supported && <p className="tr-sample">{snapshot.processCount} Claude processes · {warning ? "Unknown" : connections.filter(c => c.active).length} active connections · sampled <Stamp at={snapshot.sampledAt} /> · every 5 seconds while visible</p>}
      </>}
    </div>
    <div className="tr-nav" role="group" aria-label="Radar views">
      {captureState && <button className="btn" aria-pressed={page === "telemetry"} onClick={() => setPage("telemetry")}>Telemetry contents</button>}
      <button className="btn" aria-pressed={page === "connections"} onClick={() => setPage("connections")}>Live connections</button>
      <button className="btn" aria-pressed={page === "history"} onClick={() => setPage("history")}>Observation history</button>
      <button className="btn" aria-pressed={page === "configuration"} onClick={() => setPage("configuration")}>Configuration</button>
    </div>
    {page === "telemetry" && captureState ? <TelemetryCapture {...captureState} radar={snapshot} /> : supported && (page === "configuration" ? <Configuration snapshot={snapshot} /> : <div className="tr-workspace">
      <section className="tr-feed" aria-label={page === "connections" ? "Live connections" : "Observation history"}>
        <h3>{page === "connections" ? "Observed connections" : "Past and current observations"}</h3>
        <p className="tr-note">{page === "connections" ? "Select a destination to inspect its connection." : "Connection observations, not a record of sent requests. Kept in memory during observation."}</p>
        {rows.length ? <ul className="tr-connections">{rows.map(connection => <li key={connectionKey(connection)}>
          <button className="btn tr-row" aria-pressed={chosen && connectionKey(chosen) === connectionKey(connection)} onClick={() => setSelected(connectionKey(connection))}>
            <code>{connection.destination}</code><span>{warning || connection.active === null ? "Unknown" : connection.active ? "Observed now" : "Seen earlier"} · PID {connection.pid}</span>
            <span className="tr-workspace-name">{connection.workspace ?? "Workspace unavailable"}</span>
            <span>last seen <Stamp at={connection.lastSeenAt} /></span>
          </button>
        </li>)}</ul> : <p className="tr-note">{warning ? "Connections could not be determined. Sampling will retry while this panel is open." : "No established TCP connections captured in this sample. Brief transfers between samples may not appear."}</p>}
      </section>
      <section className="tr-inspector" aria-label="Connection details">
        <h3>Connection details</h3>
        {chosen ? <>
          <h4><code>{chosen.destination}</code></h4>
          <dl className="tr-facts">
            <div><dt>Observation</dt><dd>{warning || chosen.active === null ? "Unknown" : chosen.active ? "Observed now" : "Seen earlier"}</dd></div>
            <div><dt>Process</dt><dd>Claude · PID {chosen.pid}</dd></div>
            <div><dt>Workspace</dt><dd>{chosen.workspace ?? "Unavailable"}</dd></div>
            <div><dt>First seen</dt><dd><Stamp at={chosen.firstSeenAt} /></dd></div>
            <div><dt>Last seen</dt><dd><Stamp at={chosen.lastSeenAt} /></dd></div>
          </dl>
          {page === "connections" && chosen.active === false && <p className="tr-note">The selected connection is no longer observed live. Its retained metadata is available in Observation history.</p>}
        </> : <p className="tr-note">{selected ? "The selected observation is no longer retained. Select another connection to inspect it." : "A connection will appear here when one is observed."}</p>}
        <div className="tr-payload"><h4>Payload not captured</h4>
          <p>This radar observes established TCP connections, not requests or their contents. It cannot show what was sent inside this connection.</p>
          <p className="tr-note">Inspecting actual telemetry requires an explicitly configured local capture or access to the existing collector. Earlier payloads cannot be recovered from these observations.</p>
        </div>
        <details className="tr-details"><summary>Coverage and retention</summary>
          <p className="tr-note">Native Claude processes only. Node wrappers, short-lived connections, UDP and other apps may be missed. Session environment, project overrides and Enterprise server-side capture are not verified.</p>
          <p className="tr-note">Observation metadata stays in server memory, bounded to 100 connections and a 5-minute observation window. On the next sample, history resets after an observation gap longer than 30 seconds. Nothing here changes or blocks Claude telemetry.</p>
        </details>
        {snapshot.limited && <p className="tr-warning">Only the first 64 identified processes were sampled.</p>}
      </section>
    </div>)}
    {supported && snapshot.alerts.length > 0 && <details className="tr-changes"><summary>Changes while observing ({snapshot.alerts.length})</summary>
      <ul>{snapshot.alerts.map(alert => <li key={alert.id}><Stamp at={alert.at} /> {alert.message}</li>)}</ul>
    </details>}
    {snapshot?.status === "unsupported" && <p className="tr-empty">This version cannot inspect Claude connections on {snapshot.platform}. No privacy conclusion can be drawn.</p>}
    {!snapshot && <p className="tr-empty">{failed ? "Could not read the radar. Check the ccdeck connection; sampling will retry while this panel is open." : "Reading local telemetry configuration and connection metadata…"}</p>}
  </div>;
}

export function Configuration({ snapshot }: { snapshot: RadarSnapshot }) {
  const variables = snapshot.config?.variables ?? [];
  const destinations = variables.filter(v => v.key.endsWith("ENDPOINT"));
  const captureWarning = variables.some(v => v.key.startsWith("OTEL_LOG_") && v.value.startsWith("Enabled"));
  return <section className="tr-config" aria-label="Telemetry configuration">
    <h3>Configured telemetry</h3>
    <p className={captureWarning ? "tr-warning" : "tr-note"}>{captureSummary(variables)}</p>
    <p className="tr-note">Values below are configuration evidence, not the effective settings of a running session. Endpoint credentials, paths, queries and headers are hidden.</p>
    {destinations.length ? <ul className="tr-destinations">{destinations.map(v => <li key={`${v.source}:${v.key}`}><code>{v.value}</code><span>{v.source} · {v.key}</span></li>)}</ul>
      : <p className="tr-note">No destination found in the sources read. This does not mean telemetry is off.</p>}
    <h4>Variables and configuration sources</h4>
    {variables.length > 0 && <dl className="tr-variables">{variables.map(v => <div key={`${v.source}:${v.key}`}>
      <dt><code>{v.key}</code><span>{v.source}</span></dt><dd>{v.value}</dd>
    </div>)}</dl>}
    <ul className="tr-sources">{snapshot.config?.sources.map(source => <li key={source.name}><span>{source.name}</span><span>{source.status === "read" ? "Read" : source.status === "absent" ? "Not found" : "Unavailable"}</span></li>)}</ul>
    <p className="tr-note">Documented defaults: metrics 60 seconds; logs and traces 5 seconds. Actual intervals may differ.</p>
    <p className="tr-note">Session environment, project overrides and Enterprise server-side capture are not verified.</p>
  </section>;
}
