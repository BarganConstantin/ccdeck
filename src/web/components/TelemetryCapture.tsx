import { RadarIcon } from "./RadarIcon";
import { RadarSelect } from "./RadarSelect";
import RadarSplitter from "./RadarSplitter";
import RadarPromptPreview from "./RadarPromptPreview";
import { useEffect, useRef, useState } from "react";
import { JsonInspector } from "./JsonInspector";
import { radarMonitorState } from "../radar-monitor-state";
import { armedPress, pressState } from "../panel-press";
import { connectionLabel, type RadarSnapshot } from "../traffic-radar";
import { captureAddress, configuredDestinations, type RadarSession } from "../telemetry-inspection";
import type { CaptureAction, CaptureSnapshot, CapturedExport, PermissionResult } from "../use-telemetry-capture";
import { readStored, writeStored } from "../storage";
import { currentLanguage, t as translateNow, useT, type TFunction } from "../i18n";
import { formatNumber } from "../i18n/format";
import { serverText } from "../radar-server-text";

import type { Json } from "./JsonInspector";
import { attributes, fieldEvidence, projectEvidence, recordPriority, redactedValue, PROMPT_FIELDS, RESPONSE_FIELDS, PROJECT_FIELDS, DIRECTORY_FIELDS, otlpValue as readAny } from "../telemetry-highlights";
type Obj = { [key: string]: Json };
const obj = (v: Json | undefined): Obj => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const arr = (v: Json | undefined): Json[] => Array.isArray(v) ? v : [];
const stamp = (at: number) => new Date(at).toLocaleTimeString(currentLanguage());
/** The activity list's share of the workspace, as a percentage, kept between visits. */
const FEED_WIDTH_KEY = "agent-dag.radar-feed-width";
export const outcomeLabel = (event: CapturedExport, t: TFunction = translateNow) => t(`radar.outcome.${event.outcome}`);
const ISSUE_CODES = ["encrypted", "joined_midstream", "capture_gap", "decode_failed", "payload_limit", "stream_limit", "connection_limit", "unsupported_compression", "unsupported_link", "unsupported_network", "fragmented", "unknown_export", "connection_closed", "idle_connection"];
/** The sentence for an inspection-limit code, or undefined for a code this build does not know. */
const issueText = (code: string, t: TFunction): string | undefined => ISSUE_CODES.includes(code) ? t(`radar.issue.${code}`) : undefined;
function explanation(key: string, t: TFunction) {
  if (/prompt/i.test(key)) return t("radar.attr.prompt");
  if (/response|completion/i.test(key)) return t("radar.attr.response");
  if (/tool/i.test(key)) return t("radar.attr.tool");
  if (/session/i.test(key)) return t("radar.attr.session");
  if (/user|email|account/i.test(key)) return t("radar.attr.user");
  if (/token|cost|duration|latency/i.test(key)) return t("radar.attr.usage");
  return t("radar.attr.other");
}
function Value({ value }: { value: Json }) {
  return <pre className="tr-value">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}
function Attributes({ value }: { value: Json | undefined }) {
  const t = useT();
  return <dl className="tr-attributes">{arr(value).map((a, index) => { const v = obj(a); return <div key={index}>
    <dt><code>{String(v.key ?? t("radar.attr.unnamed"))}</code><span>{explanation(String(v.key), t)}</span></dt>
    <dd><Value value={readAny(v.value)} /></dd>
  </div>; })}</dl>;
}
const importantFields: [string, string[]][] = [
  ["error", ["error.message", "exception.message", "error", "error_type"]],
  ["prompt", PROMPT_FIELDS],
  ["response", RESPONSE_FIELDS],
  ["project", PROJECT_FIELDS],
  ["directory", DIRECTORY_FIELDS],
  ["repository", ["repository.url", "repo_url", "vcs.repository.url.full"]],
  ["branch", ["git.branch", "branch", "vcs.ref.head.name"]],
  ["tool", ["tool_name", "tool.name", "gen_ai.tool.name"]],
  ["toolInput", ["tool_parameters", "tool_input", "tool.input"]],
  ["toolResult", ["tool_result", "tool_response", "tool.output"]],
  ["model", ["model", "gen_ai.request.model", "gen_ai.response.model"]],
  ["inputTokens", ["input_tokens", "gen_ai.usage.input_tokens"]],
  ["outputTokens", ["output_tokens", "gen_ai.usage.output_tokens"]],
  ["cacheRead", ["cache_read_tokens"]],
  ["cacheCreation", ["cache_creation_tokens"]],
  ["cost", ["cost_usd"]],
  ["duration", ["duration_ms", "interaction.duration_ms"]],
  ["ttft", ["ttft_ms"]],
  ["success", ["success"]],
  ["stopReason", ["stop_reason", "gen_ai.response.finish_reasons"]],
  ["tokenType", ["type"]],
];
function ImportantAttributes({ value }: { value: Json | undefined }) {
  const t = useT();
  const fields = attributes(value);
  return <dl className="tr-highlights">{importantFields.flatMap(([label, aliases]) => {
    const key = fieldEvidence(fields, aliases).key;
    if (!key) return [];
    const data = fields[key];
    if (data === null || data === "") return [];
    const name = t(`radar.field.${label}`);
    if ((label === "prompt" || label === "response") && redactedValue(data)) return [<div key={label} data-field={name}>
      <dt>{name}</dt><dd><span className="tr-evidence-status">{t("radar.payload.redacted")}</span>
        <p className="tr-note">{t("radar.payload.redactedNote")}</p></dd></div>];
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return [<div key={label} data-field={name}><dt>{name}</dt><dd>{text.length > 800
      ? <><Value value={text.slice(0, 800) + "…"} /><details className="tr-details"><summary>{t(label === "prompt" ? "radar.payload.showFullPrompt" : label === "response" ? "radar.payload.showFullResponse" : "radar.payload.showFull")}</summary><Value value={data} /></details></>
      : <Value value={data} />}</dd></div>];
  })}</dl>;
}
function JsonDetails({ label, value }: { label: string; value: Json }) {
  const [open, setOpen] = useState(false);
  return <details className="tr-details" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>{label}</summary>{open && <JsonInspector value={value} />}
  </details>;
}
function Measurement({ record }: { record: Obj }) {
  const t = useT();
  const kind = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"].find(key => record[key]);
  if (!kind) return null;
  return <div>
    {record.description && <p className="tr-note">{String(record.description)}</p>}
    {arr(obj(record[kind]).dataPoints).map((p, index) => { const point = obj(p); return <section key={index}>
      <dl className="tr-facts">
        <div><dt>{t("radar.payload.measurement")}</dt><dd>{kind}</dd></div>
        {point.asInt !== undefined || point.asDouble !== undefined ? <div><dt>{t("radar.payload.value")}</dt><dd><code>{String(point.asInt ?? point.asDouble)} {String(record.unit ?? "")}</code></dd></div> : null}
        {point.count !== undefined && <div><dt>{t("radar.payload.count")}</dt><dd><code>{String(point.count)}</code></dd></div>}
        {point.sum !== undefined && <div><dt>{t("radar.payload.sum")}</dt><dd><code>{String(point.sum)} {String(record.unit ?? "")}</code></dd></div>}
      </dl>
      <ImportantAttributes value={point.attributes} />
      <JsonDetails label={t("radar.payload.allMeasurement")} value={point} />
    </section>; })}
  </div>;
}
function SpanTiming({ record }: { record: Obj }) {
  const t = useT();
  let duration: string | null = null;
  try { duration = `${Number(BigInt(String(record.endTimeUnixNano)) - BigInt(String(record.startTimeUnixNano))) / 1e6} ms`; } catch { duration = null; }
  return <dl className="tr-facts">
    <div><dt>{t("radar.payload.duration")}</dt><dd>{duration ?? t("radar.payload.notIncluded")}</dd></div>
    {record.kind && <div><dt>{t("radar.payload.spanKind")}</dt><dd>{String(record.kind)}</dd></div>}
    {record.status && <div><dt>{t("radar.payload.spanStatus")}</dt><dd><Value value={record.status} /></dd></div>}
  </dl>;
}
const contentKinds: [string, string[]][] = [["prompt", PROMPT_FIELDS], ["response", RESPONSE_FIELDS]];
function ContentEvidence({ fields }: { fields: Obj[] }) {
  const t = useT();
  return <dl className="tr-content-evidence">{contentKinds.map(([label, aliases]) => {
    const evidence = fields.map(field => fieldEvidence(field, aliases));
    const included = evidence.some(e => e.state === "included"), redacted = evidence.some(e => e.state === "redacted");
    return <div key={String(label)}><dt>{t(`radar.field.${label}`)}</dt><dd data-evidence={included ? "included" : redacted ? "redacted" : "absent"}>
      {included ? redacted ? t("radar.payload.includedSome") : t("radar.payload.included") : redacted ? t("radar.payload.redactedInExport") : t("radar.payload.notInExport")}
    </dd></div>;
  })}</dl>;
}
function ProjectContext({ fields, sessions }: { fields: Obj[]; sessions: RadarSession[] }) {
  const t = useT();
  const evidence = fields.map(field => projectEvidence(field, sessions));
  const available = evidence.filter(e => e.source !== "absent");
  const unique = available.filter((e, index) => available.findIndex(other => other.source === e.source && other.project.value === e.project.value && other.directory.value === e.directory.value) === index);
  return <section className="tr-project-context" aria-label={t("radar.payload.projectContext")}>
    <h4>{t("radar.payload.projectDirectory")}</h4>
    {unique.length ? unique.map((e, index) => <div key={index}>
      {e.project.value !== null && (e.project.state === "redacted" ? <p className="tr-note">{t("radar.payload.projectRedacted")}</p> : <Value value={e.project.value} />)}
      {e.directory.value !== null && e.directory.value !== e.project.value && (e.directory.state === "redacted" ? <p className="tr-note">{t("radar.payload.directoryRedacted")}</p> : <Value value={e.directory.value} />)}
      <p className="tr-note">{e.source === "export" ? t("radar.payload.included") : t("radar.payload.fromLocal")}</p>
    </div>) : <p className="tr-note">{t("radar.payload.noContext")}</p>}
  </section>;
}
function RecordOverview({ record, signal }: { record: Obj; signal: CapturedExport["signal"] }) {
  const t = useT();
  const fields = attributes(record.attributes);
  const name = record.eventName ?? record.name ?? fields["event.name"] ?? (signal === "logs" ? t("radar.payload.logRecord") : t("radar.payload.record"));
  const body = readAny(record.body);
  const repeatsName = typeof body === "string" && (body === name || body === `claude_code.${name}`);
  return <article className="tr-record">
    <h4>{String(name)}</h4>
    {record.body && !repeatsName && <><p className="tr-note">{t("radar.payload.body")}</p><Value value={body} /></>}
    {signal === "metrics" && <Measurement record={record} />}
    {signal === "traces" && <SpanTiming record={record} />}
    {record.attributes && <ImportantAttributes value={record.attributes} />}
    {record.severityText && <p className="tr-note">{t("radar.payload.severity", { value: String(record.severityText) })}</p>}
    <JsonDetails label={t("radar.payload.allRecord")} value={record} />
  </article>;
}
function ScopeOverview({ scope, signal, item }: { scope: Obj; signal: CapturedExport["signal"]; item: string }) {
  const t = useT();
  const records = arr(scope[item]).map(obj);
  const prioritized = signal === "logs" ? records.map((record, index) => ({ record, index, priority: recordPriority(record) })).sort((a, b) => a.priority - b.priority || a.index - b.index) : [];
  const hasUseful = prioritized.some(record => record.priority < 4);
  const shown = hasUseful ? prioritized.filter(record => record.priority < 4).map(({ record }) => record) : records;
  const background = hasUseful ? prioritized.filter(record => record.priority === 4).map(({ record }) => record) : [];
  const [showOther, setShowOther] = useState(false);
  return <div>
    {shown.map((record, index) => <RecordOverview key={index} record={record} signal={signal} />)}
    {!!background.length && <details className="tr-details" onToggle={event => { if (event.target === event.currentTarget) setShowOther(event.currentTarget.open); }}>
      <summary>{t("radar.payload.other", { count: background.length })}</summary>
      {showOther && background.map((record, index) => <RecordOverview key={index} record={record} signal={signal} />)}
    </details>}
    {scope.scope && <JsonDetails label={t("radar.payload.instrumentation")} value={scope.scope} />}
  </div>;
}
export function DecodedPayload({ payload, signal, sessions = [] }: { payload: Obj; signal: CapturedExport["signal"]; sessions?: RadarSession[] }) {
  const t = useT();
  const group = signal === "traces" ? "Spans" : signal === "logs" ? "Logs" : "Metrics";
  const item = signal === "traces" ? "spans" : signal === "logs" ? "logRecords" : "metrics";
  const resources = arr(payload["resource" + group]).map(obj);
  const fields = resources.flatMap(resource => {
    const common = attributes(obj(resource.resource).attributes);
    const records = arr(resource["scope" + group]).flatMap(s => arr(obj(s)[item]).map(obj));
    if (!records.length) return [common];
    return records.flatMap(record => {
      const base = { ...common, ...attributes(record.attributes) };
      const kind = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"].find(key => record[key]);
      const points = kind ? arr(obj(record[kind]).dataPoints) : [];
      return points.length ? points.map(point => ({ ...base, ...attributes(obj(point).attributes) })) : [base];
    });
  });
  return <div className="tr-decoded">
    <ProjectContext fields={fields} sessions={sessions} />
    <ContentEvidence fields={fields} />
    <details className="tr-details tr-export-scope"><summary>{t("radar.payload.aboutContent")}</summary><p className="tr-note">{t("radar.payload.aboutContentNote")}</p></details>
    {resources.map((resource, index) => <section key={index}>
      {arr(resource["scope" + group]).map((scope, index) => <ScopeOverview key={index} scope={obj(scope)} signal={signal} item={item} />)}
      <details className="tr-details"><summary>{t("radar.payload.resource")}</summary><Attributes value={obj(resource.resource).attributes} /></details>
    </section>)}
  </div>;
}
/** The one thing monitoring cannot do by itself: packet capture needs an
 *  administrator, once. The card says what Allow capture changes before the
 *  system asks for a password (traffic-radar-permission.mjs). Windows has no
 *  such step: Npcap's free edition is the person's own to install. */
function CaptureSetup({ platform, install, asking, permission, onAllow, onCopy, copied }: {
  platform?: string; install: boolean; asking: boolean; permission: PermissionResult | null;
  onAllow: () => void; onCopy: (text: string) => void; copied: boolean;
}) {
  const t = useT();
  const windows = platform === "win32", mac = platform === "darwin";
  const fallback = permission && (permission.outcome === "unavailable" || permission.outcome === "failed");
  return <section className="tr-activation" aria-labelledby="tr-setup-title"><strong id="tr-setup-title">{t("radar.setup.title")}</strong>
    <p className="tr-note">{t(windows ? "radar.setup.whyWin" : mac ? "radar.setup.whyMac" : "radar.setup.whyLinux")}</p>
    <p className="tr-note">{windows ? t(install ? "radar.setup.winInstall" : "radar.setup.winRestricted") : mac ? t("radar.setup.mac") : t(install ? "radar.setup.linuxInstall" : "radar.setup.linux")}</p>
    {windows
      ? <a className="btn primary" href="https://www.wireshark.org/download.html" target="_blank" rel="noreferrer">{t("radar.setup.wireshark")}</a>
      : <button type="button" className="btn primary" aria-busy={asking} onClick={() => { if (!asking) onAllow(); }}>{asking ? t("radar.setup.waiting") : t("radar.setup.allow")}</button>}
    <div role="status">
      {permission?.outcome === "cancelled" && <p className="tr-note">{t("radar.setup.cancelled")}</p>}
      {permission?.outcome === "granted" && <p className="tr-note">{t("radar.setup.granted")}</p>}
      {fallback && <p className="tr-note">{serverText(permission.message, t)}{permission.command && " " + t("radar.setup.runInstead")}</p>}
    </div>
    {fallback && permission.command && <div className="tr-command-entry"><div><button type="button" className="btn" onClick={() => onCopy(permission.command!)}>{copied ? t("radar.copied") : t("radar.setup.copyCommand")}</button></div><pre className="tr-command">{permission.command}</pre></div>}
  </section>;
}
export function TelemetryCapture({ capture, radar, failed, busy, pendingAction = null, error, permission = null, action, sessionFilter = "all", sessions = [] }: {
  capture: CaptureSnapshot | null; radar: RadarSnapshot | null; failed: boolean; busy: boolean; pendingAction?: CaptureAction | null; error: string;
  permission?: PermissionResult | null;
  action: (kind: CaptureAction) => Promise<void>;
  sessionFilter?: string; sessions?: RadarSession[];
}) {
  const t = useT();
  const configured = configuredDestinations([...(radar?.config?.variables ?? []), ...(radar?.environment ?? [])]);
  const addresses = [...new Set(configured.map(captureAddress).filter((v): v is string => !!v))];
  const [selectedObservation, setSelectedObservation] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [messageDestination, setMessageDestination] = useState("all");
  const [filter, setFilter] = useState("all");
  const workspace = useRef<HTMLDivElement>(null);
  const [feedWidth, setFeedWidth] = useState(() => { const value = Number(readStored(FEED_WIDTH_KEY)); return value >= 28 && value <= 65 ? value : 34; });
  const saveFeedWidth = (value: number) => { setFeedWidth(value); writeStored(FEED_WIDTH_KEY, String(value)); };
  const [promptsOnly, setPromptsOnly] = useState(false);
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
  const hasHistory = !!(retained.length || capture?.observations?.length);
  const retainedById = new Map(retained.map(event => [event.id, event]));
  const events = paused ? paused.map(event => retainedById.get(event.id)).filter((event): event is CapturedExport => !!event) : retained;
  const rows = events.filter(e => (!promptsOnly || e.content.includes("Prompt")) && (filter === "all" || e.signal === filter) && (messageDestination === "all" || messageDestination === e.destination) &&
    (sessionFilter === "all" || (sessionFilter === "unidentified" ? !e.sessionIds?.length : e.sessionIds?.includes(sessionFilter))));
  const observations = (capture?.observations ?? []).filter(e => !promptsOnly && (pausedObservationIds === null || pausedObservationIds.includes(e.id)) && filter === "all" && (sessionFilter === "all" || sessionFilter === "unidentified") && (messageDestination === "all" || messageDestination === e.destination));
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
  useEffect(() => { setSelected(null); setSelectedObservation(null); setVisibleCount(100); }, [sessionFilter, filter, messageDestination, promptsOnly]);
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
      if (!response.ok) throw new Error(t("radar.insp.expired"));
      const data = await response.json();
      if (alive && !controller.signal.aborted) setDetail({ id, payload: data.payload });
    }).catch(value => { if (alive) setDetail({ id, error: controller.signal.aborted ? t("radar.insp.timeout") : value instanceof Error ? value.message : t("radar.insp.readFailed") }); })
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
  const platform = capture?.platform ?? radar?.platform;
  const monitor = radarMonitorState(capture, failed, t);
  const running = monitor.enabled;
  const managed = !!capture?.managed;
  // Monitoring is always on (traffic-radar-service.mjs): no Start, no Stop and
  // no destination to pick. What can stand in its way is the one-time setup.
  const setupNeeded = managed && (monitor.permission || monitor.install);
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
  const copy = async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); } catch { setCopied("failed"); }
  };
  const sessionName = (ids: string[] = []) => ids.length ? ids.map(id => `${sessions.find(s => s.id === id)?.label ?? t("radar.session")} · ${id.slice(0, 8)}`).join(", ") : t("radar.session.unidentified");
  const liveAddresses = new Set([...(capture?.sources?.map(s => s.destination) ?? []), ...addresses]);
  const connections = radar?.status === "observing" ? radar.connections.filter(c => c.active && liveAddresses.has(c.destination)) : [];
  return <div className="tr-telemetry">
    <div className="tr-capture-bar">
      <div><h3 role="status" aria-live="polite"><span className={`tr-live-dot tr-dot-${monitor.tone}`} />{state}</h3>
        <p className="tr-note">{failed ? t("radar.cap.noteFailed") : setupNeeded ? capture?.sources?.length ? t("radar.cap.noteSetupFound") : t("radar.cap.noteSetup") : running ? !capture?.sources?.length && !capture?.destination ? t("radar.cap.noteLooking") : active ? t("radar.cap.noteListening", { active, count: sourceCount, traffic: monitor.traffic ? t("radar.cap.trafficSeen") : t("radar.cap.trafficNone") }) : t("radar.cap.noteNotReady") : t("radar.cap.noteIdle")}</p>
        {running && (capture?.sources?.length || capture?.destination) && <div className="tr-active-destinations" role="group" aria-label={t("radar.cap.monitored")}><span>{t("radar.cap.destination", { count: sourceCount })}</span>{capture?.sources?.length ? capture.sources.map(source => <span className="tr-destination-entry" key={source.destination}><code>{source.destination}</code>{(sourceCount > 1 || !source.active) && <span className={source.active ? "tr-source-ready" : "tr-source-pending"}>{source.active ? t("radar.cap.sourceReady") : t("radar.cap.sourcePending")}</span>}{!source.active && source.error && !setupNeeded && <span className="tr-source-error">{source.error}</span>}</span>) : capture?.destination && <code>{capture.destination}</code>}</div>}
      </div>
    </div>

    {radar?.status === "unsupported" && <p className="tr-capture-error" role="status">{t("radar.cap.unsupported")}</p>}
    {capture?.setupError && !setupNeeded && <p className="tr-capture-error" role="status">{serverText(capture.setupError, t)}</p>}
    {error && <p className="tr-capture-error" role="alert">{serverText(error, t)}</p>}
    {setupNeeded && <CaptureSetup platform={platform} install={monitor.install} asking={pendingAction === "permission"} permission={permission}
      onAllow={() => void action("permission")} onCopy={text => void copy(text, "setup")} copied={copied === "setup"} />}
    {copied === "failed" && <p className="tr-capture-error" role="alert">{t("radar.clipboard.text")}</p>}

    <div className="tr-workspace" data-empty={!hasHistory} ref={workspace} style={{ "--tr-feed-width": `${feedWidth}%` } as React.CSSProperties}>
      <section className="tr-feed" aria-label={t("radar.feed.label")}>
        {hasHistory && <div className="tr-feed-head"><h3>{t("radar.feed.activity")} <span className="tr-count">{activity.length}</span></h3>
          <label className="tr-prompt-filter" title={t("radar.feed.promptHint")}>
            <span>{t("radar.feed.withPrompt")}</span><button type="button" className="switch" role="switch" aria-label={t("radar.feed.withPrompt")} aria-checked={promptsOnly} onClick={() => setPromptsOnly(value => !value)}><span className="switch-knob" /></button>
          </label>
        </div>}
        {(hasHistory || paused !== null || filter !== "all" || messageDestination !== "all") && <details className="tr-details tr-feed-options">
          <summary>{t(filter !== "all" || messageDestination !== "all" ? "radar.feed.filtered" : "radar.feed.filters")}</summary>
          <div className="tr-filter"><label><RadarSelect aria-label={t("radar.feed.type")} value={filter} onChange={e => { setSelected(null); setFilter(e.target.value); }}><option value="all">{t("radar.feed.allTypes")}</option><option value="logs">{t("radar.feed.events")}</option><option value="metrics">{t("radar.feed.metrics")}</option><option value="traces">{t("radar.feed.traces")}</option></RadarSelect></label><label><RadarSelect aria-label={t("radar.feed.destination")} value={messageDestination} onChange={e => { setSelected(null); setMessageDestination(e.target.value); }}><option value="all">{t("radar.feed.allDestinations")}</option>{[...new Set([...addresses, ...(capture?.sources?.map(s => s.destination) ?? []), ...retained.map(e => e.destination), ...(capture?.observations ?? []).map(e => e.destination)])].map(address => <option key={address} value={address}>{address}</option>)}</RadarSelect></label></div>
          <div className="tr-history-toolbar"><p className="tr-history" title={t("radar.feed.historyHint")}>{t("radar.feed.history", { decoded: rows.length, observed: observations.length })}</p>
          <div className="tr-capture-actions"><button className="btn" aria-pressed={paused !== null} title={paused ? t("radar.feed.resumeHint") : t("radar.feed.pauseHint")} disabled={!events.length && !observations.length && paused === null} onClick={() => { setPaused(paused ? null : [...events]); setPausedObservationIds(paused ? null : (capture?.observations ?? []).map(entry => entry.id)); }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paused ? <path d="m9 5 11 7-11 7z" /> : <path d="M8 5v14M16 5v14" />}</svg><span className="tr-action-label">{paused ? t("radar.feed.resume") : t("radar.feed.pause")}</span></button><button className={clearArmed ? "btn danger armed" : "btn"} {...pressProps("clear")} disabled={pressProps("clear").disabled || (!capture?.events.length && !capture?.observations?.length)} title={clearArmed ? t("radar.feed.clearArmedHint") : t("radar.feed.clearHint")} onBlur={() => setClearArmed(false)} onClick={clearHistory}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg><span className={clearArmed ? "" : "tr-action-label"}>{clearArmed ? t("radar.feed.clearConfirm") : t("radar.feed.clear")}</span></button></div></div>
        </details>}
        {paused && <p className="tr-list-notice" role="status">{newCount > 0 ? t("radar.feed.pausedNew", { count: newCount }) : t("radar.feed.paused")}</p>}
        {capture?.retention?.evictedExports ? <p className="tr-note">{t("radar.feed.evicted", { count: capture.retention.evictedExports, n: formatNumber(capture.retention.evictedExports, 0) })}</p> : null}
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
          <RadarIcon kind={item.event.signal} className="tr-row-icon" /><span className="tr-event-top"><strong className="tr-event-name" title={item.event.name}>{item.event.name}</strong><time dateTime={new Date(item.event.at).toISOString()}>{stamp(item.event.at)}</time></span>
          {item.event.content.includes("Prompt") && <RadarPromptPreview event={item.event} />}
          <span className="tr-event-context" title={sessionName(item.event.sessionIds)}>{sessionName(item.event.sessionIds)}</span>
          <span className="tr-event-bottom"><span className={`tr-receipt ${item.event.outcome === "accepted" ? "tr-tone-ok" : item.event.outcome === "rejected" ? "tr-tone-error" : item.event.outcome === "partial" ? "tr-tone-enabled" : ""}`}>{t(`radar.receipt.${["accepted", "unconfirmed", "partial", "rejected"].includes(item.event.outcome) ? item.event.outcome : "unknown"}`)}</span><span>{t("radar.feed.records", { count: item.event.count })}</span></span>
        </button></li> : <li key={`observation-${item.event.id}`}><button className="tr-message" aria-pressed={selectedObservation === item.event.id} onClick={() => { setSelected(null); setSelectedObservation(item.event.id); if (window.matchMedia?.("(max-width: 640px)").matches) { inspector.current?.focus({ preventScroll: true }); inspector.current?.scrollIntoView({ block: "start", behavior: "auto" }); } }}>
          <RadarIcon kind="connection" className="tr-row-icon" /><span className="tr-event-top"><strong className="tr-event-name">{t("radar.feed.connection")}</strong><time dateTime={new Date(item.event.at).toISOString()}>{stamp(item.event.at)}</time></span><span className="tr-event-context" title={item.event.destination}>{item.event.destination} · {item.event.reason === "encrypted" ? t("radar.feed.encrypted") : t("radar.feed.undecoded")}</span>
        </button></li>)}</ul> : <div className="tr-empty-capture">{!hasHistory && <RadarIcon kind="radar" />}<h4>{retained.length || capture?.observations?.length ? t("radar.feed.noMatch") : setupNeeded ? t("radar.feed.notListening") : t("radar.feed.waiting")}</h4>
          <p className="tr-note">{retained.length || capture?.observations?.length ? promptsOnly ? t("radar.feed.noPrompts") : t("radar.feed.tryOther") : setupNeeded ? t("radar.feed.afterAllow") : t("radar.feed.autoMonitor")}</p>
        </div>}
        {activity.length > visibleCount && <button className="btn" onClick={() => setVisibleCount(count => count + 100)}>{t("radar.feed.older")}</button>}
        {connections.length > 0 && <details className="tr-details"><summary>{t("radar.feed.connections", { count: connections.length })}</summary><ul className="tr-live-connections">{connections.map(c => <li key={`${c.pid}:${c.destination}`}><code>{c.destination}</code><span>Claude · {c.connecting && <><span className="tr-attempt">{connectionLabel(c, false, t)}</span> · </>}PID {c.pid} · {c.workspace ?? t("radar.workspaceUnknown")}</span></li>)}</ul><p className="tr-note">{t("radar.feed.connectionsNote")}</p></details>}
      </section>
      {hasHistory && <RadarSplitter workspace={workspace} width={feedWidth} onCommit={saveFeedWidth} />}
      <section className="tr-inspector" hidden={!hasHistory} aria-label={t("radar.insp.label")} ref={inspector} tabIndex={-1}>
        {observation ? <div>
          <div className="tr-inspector-head"><h3><RadarIcon kind="connection" />{t("radar.insp.connection")}</h3></div>
          <dl className="tr-facts"><div><dt>{t("radar.destination")}</dt><dd className="tr-fact-copy"><code>{observation.destination}</code><button className="tr-inline-copy" aria-label={t("radar.insp.copyDestination")} onClick={() => void copy(observation.destination, "destination")} title={copied === "destination" ? t("radar.insp.copiedDestination") : t("radar.insp.copyDestination")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copied === "destination" ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>}</svg></button></dd></div><div><dt>{t("radar.insp.observed")}</dt><dd><time dateTime={new Date(observation.at).toISOString()}>{new Date(observation.at).toLocaleString(currentLanguage())}</time></dd></div><div><dt>{t("radar.insp.source")}</dt><dd><code>{observation.source || t("radar.insp.notIdentified")}</code></dd></div><div><dt>{t("radar.insp.contents")}</dt><dd>{observation.reason === "encrypted" ? t("radar.insp.encrypted") : t("radar.insp.notDecoded")}</dd></div><div><dt>{t("radar.insp.session")}</dt><dd>{t("radar.insp.notIdentified")}</dd></div></dl>
          <div className="tr-inspection-limit"><RadarIcon kind="info" /><div><h4>{observation.reason === "encrypted" ? t("radar.insp.encryptedTitle") : t("radar.insp.unavailableTitle")}</h4><p>{observation.reason === "joined_midstream" ? t("radar.insp.joined") : observation.reason === "encrypted" ? t("radar.insp.https") : issueText(observation.reason, t) ?? t("radar.issue.fallbackConnection")}</p><details className="tr-details"><summary>{t("radar.insp.technical")}</summary><p className="tr-note">{issueText(observation.reason, t) ?? t("radar.issue.fallbackDecoder")}</p><p className="tr-note">{t("radar.insp.noJson")} {observation.reason === "joined_midstream" && t("radar.insp.noRebuild")}</p></details></div></div>
        </div> : chosen ? <>
          <div className="tr-inspector-head"><h3><RadarIcon kind={chosen.signal} />{chosen.name}</h3><p className="tr-note">{t(`radar.insp.decoded.${chosen.signal}`, { session: sessionName(chosen.sessionIds), time: stamp(chosen.at) })}</p></div>
          <div className="tr-detail-tabs" role="group" aria-label={t("radar.insp.format")}><button className="btn" aria-pressed={view === "summary"} onClick={() => setView("summary")}>{t("radar.insp.overview")}</button><button className="btn" aria-pressed={view === "json"} onClick={() => setView("json")}>JSON</button>
            <button className="btn tr-copy-json" disabled={!detail?.payload || detail.id !== chosen.id} onClick={() => void copy(JSON.stringify(detail?.payload, null, 2), "json")}>{copied === "json" ? t("radar.copied") : t("radar.copyJson")}</button></div>
          {detail?.id === chosen.id ? detail.payload ? view === "json" ? <><p className="tr-note">{t("radar.insp.otlp")}</p><JsonInspector key={chosen.id} value={detail.payload} /></> : <>
            <DecodedPayload key={chosen.id} payload={detail.payload} signal={chosen.signal} sessions={sessions} />
            <details className="tr-details"><summary>{t("radar.insp.transfer")}</summary>
            <dl className="tr-facts"><div><dt>{t("radar.destination")}</dt><dd className="tr-fact-copy"><code>{chosen.destination}</code><button className="tr-inline-copy" aria-label={t("radar.insp.copyDestination")} onClick={() => void copy(chosen.destination, "destination")} title={copied === "destination" ? t("radar.insp.copiedDestination") : t("radar.insp.copyDestination")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copied === "destination" ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>}</svg></button></dd></div><div><dt>{t("radar.insp.time")}</dt><dd>{stamp(chosen.at)}</dd></div><div><dt>{t("radar.insp.receipt")}</dt><dd>{outcomeLabel(chosen, t)}</dd></div><div><dt>{t("radar.insp.size")}</dt><dd>{t("radar.insp.sizeValue", { bytes: formatNumber(chosen.bytes, 0), records: t("radar.feed.records", { count: chosen.count }) })}</dd></div>
              {chosen.response?.message && <div><dt>{t("radar.insp.response")}</dt><dd><Value value={chosen.response.message} /></dd></div>}
            </dl></details>
          </> : <div role="alert"><p>{detail.error}</p><button className="btn" onClick={() => setRetry(retry + 1)}>{t("radar.retry")}</button></div> : <p className="tr-note" role="status">{t("radar.insp.loading")}</p>}
        </> : <div className="tr-inspector-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-3 4 3 4M14 8l3 4-3 4" /></svg><h3>{selected !== null || selectedObservation !== null ? t("radar.insp.goneTitle") : t("radar.insp.emptyTitle")}</h3><p className="tr-note">{selected !== null || selectedObservation !== null ? t("radar.insp.goneNote") : monitor.traffic && !monitor.decoded ? t("radar.insp.trafficNote") : t("radar.insp.selectNote")}</p></div>}
      </section>
    </div>
    <footer className="tr-monitor-footer">{(running || hasHistory || failed) && <span>{t("radar.foot.memory", { state: failed ? t("radar.foot.interrupted") : running ? (managed ? t("radar.foot.continuous") : t("radar.foot.local")) : t("radar.foot.off") })}</span>}<details><summary>{t("radar.foot.limits")}</summary><div>
      <p>{t("radar.foot.p1")}</p>
      <p>{t("radar.foot.p2")}</p>
      <p>{t("radar.foot.p3")}</p>
      {capture?.bytes ? <p>{t("radar.foot.bytes", { bytes: formatNumber(capture.bytes, 0) })}</p> : null}
      {managed && <p>{t("radar.foot.always")}</p>}
      {Object.entries(capture?.issues ?? {}).map(([code, count]) => <p key={code}>{t("radar.foot.issue", { text: issueText(code, t) ?? t("radar.issue.fallbackLimit"), count })}</p>)}
    </div></details></footer>
  </div>;
}
