import { useEffect, useRef, useState } from "react";
import { pressState } from "../panel-press";
import type { RadarSnapshot } from "../traffic-radar";
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
    <details className="tr-details"><summary>Decoded OTLP JSON</summary><p className="tr-note">Decoded protobuf contents, not the complete network request. Transport authentication headers are not displayed.</p><Value value={payload} /></details>
  </div>;
}
export function TelemetryCapture({ capture, radar, failed, busy, pendingAction = null, error, command, action }: {
  capture: CaptureSnapshot | null; radar: RadarSnapshot | null; failed: boolean; busy: boolean; pendingAction?: CaptureAction | null; error: string; command: string;
  action: (kind: CaptureAction, destination?: string) => Promise<void>;
}) {
  const configured = radar?.config?.variables.filter(v => v.key.endsWith("ENDPOINT")).map(v => {
    try { const u = new URL(v.value); return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`; } catch { return ""; }
  }).find(v => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) ?? "";
  const [destination, setDestination] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState("all");
  const [paused, setPaused] = useState<CapturedExport[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [detail, setDetail] = useState<{ id: number; payload?: Obj; protobufBase64?: string; error?: string } | null>(null);
  const inspector = useRef<HTMLElement | null>(null);
  const retained = capture?.events ?? [];
  const events = paused ? paused.filter(e => retained.some(current => current.id === e.id)) : retained;
  const rows = events.filter(e => filter === "all" || e.signal === filter);
  const chosen = retained.find(e => e.id === (selected ?? rows[0]?.id));
  const id = chosen?.id;
  useEffect(() => {
    setDetail(null);
    if (id === undefined) return;
    const controller = new AbortController();
    let alive = true;
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch(`/api/system/traffic-radar/capture/event?id=${id}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Event is no longer retained. Select a newer event.");
      const data = await response.json();
      if (!controller.signal.aborted) setDetail({ id, payload: data.payload, protobufBase64: data.protobufBase64 });
    }).catch(value => { if (alive) setDetail({ id, error: controller.signal.aborted ? "Loading timed out. Select another export or reopen Radar to retry." : value instanceof Error ? value.message : "Could not read this event." }); })
      .finally(() => clearTimeout(timeout));
    return () => { alive = false; clearTimeout(timeout); controller.abort(); };
  }, [id]);
  const running = !!capture && ["awaiting", "receiving", "capturing"].includes(capture.state);
  const state = failed ? "Capture visibility interrupted" : !capture ? "Reading capture status…" : ({
    idle: "Capture is off", awaiting: "Waiting for local activation", receiving: "Local receiver ready · waiting for capture bytes", capturing: "Capture input received",
    stopped: "Local receiver stopped", expired: "Capture session expired", interrupted: "Capture input interrupted", error: "Capture format could not be read",
  })[capture.state];
  const copy = async () => { try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); } };
  const pressProps = (kind: CaptureAction) => {
    const state = pressState(pendingAction ?? (busy ? "capture" : null), kind);
    return { disabled: state.disabled, "aria-busy": state.busy };
  };
  const inspect = (event: CapturedExport) => {
    setSelected(event.id);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches) {
      inspector.current?.focus({ preventScroll: true });
      inspector.current?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  };
  const prepare = () => { setCopied(false); setPaused(null); setSelected(null); void action("prepare", destination || (capture?.state === "awaiting" ? capture.destination : null) || configured); };
  return <div className="tr-telemetry">
    <div className="tr-capture-bar">
      <div><h3 role="status">{state}</h3><p className="tr-note">{capture?.destination ? `${capture.destination} · ${capture.interface} · ` : ""}Passive observation. Nothing is redirected, blocked or changed in Claude.</p></div>
      <div className="tr-capture-actions">
        {running ? <button className="btn" {...pressProps("stop")} onClick={() => void action("stop")}>Stop receiving</button>
          : <button className="btn" {...pressProps("prepare")} disabled={pressProps("prepare").disabled || !capture || failed} onClick={prepare}>{pendingAction === "prepare" ? "Preparing…" : "Prepare capture"}</button>}
        {capture?.state === "awaiting" && !command && <button className="btn" {...pressProps("prepare")} onClick={prepare}>{pendingAction === "prepare" ? "Preparing…" : "Prepare a new command"}</button>}
        <button className="btn" {...pressProps("clear")} disabled={pressProps("clear").disabled || !capture?.events.length} onClick={() => { setSelected(null); setPaused(null); void action("clear"); }}>Clear captured contents</button>
      </div>
    </div>
    {!running && <label className="tr-destination">Collector IPv4 and port<input className="tr-input" value={destination || configured} onChange={e => setDestination(e.target.value)} placeholder="192.0.2.16:4317" /></label>}
    {error && <p className="tr-capture-error" role="alert">{error}</p>}
    {capture?.state === "awaiting" && !command && <p className="tr-note">Activation has not been observed. Prepare a new command to show the instructions again; the previous token will be invalidated.</p>}
    {command && running && <details className="tr-activation tr-details" open><summary>Activate locally in Terminal</summary>
      <p>Copy this command into your own Terminal. Only tcpdump asks for administrator permission; ccdeck and the decoder stay unprivileged.</p>
      <pre className="tr-command">{command}</pre><button className="btn" onClick={() => void copy()}>{copied ? "Command copied" : "Copy command"}</button>
      <p className="tr-note">The command contains a temporary local token. Do not share it. Press Ctrl+C in Terminal to stop tcpdump. Stopping the receiver here invalidates the token but may leave tcpdump waiting until its next write.</p>
    </details>}
    <div className="tr-workspace">
      <section className="tr-feed" aria-label="Captured telemetry exports">
        <h3>Observed exports ({events.length})</h3>
        <div className="tr-filter"><label>Signal<select className="tr-select" value={filter} onChange={e => { setSelected(null); setFilter(e.target.value); }}><option value="all">All signals</option><option value="logs">Logs · events</option><option value="metrics">Metrics · usage</option><option value="traces">Traces · operations</option></select></label>
          <button className="btn" disabled={!events.length} onClick={() => setPaused(paused ? null : [...events])}>{paused ? "Resume list" : "Pause list"}</button></div>
        {paused && <p className="tr-note">List paused; capture continues. Retention still applies.</p>}
        {rows.length ? <ul className="tr-connections">{rows.map(event => <li key={event.id}><button className="btn tr-row" aria-pressed={chosen?.id === event.id} onClick={() => inspect(event)}>
          <span className="tr-event-top"><strong>{event.signal}</strong><time dateTime={new Date(event.at).toISOString()}>{stamp(event.at)}</time></span>
          <strong className="tr-event-name">{event.name}</strong><span>{event.count} records · {event.bytes.toLocaleString()} bytes</span>
          <span>{outcomeLabel(event)}</span>{event.content.length > 0 && <span>Includes fields: {event.content.join(", ")}</span>}
        </button></li>)}</ul> : <div className="tr-empty-capture"><h4>{filter !== "all" && events.length ? "No exports match this signal" : "No decoded exports yet"}</h4>
          <p className="tr-note">{filter !== "all" && events.length ? "Choose All signals to see the other exports." : "Activate capture to see actual OTLP/gRPC contents. Older uploads and encrypted payloads cannot be recovered here. Existing connections may need to reconnect naturally before decoding begins."}</p>
        </div>}
      </section>
      <section className="tr-inspector" aria-label="Telemetry contents" ref={inspector} tabIndex={-1}>
        <h3>What this export contains</h3>
        {chosen ? <><h4>{chosen.name}</h4><dl className="tr-facts">
          <div><dt>Destination</dt><dd><code>{chosen.destination}</code></dd></div><div><dt>Observed</dt><dd>{stamp(chosen.at)}</dd></div>
          <div><dt>Message size</dt><dd>{chosen.bytes.toLocaleString()} bytes · gRPC message, compressed when gzip is used; excludes HTTP/2 and IP framing</dd></div>
          <div><dt>Receipt</dt><dd>{outcomeLabel(chosen)}</dd></div>
          {chosen.response && <div><dt>Response</dt><dd>gRPC status {chosen.response.grpcStatus ?? "unknown"} at {stamp(chosen.response.at)}{chosen.response.rejected !== null && ` · ${chosen.response.rejected} rejected`}{chosen.response.message && <Value value={chosen.response.message} />}</dd></div>}
        </dl><p className="tr-note">Collector acceptance is not proof of storage in the final backend. Content below comes from the captured export, not local conversation files.</p>
          {detail?.id === chosen.id ? detail.payload ? <><DecodedPayload payload={detail.payload} signal={chosen.signal} />
            <details className="tr-details"><summary>Captured protobuf bytes (Base64)</summary><p className="tr-note">The protobuf message after decompression, including fields unknown to the v1.9.0 decoder schema. Not HTTP/2 framing or authentication headers.</p><Value value={detail.protobufBase64 ?? "Unavailable"} /></details>
          </> : <p role="alert">{detail.error}</p> : <p className="tr-note" role="status">Loading captured contents…</p>}
        </> : <p className="tr-note">{selected !== null ? "This selected event is no longer retained. Select another export." : "Select an export to inspect its body, attributes and resource metadata."}</p>}
        <details className="tr-details" open={Object.keys(capture?.issues ?? {}).length > 0}><summary>Capture coverage and limits</summary>
          <p className="tr-note">IPv4, plaintext OTLP/gRPC over HTTP/2; uncompressed and gzip messages. This captures traffic to the selected address from any process on this machine, not only Claude. It does not inspect model API requests, Codex traffic elsewhere, or Enterprise server-side capture.</p>
          <p className="tr-note">No capture file is written. Contents stay in local server memory: up to 100 exports, a 5-minute window and a bounded memory budget. Activation expires after 10 minutes. Closing this modal does not stop capture; use Stop receiving and Ctrl+C in Terminal.</p>
          <ul>{Object.entries(capture?.issues ?? {}).map(([code, count]) => <li key={code}>{issueText[code] ?? "An inspection limitation was observed."} ({count})</li>)}</ul>
        </details>
      </section>
    </div>
  </div>;
}
