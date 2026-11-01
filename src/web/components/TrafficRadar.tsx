import { RadarIcon } from "./RadarIcon";
import { RadarSelect } from "./RadarSelect";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { connectionLabel, type RadarSnapshot, type RadarVariable } from "../traffic-radar";
import { configuredDestinations, configuredKind, configuredState, observedDestinations, type RadarSession } from "../telemetry-inspection";
import { pressAccepted, pressState } from "../panel-press";
import { tabStripMove } from "../tablist-keys";
import { useTrafficRadar } from "../use-traffic-radar";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { useTelemetryCapture } from "../use-telemetry-capture";
import { TelemetryCapture } from "./TelemetryCapture";
import { TelemetryFile } from "./TelemetryFile";
import { useT } from "../i18n";
import { OwnError, ownMessage } from "../own-error";
import { serverText } from "../radar-server-text";

export default function TrafficRadar({ onClose, sessions = [] }: { onClose: () => void; sessions?: RadarSession[] }) {
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const { snapshot, failed, updateConfig } = useTrafficRadar();
  const captureState = useTelemetryCapture();
  return <div className="modal-backdrop" {...scrimPress} role="presentation">
    <div className="modal tr-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tr-title" aria-describedby="tr-purpose" onClick={e => e.stopPropagation()}>
      <TrafficRadarView snapshot={snapshot} failed={failed} captureState={captureState} sessions={sessions} onConfigChange={updateConfig} onClose={onClose} />
    </div>
  </div>;
}

export function TrafficRadarView({ snapshot, failed = false, captureState, sessions = [], onConfigChange, onClose }: {
  snapshot: RadarSnapshot | null; failed?: boolean; captureState?: ReturnType<typeof useTelemetryCapture>; sessions?: RadarSession[];
  onConfigChange?: (config: RadarSnapshot["config"]) => void; onClose?: () => void;
}) {
  const t = useT();
  // The File view stays: a saved telemetry file is read in the browser, apart
  // from live capture, as it was before the inspector's rework.
  const [page, setPage] = useState<"monitor" | "configuration" | "file">("monitor");
  const [fileSessions, setFileSessions] = useState<string[]>([]);
  const [session, setSession] = useState("all");
  const pages = ["monitor", "configuration", "file"] as const;
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = tabStripMove(event, pages.indexOf(page), pages.length);
    if (move.kind !== "select") return;
    event.preventDefault();
    const next = pages[move.index];
    setPage(next);
    document.getElementById(`tr-tab-${next}`)?.focus();
  };
  const variables = [...(snapshot?.config?.variables ?? []), ...(snapshot?.environment ?? [])];
  const destinations = configuredDestinations(variables);
  const state = configuredState(variables, t);
  const stateKind = configuredKind(variables);
  const incomplete = snapshot?.config?.sources.some(source => source.status === "unavailable");
  const observed = failed ? [] : observedDestinations(snapshot);
  const choices = new Map(sessions.map(s => [s.id, s.label]));
  for (const event of captureState?.capture?.events ?? []) for (const id of event.sessionIds ?? []) if (!choices.has(id)) choices.set(id, t("radar.session"));
  for (const id of fileSessions) if (!choices.has(id)) choices.set(id, t("radar.session"));
  return <div className="tr-body">
    <header className="modal-head tr-header">
      <div className="tr-identity"><div className="modal-title"><span className="modal-tool-name" id="tr-title">{t("radar.title")}</span><span className="tr-beta" title={t("radar.betaHint")}>{t("radar.beta")}</span></div><p id="tr-purpose">{t("radar.purpose")}</p></div>
    <div className="tr-navigation">
      {/* Written out rather than mapped, so each tab names its panel's id as the panel spells it. */}
      <div className="tr-tabs" role="tablist" aria-label={t("radar.views")} onKeyDown={handleTabKeyDown}>
        <button id="tr-tab-monitor" className="tr-tab" role="tab" aria-selected={page === "monitor"} aria-controls="tr-panel-monitor" tabIndex={page === "monitor" ? 0 : -1} onClick={() => setPage("monitor")}>{t("radar.tab.monitor")}</button>
        <button id="tr-tab-configuration" className="tr-tab" role="tab" aria-selected={page === "configuration"} aria-controls="tr-panel-configuration" tabIndex={page === "configuration" ? 0 : -1} onClick={() => setPage("configuration")}>{t("radar.tab.configuration")}</button>
        <button id="tr-tab-file" className="tr-tab" role="tab" aria-selected={page === "file"} aria-controls="tr-panel-file" tabIndex={page === "file" ? 0 : -1} onClick={() => setPage("file")}>{t("radar.tab.file")}</button>
      </div>
      <label className="tr-session-filter" hidden={!choices.size && session === "all" && !captureState?.capture?.events.length}>{t("radar.session")}<RadarSelect value={session} onChange={e => setSession(e.target.value)} aria-label={t("radar.session")}>
        <option value="all">{t("radar.session.all")}</option>{[...choices].map(([id, label]) => <option key={id} value={id}>{label} · {id.slice(0, 8)}</option>)}<option value="unidentified">{t("radar.session.unidentified")}</option>
      </RadarSelect></label>
      <details className="tr-help"><summary><RadarIcon kind="info" /><span className="tr-help-label">{t("radar.about")}</span></summary><div>
        <h3>{t("radar.about.title")}</h3>
        <p>{t("radar.about.p1")}</p>
        <p>{t("radar.about.p2")}</p>
        <p>{t("radar.about.p3")}</p>
        <a href="https://code.claude.com/docs/en/monitoring-usage" target="_blank" rel="noreferrer">{t("radar.about.docs")}</a>
      </div></details>
    </div>
      {onClose && <button className="glyph-btn tr-header-close" onClick={onClose} aria-label={t("radar.close")} title={t("radar.close")}>×</button>}
    </header>
    {/* Keep views mounted: selecting Configuration must not discard the selected message or imported file. */}
    <div className="tr-page" id="tr-panel-monitor" role="tabpanel" aria-labelledby="tr-tab-monitor" hidden={page !== "monitor"}>
      {captureState ? <TelemetryCapture {...captureState} radar={failed && snapshot ? { ...snapshot, status: "unavailable" } : snapshot} sessionFilter={session} sessions={sessions} /> : <p className="tr-empty">{t("radar.readingStatus")}</p>}
    </div>
    <div className="tr-page tr-configuration-page" id="tr-panel-configuration" role="tabpanel" aria-labelledby="tr-tab-configuration" hidden={page !== "configuration"}>
    <div className="tr-summary">
      <div className="tr-summary-state"><span className={`tr-state ${failed || !snapshot || incomplete ? "tr-tone-unknown" : stateKind === "enabled" ? "tr-tone-enabled" : "tr-tone-unknown"}`}>{failed ? t("radar.cfg.unavailable") : !snapshot ? t("radar.cfg.reading") : incomplete ? t("radar.cfg.incomplete") : stateKind === "unknown" ? t("radar.cfg.unknown") : state}</span>
        <span className="tr-note">{destinations.length ? t("radar.cfg.destinations", { count: destinations.length }) : t("radar.cfg.noDestination")}</span></div>
      {destinations.length > 0 && <div className="tr-endpoints">{destinations.map(destination => <code key={destination}>{destination}</code>)}</div>}
      {!destinations.length && observed.length > 0 && <div className="tr-observed-summary"><span className="tr-state">{t("radar.cfg.observed")}</span><div className="tr-endpoints">{observed.map(address => <code key={address}>{address}</code>)}</div><p className="tr-note">{t("radar.cfg.observedNote")}</p></div>}
    </div>
      {snapshot ? <Configuration snapshot={snapshot} stale={failed} onConfigChange={onConfigChange} sessionLabel={session === "all" ? undefined : choices.get(session) ?? session} /> : <p className="tr-empty">{failed ? t("radar.cfg.readFailed") : t("radar.cfg.readingLocal")}</p>}
    </div>
    <div className="tr-page" id="tr-panel-file" role="tabpanel" aria-labelledby="tr-tab-file" hidden={page !== "file"}><TelemetryFile onSessions={setFileSessions} sessionFilter={session} /></div>
  </div>;
}

export function Configuration({ snapshot, sessionLabel, stale = false, onConfigChange }: { snapshot: RadarSnapshot; sessionLabel?: string; stale?: boolean; onConfigChange?: (config: RadarSnapshot["config"]) => void }) {
  const t = useT();
  const LAUNCH_NOTE = t("radar.config.launchNote");
  const [savedConfig, setSavedConfig] = useState<RadarSnapshot["config"]>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const savingRef = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const incomplete = (savedConfig ?? snapshot.config)?.sources.some(source => source.status === "unavailable");
  useEffect(() => { setSavedConfig(null); }, [snapshot.config]);
  const variables = [...((savedConfig ?? snapshot.config)?.variables ?? []), ...(snapshot.environment ?? [])];
  const uninspected = snapshot.uninspected ?? 0;
  const toggle = async (key: string, enabled: boolean) => {
    if (!pressAccepted(savingRef.current) || stale) return;
    savingRef.current = key;
    setSaving(key); setError(""); setNotice("");
    const request = new AbortController();
    const timeout = setTimeout(() => request.abort(), 20_000);
    try {
      const response = await fetch("/api/system/traffic-radar/configuration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, enabled }), signal: request.signal });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new OwnError(result.error ? serverText(result.error) : t("radar.config.saveFailed"));
      setSavedConfig(result.config);
      onConfigChange?.(result.config);
      setNotice(t("radar.config.saved"));
    } catch (err) { setError(request.signal.aborted ? t("radar.config.saveTimeout") : ownMessage(err, t("radar.config.saveRetry"))); }
    finally {
      clearTimeout(timeout);
      savingRef.current = null; setSaving(null);
    }
  };
  const destinations = variables.filter(v => v.key.endsWith("ENDPOINT"));
  const names: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: t("radar.flag.telemetry"), OTEL_LOG_USER_PROMPTS: t("radar.flag.prompts"), OTEL_LOG_ASSISTANT_RESPONSES: t("radar.flag.responses"), OTEL_LOG_TOOL_DETAILS: t("radar.flag.toolDetails"), OTEL_LOG_TOOL_CONTENT: t("radar.flag.toolContent"), OTEL_LOG_RAW_API_BODIES: t("radar.flag.apiBodies"), OTEL_LOG_MANAGED_SETTINGS: t("radar.flag.managed"), CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: t("radar.flag.enhanced"), ENABLE_ENHANCED_TELEMETRY_BETA: t("radar.flag.enhanced") };
  // A flag no settings file names still gets a switch. Rows sort by flag and an
  // unset row is keyed as the user-settings row it becomes, so saving keeps the
  // switch in place and focused.
  const order = Object.keys(names);
  const rank = (key: string) => order.includes(key) ? order.indexOf(key) : order.length;
  const unset = ((savedConfig ?? snapshot.config)?.unsetFlags ?? []).map(key => ({ key, value: "Not set", source: "User settings", unset: true, editable: true }));
  const flags: (RadarVariable & { unset?: boolean })[] = [...variables.filter(v => v.key.startsWith("OTEL_LOG_") || v.key.includes("ENABLE") || v.key.includes("TELEMETRY_BETA")), ...unset].sort((a, b) => rank(a.key) - rank(b.key));
  return <section className="tr-config" aria-label={t("radar.config.label")}>
    <h3>{t("radar.config.title")}</h3>
    {stale && <p className="tr-warning" role="status">{t("radar.config.stale")}</p>}
    {incomplete && <p className="tr-warning" role="status">{t("radar.config.incomplete")}</p>}
    <p className="tr-note">{snapshot.environment?.length ? t("radar.config.readEnv") : t("radar.config.read")}</p>
    {uninspected > 0 && <p className="tr-note">{t("radar.config.uninspected", { count: uninspected })}</p>}
    {sessionLabel && <p className="tr-note">{t("radar.config.session", { session: sessionLabel })}</p>}
    <h4>{t("radar.config.destinations")}</h4>
    {destinations.length ? <ul className="tr-destinations">{destinations.map(v => <li key={`${v.source}:${v.key}`}><code>{v.value}</code><span>{serverText(v.source, t)} · {v.key}</span></li>)}</ul> : <p className="tr-note">{t("radar.config.noDestination")}</p>}

    <h4>{t("radar.config.flags")}</h4>
    <p className="tr-note">{t("radar.config.flagsNote")}</p>
    {notice && <p className="tr-note" role="status">{notice}</p>}
    {error && <p className="tr-warning" role="alert">{error}</p>}
    {flags.length ? <dl className="tr-variables tr-flags">{flags.map(v => {
      const enabled = v.value.startsWith("Enabled");
      const known = enabled || v.value === "Disabled" || v.unset;
      const control = pressState(saving, v.key);
      const source = v.unset ? t("radar.config.notInFile") : serverText(v.source, t);
      const label = t("radar.config.flagLabel", { name: names[v.key] ?? v.key, source: v.unset ? t("radar.config.notSet") : serverText(v.source, t) });
      // A launch value belongs to a running process: no settings state makes it editable or unavailable.
      const launch = v.launch === true;
      const unavailable = !launch && (stale || incomplete || (v.editable !== true && !v.blockedReason));
      const managed = !launch && v.editable !== true && !unavailable;
      const blockedText = v.blockedReason ? serverText(v.blockedReason, t) : undefined;
      // A managed flag shows its state on a locked switch, so the switch is there but cannot be moved.
      const flagSwitch = (locked: boolean, reason = blockedText) => <button type="button" className="switch" role="switch" data-tone="warn" aria-checked={enabled} aria-label={label} {...(locked ? { disabled: true, title: reason } : { "aria-busy": control.busy, disabled: control.disabled, title: enabled ? t("radar.config.turnOff") : t("radar.config.turnOn"), onClick: () => void toggle(v.key, !enabled) })}><span className="switch-knob" /></button>;
      return <div key={`${v.source}:${v.key}`}>
        <dt><strong>{names[v.key] ?? v.key}</strong><code>{v.key}</code><span>{source}</span>{v.blockedReason && !incomplete && <span>{blockedText}</span>}</dt>
        <dd className="tr-flag-control">
          <span className="tr-flag-value"><span className={`tr-state ${enabled ? "tr-tone-enabled" : "tr-tone-unknown"}`}>{serverText(v.value, t)}</span>{v.rawValue !== undefined && <code className="tr-raw-flag">{v.rawValue}</code>}</span>
          <span className="tr-flag-action">
            {launch ? <><span className="tr-control-note" title={LAUNCH_NOTE}>{t("radar.config.readonly")}</span>{known && flagSwitch(true, LAUNCH_NOTE)}</> : unavailable ? <span className="tr-control-note" title={blockedText}>{t("radar.config.unavailable")}</span> : managed ? <><span className="tr-control-note" title={blockedText}>{t("radar.config.managed")}</span>{known && flagSwitch(true)}</> : known ? flagSwitch(false) : <span className="tr-unknown-actions">{[true, false].map(value => <button type="button" key={String(value)} className="btn" aria-label={t(value ? "radar.config.enableLabel" : "radar.config.disableLabel", { name: label })} aria-busy={control.busy} disabled={control.disabled} onClick={() => void toggle(v.key, value)}>{value ? t("radar.config.enable") : t("radar.config.disable")}</button>)}</span>}
            {saving === v.key && <span className="tr-control-note" role="status">{t("radar.config.saving")}</span>}
          </span>
        </dd>
      </div>;
    })}</dl> : <p className="tr-note">{t("radar.config.noFlags")}</p>}
    {!destinations.length && snapshot.connections.length > 0 && <details className="tr-details"><summary>{t("radar.config.observedConnections", { count: snapshot.connections.length })}</summary><ul className="tr-live-connections">{snapshot.connections.map(c => <li key={`${c.pid}:${c.destination}`}><code>{c.destination}</code><span>{c.connecting && !stale && c.active !== null ? <span className="tr-attempt">{connectionLabel(c, false, t)}</span> : connectionLabel(c, stale, t)} · PID {c.pid} · {c.workspace ?? t("radar.workspaceUnknown")}</span></li>)}</ul><p className="tr-note">{t("radar.config.observedConnectionsNote")}</p></details>}
    <details className="tr-details"><summary>{t("radar.config.allVariables")}</summary>
      <dl className="tr-variables">{variables.map(v => <div key={`${v.source}:${v.key}`}><dt><code>{v.key}</code><span>{serverText(v.source, t)}</span></dt><dd>{serverText(v.value, t)}</dd></div>)}</dl>
      <ul className="tr-sources">{snapshot.config?.sources.map(source => <li key={source.name}><span>{serverText(source.name, t)}</span><span>{source.status === "read" ? t("radar.config.sourceRead") : source.status === "absent" ? t("radar.config.sourceAbsent") : t("radar.config.sourceUnavailable")}</span></li>)}</ul>
      <p className="tr-note">{t("radar.config.hidden")}</p>
    </details>
  </section>;
}
