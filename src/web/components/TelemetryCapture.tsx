import { RadarIcon } from "./RadarIcon";
import { RadarSelect } from "./RadarSelect";
import { useEffect, useRef, useState } from "react";
import { JsonInspector } from "./JsonInspector";
import { radarMonitorState } from "../radar-monitor-state";
import { armedPress, pressState } from "../panel-press";
import type { RadarSnapshot } from "../traffic-radar";
import { captureAddress, configuredDestinations, observedDestinations, type RadarSession } from "../telemetry-inspection";
import type { CaptureAction, CaptureSnapshot, CapturedExport } from "../use-telemetry-capture";

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
const obj = (v: Json | undefined): Obj => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const arr = (v: Json | undefined): Json[] => Array.isArray(v) ? v : [];
const stamp = (at: number) => new Date(at).toLocaleTimeString();
export const outcomeLabel = (event: CapturedExport) => ({ unconfirmed: "Transfer observed · receipt unconfirmed", accepted: "Collector accepted", partial: "Collector reported partial success", rejected: "Collector rejected", unknown: "Response incomplete", reset: "Stream reset" })[event.outcome];
const issueText: Record<string, string> = {
  encrypted: "Encrypted traffic observed; contents cannot be read.",
  joined_midstream: "Capture joined an existing connection. Waiting for a new HTTP/2 connection to decode it reliably.",
  capture_gap: "Incomplete packets or a gap were observed. Affected contents are not shown as decoded.",
  decode_failed: "Some payloads could not be decoded. They are not shown as verified events.",
  payload_limit: "A payload exceeded the inspection limit and was omitted.",
  stream_limit: "A stream exceeded the inspection limit.",
  connection_limit: "The connection inspection limit was reached.",
  unsupported_compression: "A compression format other than gzip was observed.",
  unsupported_link: "This network capture format is not supported.",
  unsupported_network: "Some packets used a network protocol this decoder does not support.",
  fragmented: "Fragmented IP packets cannot be decoded in this version.",
  unknown_export: "A request could not be identified as an OTLP export.",
  connection_closed: "An HTTP/2 connection closed.",
  idle_connection: "An idle connection was removed from the decoder.",
};
function readAny(value: Json | undefined): Json {
  const v = obj(value);
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue", "bytesValue"]) if (v[key] !== undefined) return v[key];
  if (v.arrayValue) return arr(obj(v.arrayValue).values).map(readAny);
  if (v.kvlistValue) return Object.fromEntries(arr(obj(v.kvlistValue).values).map(a => { const v = obj(a); return [String(v.key), readAny(v.value)]; }));
  return null;
}
function explanation(key: string) {
  if (/prompt/i.test(key)) return "Prompt-related field included in this export.";
  if (/response|completion/i.test(key)) return "Response-related field included in this export.";
  if (/tool/i.test(key)) return "Tool-related field included in this export.";
  if (/session/i.test(key)) return "Session identifier or session metadata.";
  if (/user|email|account/i.test(key)) return "User or account metadata.";
  if (/token|cost|duration|latency/i.test(key)) return "Usage or timing measurement.";
  return "Attribute included in this export.";
}
function Value({ value }: { value: Json }) {
  return <pre className="tr-value">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}
function Attributes({ value }: { value: Json | undefined }) {
  return <dl className="tr-attributes">{arr(value).map((a, index) => { const v = obj(a); return <div key={index}>
    <dt><code>{String(v.key ?? "Unnamed attribute")}</code><span>{explanation(String(v.key))}</span></dt>
    <dd><Value value={readAny(v.value)} /></dd>
  </div>; })}</dl>;
}
function Measurement({ record }: { record: Obj }) {
  const kind = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"].find(key => record[key]);
  if (!kind) return null;
  return <div>
    {record.description && <p className="tr-note">{String(record.description)}</p>}
    {arr(obj(record[kind]).dataPoints).map((p, index) => { const point = obj(p); return <section key={index}>
      <dl className="tr-facts">
        <div><dt>Measurement</dt><dd>{kind}</dd></div>
        {point.asInt !== undefined || point.asDouble !== undefined ? <div><dt>Value</dt><dd><code>{String(point.asInt ?? point.asDouble)} {String(record.unit ?? "")}</code></dd></div> : null}
        {point.count !== undefined && <div><dt>Count</dt><dd><code>{String(point.count)}</code></dd></div>}
        {point.sum !== undefined && <div><dt>Sum</dt><dd><code>{String(point.sum)} {String(record.unit ?? "")}</code></dd></div>}
      </dl>
      <Attributes value={point.attributes} />
      <details className="tr-details"><summary>All measurement fields</summary><Value value={point} /></details>
    </section>; })}
  </div>;
}
function SpanTiming({ record }: { record: Obj }) {
  let duration: string | null = null;
  try { duration = `${Number(BigInt(String(record.endTimeUnixNano)) - BigInt(String(record.startTimeUnixNano))) / 1e6} ms`; } catch { duration = null; }
  return <dl className="tr-facts">
    <div><dt>Duration</dt><dd>{duration ?? "Not included"}</dd></div>
    {record.kind && <div><dt>Span kind</dt><dd>{String(record.kind)}</dd></div>}
    {record.status && <div><dt>Span status</dt><dd><Value value={record.status} /></dd></div>}
  </dl>;
}
export function DecodedPayload({ payload, signal }: { payload: Obj; signal: CapturedExport["signal"] }) {
  const group = signal === "traces" ? "Spans" : signal === "logs" ? "Logs" : "Metrics";
  const item = signal === "traces" ? "spans" : signal === "logs" ? "logRecords" : "metrics";
  return <div className="tr-decoded">{arr(payload["resource" + group]).map((r, index) => {
    const resource = obj(r);
    return <section key={index}>
      <details className="tr-details"><summary>Resource metadata</summary><Attributes value={obj(resource.resource).attributes} /></details>
      {arr(resource["scope" + group]).map((s, scopeIndex) => { const scope = obj(s); return <div key={scopeIndex}>
        {scope.scope && <p className="tr-note">Instrumentation: {String(obj(scope.scope).name ?? "Unnamed")} {String(obj(scope.scope).version ?? "")}</p>}
        {arr(scope[item]).map((v, recordIndex) => { const record = obj(v); return <article className="tr-record" key={recordIndex}>
          <h4>{String(record.eventName ?? record.name ?? `${signal === "logs" ? "Log record" : "Record"} ${recordIndex + 1}`)}</h4>
          {record.body && <><p className="tr-note">Event body</p><Value value={readAny(record.body)} /></>}
          {signal === "metrics" && <Measurement record={record} />}
          {signal === "traces" && <SpanTiming record={record} />}
          {record.attributes && <Attributes value={record.attributes} />}
          <details className="tr-details"><summary>All record fields</summary><Value value={record} /></details>
        </article>; })}
      </div>; })}
    </section>;
  })}

  </div>;
}
export function TelemetryCapture({ capture, radar, failed, busy, pendingAction = null, error, command, commands = [], action, sessionFilter = "all", sessions = [] }: {
  capture: CaptureSnapshot | null; radar: RadarSnapshot | null; failed: boolean; busy: boolean; pendingAction?: CaptureAction | null; error: string; command: string;
  commands?: { destination: string; command: string }[];
  action: (kind: CaptureAction, destination?: string | string[]) => Promise<void>;
  sessionFilter?: string; sessions?: RadarSession[];
}) {
  const configured = configuredDestinations(radar?.config?.variables ?? []);
  const addresses = [...new Set(configured.map(captureAddress).filter((v): v is string => !!v))];
  const observed = observedDestinations(radar).filter(address => !addresses.includes(address) && captureAddress(`http://${address}`));
  const [destination, setDestination] = useState("all");
  const [custom, setCustom] = useState("");
  const [selectedObservation, setSelectedObservation] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [messageDestination, setMessageDestination] = useState("all");
  const [filter, setFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(100);
  const [pausedObservationIds, setPausedObservationIds] = useState<number[] | null>(null);
  const [paused, setPaused] = useState<CapturedExport[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const clearArmedAt = useRef(0);
  const [view, setView] = useState<"summary" | "json">("summary");
  const [detail, setDetail] = useState<{ id: number; payload?: Obj; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const inspector = useRef<HTMLElement | null>(null);
  const retained = capture?.events ?? [];
  const retainedById = new Map(retained.map(event => [event.id, event]));
  const events = paused ? paused.map(event => retainedById.get(event.id)).filter((event): event is CapturedExport => !!event) : retained;
  const rows = events.filter(e => (filter === "all" || e.signal === filter) && (messageDestination === "all" || messageDestination === e.destination) &&
    (sessionFilter === "all" || (sessionFilter === "unidentified" ? !e.sessionIds?.length : e.sessionIds?.includes(sessionFilter))));
  const observations = (capture?.observations ?? []).filter(e => (pausedObservationIds === null || pausedObservationIds.includes(e.id)) && filter === "all" && (sessionFilter === "all" || sessionFilter === "unidentified") && (messageDestination === "all" || messageDestination === e.destination));
  const observation = observations.find(e => e.id === selectedObservation);
  const chosen = selectedObservation !== null ? undefined : selected === null ? rows[0] : rows.find(e => e.id === selected);
  const activity = [
    ...rows.map(event => ({ kind: "export" as const, event })),
    ...observations.map(event => ({ kind: "observation" as const, event })),
  ].sort((a, b) => b.event.at - a.event.at || b.event.id - a.event.id);
  const pausedIds = new Set(paused?.map(event => event.id));
  const pausedConnections = new Set(pausedObservationIds);
  const newCount = paused === null ? 0 : retained.filter(event => !pausedIds.has(event.id)).length +
    (capture?.observations ?? []).filter(event => !pausedConnections.has(event.id)).length;
  const id = chosen?.id;
  useEffect(() => { setSelected(null); setSelectedObservation(null); setVisibleCount(100); }, [sessionFilter, filter, messageDestination]);
  useEffect(() => {
    // Pin the initial selection once, rather than switching it on every poll.
    if (selected !== null || selectedObservation !== null) return;
    if (rows.length) setSelected(rows[0].id);
    else if (observations.length) setSelectedObservation(observations[0].id);
  }, [rows[0]?.id, observations[0]?.id, selected, selectedObservation]);
  useEffect(() => {
    setDetail(null); setCopied(null);
    if (id === undefined) return;
    const controller = new AbortController();
    let alive = true;
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch(`/api/system/traffic-radar/capture/event?id=${id}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("This message has expired. Select a newer message.");
      const data = await response.json();
      if (alive && !controller.signal.aborted) setDetail({ id, payload: data.payload });
    }).catch(value => { if (alive) setDetail({ id, error: controller.signal.aborted ? "Loading timed out. Try again." : value instanceof Error ? value.message : "Could not read this message." }); })
      .finally(() => clearTimeout(timeout));
    return () => { alive = false; clearTimeout(timeout); controller.abort(); };
  }, [id, selectedObservation, retry]);
  useEffect(() => {
    if (!copied || copied === "failed") return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [clearArmed]);
  const shell = capture?.shell ?? (radar?.platform === "win32" ? "PowerShell" : "Terminal");
  const windows = shell === "PowerShell";
  const monitor = radarMonitorState(capture, failed);
  const running = monitor.enabled;
  const managed = !!capture?.managed;
  const permissionNeeded = managed && monitor.permission;
  const active = monitor.active;
  const sourceCount = capture?.sources?.length ?? 1;
  const state = monitor.title;
  const pressProps = (kind: CaptureAction) => {
    const state = pressState(pendingAction ?? (busy ? "capture" : null), kind);
    return { disabled: state.disabled, "aria-busy": state.busy };
  };
  const inspect = (event: CapturedExport) => {
    setSelectedObservation(null); setSelected(event.id);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches) {
      inspector.current?.focus({ preventScroll: true }); inspector.current?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  };
  const clearHistory = () => {
    const now = Date.now();
    const decision = armedPress({ armedFor: clearArmed ? "history" : null, target: "history", armedAt: clearArmedAt.current, now, gapMs: 350 });
    if (decision === "arm") { clearArmedAt.current = now; setClearArmed(true); return; }
    if (decision === "ignore") return;
    setClearArmed(false); setSelected(null); setSelectedObservation(null); setPaused(null); setPausedObservationIds(null);
    void action("clear");
  };
  const prepare = () => {
    setCopied(null); setPaused(null); setPausedObservationIds(null); setSelected(null); setSelectedObservation(null);
    const targets = destination === "custom" ? [custom.trim()] : destination === "all" ? addresses : [destination];
    void action("prepare", targets.length ? targets : capture?.sources?.map(s => s.destination) ?? (capture?.destination ? [capture.destination] : []));
  };
  const activationCommands = commands.length ? commands : command ? [{ destination: capture?.destination ?? "Collector", command }] : [];
  const copy = async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); } catch { setCopied("failed"); }
  };
  const sessionName = (ids: string[] = []) => ids.length ? ids.map(id => `${sessions.find(s => s.id === id)?.label ?? "Session"} · ${id.slice(0, 8)}`).join(", ") : "Unidentified session";
  const liveAddresses = new Set([...(capture?.sources?.map(s => s.destination) ?? []), ...addresses]);
  const connections = radar?.status === "observing" ? radar.connections.filter(c => c.active && liveAddresses.has(c.destination)) : [];
  return <div className="tr-telemetry">
    <div className="tr-capture-bar">
      <div><h3 role="status" aria-live="polite"><span className={`tr-live-dot tr-dot-${monitor.tone}`} />{state}</h3>
        <p className="tr-note">{failed ? "Showing the last successful read. Reconnecting automatically." : running ? active ? `${active} of ${sourceCount} destination${sourceCount === 1 ? "" : "s"} listening · ${monitor.traffic ? "Traffic observed" : "No traffic observed yet"}` : "Monitoring is enabled; the listener is not ready yet." : "Start Radar to inspect new collector traffic. Claude settings stay unchanged."}</p>
        {running && <div className="tr-active-destinations" aria-label="Monitored destinations"><span>Destination{sourceCount > 1 ? "s" : ""}</span>{capture?.sources?.length ? capture.sources.map(source => <span className="tr-destination-entry" key={source.destination}><code>{source.destination}</code>{(sourceCount > 1 || !source.active) && <span className={source.active ? "tr-source-ready" : "tr-source-pending"}>{source.active ? "Listening" : "Not listening"}</span>}{!source.active && source.error && <span className="tr-source-error">{source.error}</span>}</span>) : capture?.destination && <code>{capture.destination}</code>}</div>}
      </div>
      <div className="tr-capture-actions">
        {running ? <button className="btn" {...pressProps("stop")} onClick={() => void action("stop")}>Stop monitoring</button>
          : <button className="btn primary tr-start" {...pressProps("prepare")} disabled={pressProps("prepare").disabled || !capture || failed || radar?.status === "unsupported" || (destination === "all" && !addresses.length) || (destination === "custom" && !custom.trim())} onClick={prepare}>{pendingAction === "prepare" ? "Starting…" : "Start monitoring"}</button>}
        <button className={clearArmed ? "btn danger armed" : "btn"} {...pressProps("clear")} disabled={pressProps("clear").disabled || (!capture?.events.length && !capture?.observations?.length)} title={clearArmed ? "Remove decoded messages and observations. Monitoring continues." : "Clear retained messages and connection observations"} onBlur={() => setClearArmed(false)} onClick={clearHistory}>{clearArmed ? "Confirm clear history" : "Clear history"}</button>
      </div>
    </div>

    {!running && <div className="tr-destination">
      <label>Destination<RadarSelect aria-label="Capture destination" value={destination} onChange={e => setDestination(e.target.value)}><option value="all">All configured IPv4 destinations ({addresses.length})</option>{addresses.map(address => <option key={address} value={address}>{address}</option>)}{observed.length > 0 && <optgroup label="Observed Claude connections · telemetry unverified">{observed.map(address => <option key={address} value={address}>{address} · observed</option>)}</optgroup>}<option value="custom">Another IPv4 address…</option></RadarSelect></label>
      {destination === "custom" && <input className="tr-input" aria-label="Collector IPv4 and port" value={custom} onChange={e => setCustom(e.target.value)} placeholder="192.168.1.10:4317" />}
      {!addresses.length && destination === "all" && <span className="tr-note">{observed.length ? "Choose an observed connection or enter your collector address." : "Enter your collector address to monitor traffic. Missing settings do not mean telemetry is off."}</span>}
    </div>}
    {radar?.status === "unsupported" && <p className="tr-capture-error" role="status">Live capture is available on macOS, Linux and Windows. You can still inspect a local file.</p>}
    {error && <p className="tr-capture-error" role="alert">{error}{windows && error.includes("Npcap") && <> <a href="https://www.wireshark.org/download.html" target="_blank" rel="noreferrer">Get Wireshark</a></>}</p>}
    {!managed && running && !activationCommands.length && capture?.state === "awaiting" && <div className="tr-activation"><p>Activation is pending. Generate the Terminal instructions again to continue.</p><button className="btn" {...pressProps("prepare")} onClick={prepare}>Show activation instructions</button><p className="tr-note">The previous token will be invalidated.</p></div>}
    {!managed && activationCommands.length > 0 && running && <details className="tr-activation" open={!active}><summary>Activate in {shell}{sourceCount > 1 ? ` · ${active}/${sourceCount} listening` : ""}</summary>
      <p>{windows ? "Run each command in a separate PowerShell tab. Wireshark with Npcap is required; use an administrator tab if Npcap restricts capture." : "Run each command in a separate Terminal tab. Only tcpdump asks for administrator permission."}</p>
      {activationCommands.map(entry => <div className="tr-command-entry" key={entry.destination}><div><code>{entry.destination}</code><button className="btn" onClick={() => void copy(entry.command, entry.destination)}>{copied === entry.destination ? "Copied" : "Copy command"}</button></div><pre className="tr-command">{entry.command}</pre></div>)}
      <p className="tr-note">Press Ctrl+C in each {shell} tab to stop capture. Monitoring continues until you stop it. Commands contain a local token; do not share them.</p>
    </details>}
    {permissionNeeded && <div className="tr-activation" role="status"><strong>Allow packet capture once</strong>
      <p className="tr-note">{windows ? "Npcap is restricting access. Allow this user to capture traffic in Npcap setup." : capture?.platform === "darwin" ? "Install Wireshark’s ChmodBPF permission helper to allow capture without a Terminal command." : "Grant tcpdump packet capture permissions for this user."} ccdeck retries automatically when access is available.</p>
      <a href="https://wiki.wireshark.org/CaptureSetup/CapturePrivileges" target="_blank" rel="noreferrer">Capture permission setup</a>
    </div>}
    {copied === "failed" && <p className="tr-capture-error" role="alert">Clipboard unavailable. Select the text and copy it manually.</p>}

    <div className="tr-workspace">
      <section className="tr-feed" aria-label="Collector activity">
        <div className="tr-feed-head"><h3>Activity <span className="tr-count">{activity.length}</span></h3><button className="btn" aria-pressed={paused !== null} title={paused ? "Show new entries received while the list was paused" : "Freeze the list while monitoring continues"} disabled={!events.length && !observations.length && paused === null} onClick={() => { setPaused(paused ? null : [...events]); setPausedObservationIds(paused ? null : (capture?.observations ?? []).map(entry => entry.id)); }}>{paused ? "Resume list" : "Pause list"}</button></div>
        <p className="tr-history">Last 24 hours · {rows.length} decoded {rows.length === 1 ? "message" : "messages"} · {observations.length} {observations.length === 1 ? "observation" : "observations"}</p>
        <div className="tr-filter"><label>Type<RadarSelect aria-label="Message type" value={filter} onChange={e => { setSelected(null); setFilter(e.target.value); }}><option value="all">All types</option><option value="logs">Events</option><option value="metrics">Metrics</option><option value="traces">Traces</option></RadarSelect></label><label>To<RadarSelect aria-label="Message destination" value={messageDestination} onChange={e => { setSelected(null); setMessageDestination(e.target.value); }}><option value="all">All destinations</option>{[...new Set([...addresses, ...(capture?.sources?.map(s => s.destination) ?? []), ...retained.map(e => e.destination), ...(capture?.observations ?? []).map(e => e.destination)])].map(address => <option key={address} value={address}>{address}</option>)}</RadarSelect></label></div>
        {paused && <p className="tr-list-notice" role="status">List paused · Monitoring continues{newCount > 0 ? ` · ${newCount} new ${newCount === 1 ? "entry" : "entries"}` : ""}</p>}
        {capture?.retention?.evictedExports ? <p className="tr-note">{capture.retention.evictedExports.toLocaleString()} older messages removed by history limits.</p> : null}
        {activity.length ? <ul className="tr-connections" onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".tr-message"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
          const item = activity[next];
          if (item) {
            setSelected(item.kind === "export" ? item.event.id : null);
            setSelectedObservation(item.kind === "observation" ? item.event.id : null);
          }
          buttons[next]?.focus();
        }}>{activity.slice(0, visibleCount).map(item => item.kind === "export" ? <li key={`event-${item.event.id}`}><button className="tr-message" aria-pressed={chosen?.id === item.event.id} onClick={() => inspect(item.event)}>
          <RadarIcon kind={item.event.signal} className="tr-row-icon" /><span className="tr-event-top"><strong className="tr-event-name">{item.event.name}</strong><time dateTime={new Date(item.event.at).toISOString()}>{stamp(item.event.at)}</time></span>
          <span className="tr-event-context"><span className="tr-signal">{item.event.signal === "logs" ? "Decoded event" : item.event.signal === "metrics" ? "Decoded metric" : "Decoded trace"}</span><span>{sessionName(item.event.sessionIds)}</span></span><code className="tr-event-destination">{item.event.destination}</code>
          <span className="tr-event-bottom"><span className={`tr-receipt ${item.event.outcome === "accepted" ? "tr-tone-ok" : item.event.outcome === "rejected" ? "tr-tone-error" : item.event.outcome === "partial" ? "tr-tone-enabled" : ""}`}>{item.event.outcome === "accepted" ? "Accepted" : item.event.outcome === "unconfirmed" ? "Receipt unconfirmed" : item.event.outcome === "partial" ? "Partially accepted" : item.event.outcome === "rejected" ? "Rejected" : "Receipt unknown"}</span><span>{item.event.count} {item.event.count === 1 ? "record" : "records"}</span></span>
        </button></li> : <li key={`observation-${item.event.id}`}><button className="tr-message" aria-pressed={selectedObservation === item.event.id} onClick={() => { setSelected(null); setSelectedObservation(item.event.id); if (window.matchMedia?.("(max-width: 640px)").matches) { inspector.current?.focus({ preventScroll: true }); inspector.current?.scrollIntoView({ block: "start", behavior: "auto" }); } }}>
          <RadarIcon kind="connection" className="tr-row-icon" /><span className="tr-event-top"><strong className="tr-event-name">Connection observed</strong><time dateTime={new Date(item.event.at).toISOString()}>{stamp(item.event.at)}</time></span><code className="tr-event-destination">{item.event.destination}</code><span>{item.event.reason === "encrypted" ? "Encrypted contents" : "Contents not decoded"}</span>
        </button></li>)}</ul> : <div className="tr-empty-capture"><h4>{retained.length || capture?.observations?.length ? "No matching activity" : running ? "Waiting for traffic" : "Message capture is off"}</h4>
          <p className="tr-note">{retained.length || capture?.observations?.length ? "Try another session, type or destination." : running ? "Activity appears when traffic reaches a monitored destination. Decoded messages will be identified separately." : "No messages have been captured by Radar. Claude may still be sending telemetry. Choose a destination and start monitoring to inspect new traffic."}</p>
        </div>}
        {activity.length > visibleCount && <button className="btn" onClick={() => setVisibleCount(count => count + 100)}>Show older messages</button>}
        {connections.length > 0 && <details className="tr-details"><summary>Connections to these collectors ({connections.length})</summary><ul className="tr-live-connections">{connections.map(c => <li key={`${c.pid}:${c.destination}`}><code>{c.destination}</code><span>Claude · PID {c.pid} · {c.workspace ?? "Workspace unknown"}</span></li>)}</ul><p className="tr-note">A connection alone does not prove a telemetry message was sent. These connections are not filtered by session.</p></details>}
      </section>
      <section className="tr-inspector" aria-label="Activity inspector" ref={inspector} tabIndex={-1}>
        {observation ? <div className="tr-observation-detail">
          <div className="tr-inspector-head"><h3><RadarIcon kind="connection" />Connection details</h3></div>
          <dl className="tr-facts"><div><dt>Destination</dt><dd className="tr-fact-copy"><code>{observation.destination}</code><button className="tr-inline-copy" aria-label="Copy destination" onClick={() => void copy(observation.destination, "destination")} title={copied === "destination" ? "Copied destination" : "Copy destination"}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copied === "destination" ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>}</svg></button></dd></div><div><dt>Observed</dt><dd><time dateTime={new Date(observation.at).toISOString()}>{new Date(observation.at).toLocaleString()}</time></dd></div><div><dt>Source</dt><dd><code>{observation.source || "Not identified"}</code></dd></div><div><dt>Contents</dt><dd>{observation.reason === "encrypted" ? "Encrypted" : "Not decoded"}</dd></div><div><dt>Session</dt><dd>Not identified</dd></div></dl>
          <div className="tr-inspection-limit"><RadarIcon kind="info" /><div><h4>{observation.reason === "encrypted" ? "Encrypted connection" : "Message contents unavailable"}</h4><p>{observation.reason === "joined_midstream" ? "Radar joined an existing connection. Keep listening: new connections may allow decoding." : observation.reason === "encrypted" ? "Radar cannot decrypt HTTPS. Inspect the collector’s own records for the contents." : issueText[observation.reason] ?? "This connection could not be decoded."}</p><details className="tr-details"><summary>Technical details</summary><p className="tr-note">{issueText[observation.reason] ?? "The decoder could not read this connection."}</p><p className="tr-note">There is no decoded JSON or confirmed session ID for this observation. {observation.reason === "joined_midstream" && "Already captured traffic cannot be reconstructed."}</p></details></div></div>
        </div> : chosen ? <>
          <div className="tr-inspector-head"><h3><RadarIcon kind={chosen.signal} />{chosen.name}</h3><p className="tr-note">Decoded {chosen.signal === "logs" ? "event" : chosen.signal === "metrics" ? "metrics" : "trace"} · {sessionName(chosen.sessionIds)} · {stamp(chosen.at)}</p></div>
          <div className="tr-detail-tabs" role="group" aria-label="Message format"><button className="btn" aria-pressed={view === "summary"} onClick={() => setView("summary")}>Overview</button><button className="btn" aria-pressed={view === "json"} onClick={() => setView("json")}>JSON</button>
            <button className="btn tr-copy-json" disabled={!detail?.payload || detail.id !== chosen.id} onClick={() => void copy(JSON.stringify(detail?.payload, null, 2), "json")}>{copied === "json" ? "Copied" : "Copy JSON"}</button></div>
          {detail?.id === chosen.id ? detail.payload ? view === "json" ? <><p className="tr-note">Decoded OTLP fields. Unknown protobuf fields and transport headers are excluded.</p><JsonInspector value={detail.payload} /></> : <>
            <dl className="tr-facts"><div><dt>Destination</dt><dd className="tr-fact-copy"><code>{chosen.destination}</code><button className="tr-inline-copy" aria-label="Copy destination" onClick={() => void copy(chosen.destination, "destination")} title={copied === "destination" ? "Copied destination" : "Copy destination"}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copied === "destination" ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>}</svg></button></dd></div><div><dt>Time</dt><dd>{stamp(chosen.at)}</dd></div><div><dt>Receipt</dt><dd>{outcomeLabel(chosen)}</dd></div><div><dt>Size</dt><dd>{chosen.bytes.toLocaleString()} bytes · {chosen.count} {chosen.count === 1 ? "record" : "records"}</dd></div>
              {chosen.response?.message && <div><dt>Response</dt><dd><Value value={chosen.response.message} /></dd></div>}
            </dl><DecodedPayload payload={detail.payload} signal={chosen.signal} />
          </> : <div role="alert"><p>{detail.error}</p><button className="btn" onClick={() => setRetry(retry + 1)}>Retry</button></div> : <p className="tr-note" role="status">Loading message contents…</p>}
        </> : <div className="tr-inspector-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-3 4 3 4M14 8l3 4-3 4" /></svg><h3>{selected !== null || selectedObservation !== null ? "Activity no longer available" : "Inspect collector activity"}</h3><p className="tr-note">{selected !== null || selectedObservation !== null ? "The selected entry is no longer retained or does not match your filter. Select another entry." : monitor.traffic && !monitor.decoded ? "Traffic has been observed, but no messages have been decoded. Select a connection observation to see what is known." : "Select an entry to inspect its metadata and any decoded contents."}</p></div>}
      </section>
    </div>
    <footer className="tr-monitor-footer"><span>{failed ? "Connection interrupted" : running ? (managed ? "Continuous local monitoring" : "Local capture") : "Not monitoring"} · History in local memory</span><details><summary>Monitoring limits</summary><div>
      <p>Plaintext IPv4 OTLP/gRPC only. HTTPS contents cannot be decoded. Traffic to the chosen addresses can come from any process, not only Claude.</p>
      <p>History covers the last 24 hours, up to 2,000 exports and a 32 MiB payload budget. When a limit is reached, the oldest messages are removed.</p>
      <p>History stays in local memory. Restarting ccdeck or clearing messages removes it. Closing this modal does not stop capture or clear history; stopping monitoring preserves history. No capture file is written. Use Stop monitoring{!managed && <> and Ctrl+C in {shell}</>} to stop capture.</p>
      {capture?.bytes ? <p>Captured transport bytes: {capture.bytes.toLocaleString()}. This is not a decoded-message count.</p> : null}
      {managed && <p>Enabled monitoring resumes after a ccdeck restart; the in-memory history does not.</p>}
      {Object.entries(capture?.issues ?? {}).map(([code, count]) => <p key={code}>{issueText[code] ?? "An inspection limitation was observed."} ({count})</p>)}
    </div></details></footer>
  </div>;
}
