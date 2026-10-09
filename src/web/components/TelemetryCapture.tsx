import { useEffect, useRef, useState } from "react";
import { pressState } from "../panel-press";
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
  const [pausedObservationIds, setPausedObservationIds] = useState<number[] | null>(null);
  const [paused, setPaused] = useState<CapturedExport[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [view, setView] = useState<"summary" | "json">("summary");
  const [detail, setDetail] = useState<{ id: number; payload?: Obj; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const inspector = useRef<HTMLElement | null>(null);
  const retained = capture?.events ?? [];
  const events = paused ? paused.map(e => retained.find(current => current.id === e.id)).filter((e): e is CapturedExport => !!e) : retained;
  const rows = events.filter(e => (filter === "all" || e.signal === filter) && (messageDestination === "all" || messageDestination === e.destination) &&
    (sessionFilter === "all" || (sessionFilter === "unidentified" ? !e.sessionIds?.length : e.sessionIds?.includes(sessionFilter))));
  const observations = (capture?.observations ?? []).filter(e => (pausedObservationIds === null || pausedObservationIds.includes(e.id)) && filter === "all" && (sessionFilter === "all" || sessionFilter === "unidentified") && (messageDestination === "all" || messageDestination === e.destination));
  const observation = observations.find(e => e.id === selectedObservation);
  const chosen = selectedObservation !== null ? undefined : selected === null ? rows[0] : rows.find(e => e.id === selected);
  const id = chosen?.id;
  useEffect(() => { setSelected(null); setSelectedObservation(null); }, [sessionFilter, filter, messageDestination]);
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
  }, [id, retry]);
  const running = !!capture && ["awaiting", "receiving", "capturing"].includes(capture.state);
  const active = capture?.sources?.filter(s => s.active).length ?? 0;
  const sourceCount = capture?.sources?.length ?? 1;
  const state = failed ? "Monitor connection lost" : !capture ? "Reading monitor…" : ({
    idle: "Message capture stopped", awaiting: "Terminal activation needed", receiving: "Listening · waiting for traffic", capturing: "Monitoring traffic",
    stopped: "Message capture stopped", expired: "Monitoring expired", interrupted: "Capture disconnected", error: "Capture could not be read",
  })[capture.state];
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
  const encrypted = (capture?.issues.encrypted ?? 0) > 0;
  const liveAddresses = new Set([...(capture?.sources?.map(s => s.destination) ?? []), ...addresses]);
  const connections = radar?.status === "observing" ? radar.connections.filter(c => c.active && liveAddresses.has(c.destination)) : [];
  return <div className="tr-telemetry">
    <div className="tr-capture-bar">
      <div><h3 role="status"><span className={`tr-live-dot${running && active ? " is-live" : ""}`} />{state}</h3>
        <p className="tr-note">{running ? `${active} of ${sourceCount} destination${sourceCount === 1 ? "" : "s"} listening. ` : "See messages sent to your configured collectors. "}Claude settings stay unchanged.</p></div>
      <div className="tr-capture-actions">
        {running ? <button className="btn" {...pressProps("stop")} onClick={() => void action("stop")}>Stop monitoring</button>
          : <button className="btn tr-start" {...pressProps("prepare")} disabled={pressProps("prepare").disabled || !capture || failed || radar?.status === "unsupported" || (destination === "all" && !addresses.length) || (destination === "custom" && !custom.trim())} onClick={prepare}>{pendingAction === "prepare" ? "Starting…" : "Start monitoring"}</button>}
        <button className="btn" {...pressProps("clear")} disabled={pressProps("clear").disabled || (!capture?.events.length && !capture?.observations?.length)} onClick={() => { setSelected(null); setSelectedObservation(null); setPaused(null); setPausedObservationIds(null); void action("clear"); }}>Clear messages</button>
      </div>
    </div>
    {!running && <div className="tr-destination">
      <label>Destination<select className="tr-select" aria-label="Capture destination" value={destination} onChange={e => setDestination(e.target.value)}><option value="all">All configured IPv4 destinations ({addresses.length})</option>{addresses.map(address => <option key={address} value={address}>{address}</option>)}{observed.length > 0 && <optgroup label="Observed Claude connections · telemetry unverified">{observed.map(address => <option key={address} value={address}>{address} · observed</option>)}</optgroup>}<option value="custom">Another IPv4 address…</option></select></label>
      {destination === "custom" && <input className="tr-input" aria-label="Collector IPv4 and port" value={custom} onChange={e => setCustom(e.target.value)} placeholder="192.168.1.10:4317" />}
      {!addresses.length && destination === "all" && <span className="tr-note">{observed.length ? "Choose an observed connection or enter your collector address." : "Enter your collector address to monitor traffic. Missing settings do not mean telemetry is off."}</span>}
    </div>}
    {radar?.status === "unsupported" && <p className="tr-capture-error" role="status">Live capture is available on macOS. You can still inspect a local file.</p>}
    {error && <p className="tr-capture-error" role="alert">{error}</p>}
    {running && !activationCommands.length && capture?.state === "awaiting" && <div className="tr-activation"><p>Activation is pending. Generate the Terminal instructions again to continue.</p><button className="btn" {...pressProps("prepare")} onClick={prepare}>Show activation instructions</button><p className="tr-note">The previous token will be invalidated.</p></div>}
    {activationCommands.length > 0 && running && <details className="tr-activation" open={!active}><summary>Activate in Terminal{sourceCount > 1 ? ` · ${active}/${sourceCount} listening` : ""}</summary>
      <p>Run each command in a separate Terminal tab. Only tcpdump asks for administrator permission.</p>
      {activationCommands.map(entry => <div className="tr-command-entry" key={entry.destination}><div><code>{entry.destination}</code><button className="btn" onClick={() => void copy(entry.command, entry.destination)}>{copied === entry.destination ? "Copied" : "Copy command"}</button></div><pre className="tr-command">{entry.command}</pre></div>)}
      <p className="tr-note">Press Ctrl+C in each Terminal tab to stop tcpdump. Monitoring expires after 10 minutes. Commands contain a temporary local token; do not share them.</p>
    </details>}
    {copied === "failed" && <p className="tr-capture-error" role="alert">Clipboard unavailable. Select the text and copy it manually.</p>}
    {failed && <p className="tr-capture-error" role="alert">Displayed messages are from the last successful read. Reconnecting automatically.</p>}
    <div className="tr-workspace">
      <section className="tr-feed" aria-label="Captured telemetry messages">
        <div className="tr-feed-head"><h3>Messages <span className="tr-count">{rows.length + observations.length}</span></h3><button className="btn" disabled={!events.length && !observations.length} onClick={() => { setPaused(paused ? null : [...events]); setPausedObservationIds(paused ? null : (capture?.observations ?? []).map(entry => entry.id)); }}>{paused ? "Resume list" : "Pause list"}</button></div>
        <div className="tr-filter"><label>Type<select className="tr-select" aria-label="Message type" value={filter} onChange={e => { setSelected(null); setFilter(e.target.value); }}><option value="all">All types</option><option value="logs">Events</option><option value="metrics">Metrics</option><option value="traces">Traces</option></select></label><label>To<select className="tr-select" aria-label="Message destination" value={messageDestination} onChange={e => { setSelected(null); setMessageDestination(e.target.value); }}><option value="all">All destinations</option>{[...new Set([...addresses, ...(capture?.sources?.map(s => s.destination) ?? []), ...retained.map(e => e.destination)])].map(address => <option key={address} value={address}>{address}</option>)}</select></label></div>
        {paused && <p className="tr-note">List paused. Monitoring continues.</p>}
        {encrypted && <div className="tr-observation" role="status"><strong>Encrypted traffic observed</strong><p className="tr-note">The connection is visible; its contents cannot be read. Inspect the collector for its JSON.</p></div>}
        {(capture?.issues.joined_midstream ?? 0) > 0 && <p className="tr-warning">Waiting for a new HTTP/2 connection to decode messages. Existing traffic is not reconstructable.</p>}
        {rows.length ? <ul className="tr-connections">{rows.map(event => <li key={event.id}><button className="tr-message" aria-pressed={chosen?.id === event.id} onClick={() => inspect(event)}>
          <span className="tr-event-top"><span className="tr-signal">{event.signal === "logs" ? "Event" : event.signal === "metrics" ? "Metric" : "Trace"}</span><time dateTime={new Date(event.at).toISOString()}>{stamp(event.at)}</time></span>
          <strong className="tr-event-name">{event.name}</strong><span>{sessionName(event.sessionIds)}</span><code>{event.destination}</code>
          <span className="tr-event-bottom"><span className={`tr-receipt ${event.outcome === "accepted" ? "tr-tone-ok" : event.outcome === "rejected" || event.outcome === "partial" ? "tr-tone-enabled" : ""}`}>{event.outcome === "accepted" ? "Accepted" : event.outcome === "unconfirmed" ? "Receipt unconfirmed" : event.outcome === "partial" ? "Partially accepted" : event.outcome === "rejected" ? "Rejected" : "Receipt unknown"}</span><span>{event.count} {event.count === 1 ? "record" : "records"} · {event.bytes.toLocaleString()} B</span></span>
        </button></li>)}</ul> : !observations.length && <div className="tr-empty-capture"><h4>{events.length || observations.length ? "No matching messages" : running ? "Waiting for messages" : "Message capture is off"}</h4>
          <p className="tr-note">{events.length ? "Try another session or message type." : running ? "Messages appear here once capture is activated and new decodable traffic arrives." : "No messages have been captured by Radar. Claude may still be sending telemetry. Choose a destination, start monitoring, then run the Terminal command to inspect new traffic."}</p>
        </div>}
        {observations.length > 0 && <ul className="tr-connections tr-unreadable">{observations.map(entry => <li key={entry.id}><button className="tr-message" aria-pressed={selectedObservation === entry.id} onClick={() => { setSelected(null); setSelectedObservation(entry.id); }}><span className="tr-event-top"><span>Connection observation</span><time>{stamp(entry.at)}</time></span><strong>{entry.reason === "encrypted" ? "Encrypted traffic" : "Contents unavailable"}</strong><code>{entry.destination}</code><span>Unidentified session · no decoded JSON</span></button></li>)}</ul>}
        {connections.length > 0 && <details className="tr-details"><summary>Connections to these collectors ({connections.length})</summary><ul className="tr-live-connections">{connections.map(c => <li key={`${c.pid}:${c.destination}`}><code>{c.destination}</code><span>Claude · PID {c.pid} · {c.workspace ?? "Workspace unknown"}</span></li>)}</ul><p className="tr-note">A connection alone does not prove a telemetry message was sent. These connections are not filtered by session.</p></details>}
      </section>
      <section className="tr-inspector" aria-label="Message contents" ref={inspector} tabIndex={-1}>
        {observation ? <div className="tr-inspector-empty"><h3>{observation.reason === "encrypted" ? "Encrypted contents" : "Contents unavailable"}</h3><code>{observation.destination}</code><p className="tr-note">{issueText[observation.reason] ?? "This connection could not be decoded."}</p><p className="tr-note">There is no decoded JSON or confirmed session ID for this observation.</p></div> : chosen ? <>
          <div className="tr-inspector-head"><h3>{chosen.name}</h3><p className="tr-note">{sessionName(chosen.sessionIds)}</p></div>
          <div className="tr-detail-tabs" role="group" aria-label="Message format"><button className="btn" aria-pressed={view === "summary"} onClick={() => setView("summary")}>Overview</button><button className="btn" aria-pressed={view === "json"} onClick={() => setView("json")}>JSON</button>
            <button className="btn tr-copy-json" disabled={!detail?.payload || detail.id !== chosen.id} onClick={() => void copy(JSON.stringify(detail?.payload, null, 2), "json")}>{copied === "json" ? "Copied" : "Copy JSON"}</button></div>
          {detail?.id === chosen.id ? detail.payload ? view === "json" ? <><p className="tr-note">Decoded OTLP fields. Unknown protobuf fields and transport headers are excluded.</p><Value value={detail.payload} /></> : <>
            <dl className="tr-facts"><div><dt>Destination</dt><dd><code>{chosen.destination}</code></dd></div><div><dt>Time</dt><dd>{stamp(chosen.at)}</dd></div><div><dt>Receipt</dt><dd>{outcomeLabel(chosen)}</dd></div><div><dt>Size</dt><dd>{chosen.bytes.toLocaleString()} bytes · {chosen.count} {chosen.count === 1 ? "record" : "records"}</dd></div>
              {chosen.response?.message && <div><dt>Response</dt><dd><Value value={chosen.response.message} /></dd></div>}
            </dl><DecodedPayload payload={detail.payload} signal={chosen.signal} />
          </> : <div role="alert"><p>{detail.error}</p><button className="btn" onClick={() => setRetry(retry + 1)}>Retry</button></div> : <p className="tr-note" role="status">Loading message contents…</p>}
        </> : <div className="tr-inspector-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-3 4 3 4M14 8l3 4-3 4" /></svg><h3>{selected !== null ? "Message no longer available" : "See what was sent"}</h3><p className="tr-note">{selected !== null ? "The selected message is no longer retained or does not match your filter. Select another message." : "Select a message to explore its contents or inspect the full JSON."}</p></div>}
      </section>
    </div>
    <footer className="tr-monitor-footer"><span>{failed ? "Connection interrupted" : running ? "Local capture" : "Not monitoring"}{capture?.bytes ? ` · ${capture.bytes.toLocaleString()} capture bytes` : ""}</span><details><summary>Monitoring limits</summary><div>
      <p>Plaintext IPv4 OTLP/gRPC only. HTTPS contents cannot be decoded. Traffic to the chosen addresses can come from any process, not only Claude.</p>
      <p>Messages stay in local memory: up to 100 exports for 5 minutes. No capture file is written. Closing this modal does not stop capture; use Stop monitoring and Ctrl+C in Terminal.</p>
      {Object.entries(capture?.issues ?? {}).map(([code, count]) => <p key={code}>{issueText[code] ?? "An inspection limitation was observed."} ({count})</p>)}
    </div></details></footer>
  </div>;
}
