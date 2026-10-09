import { useState } from "react";
import type { RadarSnapshot } from "../traffic-radar";
import { configuredDestinations, configuredState, observedDestinations, type RadarSession } from "../telemetry-inspection";
import { useTrafficRadar } from "../use-traffic-radar";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { useTelemetryCapture } from "../use-telemetry-capture";
import { TelemetryCapture } from "./TelemetryCapture";
import { TelemetryFile } from "./TelemetryFile";

export default function TrafficRadar({ onClose, sessions = [] }: { onClose: () => void; sessions?: RadarSession[] }) {
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const { snapshot, failed } = useTrafficRadar();
  const captureState = useTelemetryCapture();
  return <div className="modal-backdrop" {...scrimPress} role="presentation">
    <div className="modal tr-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tr-title" onClick={e => e.stopPropagation()}>
      <header className="modal-head">
        <div className="modal-title"><span className="modal-tool-name" id="tr-title">Telemetry Radar</span></div>
        <button className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
      </header>
      <TrafficRadarView snapshot={snapshot} failed={failed} captureState={captureState} sessions={sessions} />
    </div>
  </div>;
}

export function TrafficRadarView({ snapshot, failed = false, captureState, sessions = [] }: {
  snapshot: RadarSnapshot | null; failed?: boolean; captureState?: ReturnType<typeof useTelemetryCapture>; sessions?: RadarSession[];
}) {
  const [page, setPage] = useState<"monitor" | "configuration" | "file">("monitor");
  const [fileSessions, setFileSessions] = useState<string[]>([]);
  const [session, setSession] = useState("all");
  const variables = snapshot?.config?.variables ?? [];
  const destinations = configuredDestinations(variables);
  const state = configuredState(variables);
  const observed = failed ? [] : observedDestinations(snapshot);
  const choices = new Map(sessions.map(s => [s.id, s.label]));
  for (const event of captureState?.capture?.events ?? []) for (const id of event.sessionIds ?? []) if (!choices.has(id)) choices.set(id, id.slice(0, 8));
  for (const id of fileSessions) if (!choices.has(id)) choices.set(id, id.slice(0, 8));
  return <div className="tr-body">
    <div className="tr-summary">
      <div className="tr-summary-state"><span className={`tr-state ${failed || !snapshot ? "tr-tone-unknown" : state === "Enabled in settings" ? "tr-tone-enabled" : "tr-tone-unknown"}`}>{failed ? "Configuration unavailable" : !snapshot ? "Reading settings…" : state === "Unknown" ? "Configuration unknown" : state}</span>
        <span className="tr-note">{destinations.length ? `${destinations.length} configured destination${destinations.length === 1 ? "" : "s"}` : "No destination found in the settings files read. Telemetry may still be running."}</span></div>
      {destinations.length > 0 && <div className="tr-endpoints">{destinations.map(destination => <code key={destination}>{destination}</code>)}</div>}
      {!destinations.length && observed.length > 0 && <div className="tr-observed-summary"><span className="tr-state">Claude connections observed</span><div className="tr-endpoints">{observed.map(address => <code key={address}>{address}</code>)}</div><p className="tr-note">These are active connections, not confirmed telemetry messages. Choose an observed address below to inspect its traffic.</p></div>}
    </div>
    <div className="tr-navigation">
      <div className="tr-tabs" role="tablist" aria-label="Radar views">{([['monitor', 'Monitor'], ['configuration', 'Configuration'], ['file', 'File']] as const).map(([id, label]) =>
        <button key={id} id={`tr-tab-${id}`} role="tab" aria-selected={page === id} aria-controls={`tr-panel-${id}`} tabIndex={page === id ? 0 : -1} onClick={() => setPage(id)} onKeyDown={e => {
          const ids = ['monitor', 'configuration', 'file'] as const;
          const at = ids.indexOf(id);
          const next = e.key === 'ArrowRight' ? ids[(at + 1) % 3] : e.key === 'ArrowLeft' ? ids[(at + 2) % 3] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[2] : null;
          if (next) { e.preventDefault(); setPage(next); document.getElementById(`tr-tab-${next}`)?.focus(); }
        }}>{label}</button>)}</div>
      <label className="tr-session-filter">Session<select className="tr-select" value={session} onChange={e => setSession(e.target.value)} aria-label="Session">
        <option value="all">All sessions</option>{[...choices].map(([id, label]) => <option key={id} value={id}>{label} · {id.slice(0, 8)}</option>)}<option value="unidentified">Unidentified session</option>
      </select></label>
    </div>
    {/* Keep views mounted: selecting Configuration must not discard the selected message or imported file. */}
    <div className="tr-page" id="tr-panel-monitor" role="tabpanel" aria-labelledby="tr-tab-monitor" hidden={page !== "monitor"}>
      {captureState ? <TelemetryCapture {...captureState} radar={failed && snapshot ? { ...snapshot, status: "unavailable" } : snapshot} sessionFilter={session} sessions={sessions} /> : <p className="tr-empty">Reading monitor status…</p>}
    </div>
    <div className="tr-page" id="tr-panel-configuration" role="tabpanel" aria-labelledby="tr-tab-configuration" hidden={page !== "configuration"}>
      {snapshot ? <Configuration snapshot={snapshot} stale={failed} sessionLabel={session === "all" ? undefined : choices.get(session) ?? session} /> : <p className="tr-empty">{failed ? "Could not read settings. Sampling will retry." : "Reading local settings…"}</p>}
    </div>
    <div className="tr-page" id="tr-panel-file" role="tabpanel" aria-labelledby="tr-tab-file" hidden={page !== "file"}><TelemetryFile onSessions={setFileSessions} sessionFilter={session} /></div>
  </div>;
}

export function Configuration({ snapshot, sessionLabel, stale = false }: { snapshot: RadarSnapshot; sessionLabel?: string; stale?: boolean }) {
  const variables = snapshot.config?.variables ?? [];
  const destinations = variables.filter(v => v.key.endsWith("ENDPOINT"));
  const flags = variables.filter(v => v.key.startsWith("OTEL_LOG_") || v.key.includes("ENABLE") || v.key.includes("TELEMETRY_BETA"));
  const names: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: "Telemetry", OTEL_LOG_USER_PROMPTS: "Your prompts", OTEL_LOG_ASSISTANT_RESPONSES: "Claude responses", OTEL_LOG_TOOL_DETAILS: "Tool details", OTEL_LOG_TOOL_CONTENT: "Tool contents", OTEL_LOG_RAW_API_BODIES: "Full API bodies", OTEL_LOG_MANAGED_SETTINGS: "Managed settings", CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "Enhanced telemetry", ENABLE_ENHANCED_TELEMETRY_BETA: "Enhanced telemetry" };
  return <section className="tr-config" aria-label="Telemetry configuration">
    <h3>What Claude is configured to send</h3>
    {stale && <p className="tr-warning" role="status">Last successfully read settings. Current configuration could not be verified.</p>}
    <p className="tr-note">Read from local Claude settings. The effective environment of a running session is not verified.</p>
    {sessionLabel && <p className="tr-note">Selected session: {sessionLabel}. These shared settings are evidence; this session’s runtime values are unverified.</p>}
    <h4>Destinations</h4>
    {destinations.length ? <ul className="tr-destinations">{destinations.map(v => <li key={`${v.source}:${v.key}`}><code>{v.value}</code><span>{v.source} · {v.key}</span></li>)}</ul> : <p className="tr-note">No destination found in the sources read. This does not mean telemetry is off.</p>}
    {!destinations.length && snapshot.connections.length > 0 && <><h4>Observed Claude connections</h4><ul className="tr-live-connections">{snapshot.connections.map(c => <li key={`${c.pid}:${c.destination}`}><code>{c.destination}</code><span>{stale || c.active === null ? "Visibility unavailable" : c.active ? "Active connection" : "Previously observed"} · PID {c.pid} · {c.workspace ?? "Workspace unknown"}</span></li>)}</ul><p className="tr-note">A running process can keep previously loaded settings after a settings file disappears. Connections alone do not identify telemetry or prove a message was sent.</p></>}
    <h4>Telemetry and content</h4>
    {flags.length ? <dl className="tr-variables">{flags.map(v => <div key={`${v.source}:${v.key}`}>
      <dt><strong>{names[v.key] ?? v.key}</strong><code>{v.key}</code><span>{v.source}</span></dt><dd><span className={`tr-state ${v.value.startsWith("Enabled") ? "tr-tone-enabled" : "tr-tone-unknown"}`}>{v.value}</span>{v.rawValue !== undefined && <code className="tr-raw-flag">{v.rawValue}</code>}</dd>
    </div>)}</dl> : <p className="tr-note">No telemetry flags found in the settings read.</p>}
    <details className="tr-details"><summary>All variables and sources</summary>
      <dl className="tr-variables">{variables.map(v => <div key={`${v.source}:${v.key}`}><dt><code>{v.key}</code><span>{v.source}</span></dt><dd>{v.value}</dd></div>)}</dl>
      <ul className="tr-sources">{snapshot.config?.sources.map(source => <li key={source.name}><span>{source.name}</span><span>{source.status === "read" ? "Read" : source.status === "absent" ? "Not found" : "Unavailable"}</span></li>)}</ul>
      <p className="tr-note">Endpoint credentials and headers are hidden. Settings can differ from an already running process.</p>
    </details>
  </section>;
}
