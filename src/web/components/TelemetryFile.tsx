import { useRef, useState } from "react";
import { useT } from "../i18n";
import { OwnError, ownMessage } from "../own-error";
import { parseTelemetryFile, type TelemetryFileRow } from "../telemetry-inspection";
export function TelemetryFile({ sessionFilter = "all", onSessions }: { sessionFilter?: string; onSessions?: (ids: string[]) => void }) {
  const t = useT();
  const [rows, setRows] = useState<TelemetryFileRow[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const inspect = async (file: File | undefined) => {
    if (!file) return;
    const current = ++request.current;
    setError(""); setLoading(true); setCopied(false);
    try {
      if (file.size > 10 * 1024 * 1024) throw new OwnError(t("radar.fileview.tooBig"));
      const contents = await file.text();
      const parsed = parseTelemetryFile(contents);
      if (current !== request.current) return;
      onSessions?.([...new Set(parsed.flatMap(row => row.sessionIds))]);
      setRows(parsed); setName(file.name); setSelected(null); setSearch("");
      if (!parsed.length) setError(t("radar.fileview.empty"));
    } catch (value) { if (current === request.current) setError(ownMessage(value, t("radar.fileview.readFailed"))); }
    finally { if (current === request.current) setLoading(false); }
  };
  const matches = rows.filter(row => (sessionFilter === "all" || (sessionFilter === "unidentified" ? !row.sessionIds.length : row.sessionIds.includes(sessionFilter))) && (!search || row.raw.toLowerCase().includes(search.toLowerCase())));
  const shown = matches.slice(0, 200);
  const chosen = selected === null ? shown[0] : matches.find(row => row.line === selected);
  return <div className="tr-file">
    <div className="tr-file-toolbar"><div><h3>{t("radar.fileview.title")}</h3><p className="tr-note">{t("radar.fileview.note")}</p></div>
      <label className="btn tr-file-picker">{loading ? t("radar.fileview.reading") : name ? t("radar.fileview.another") : t("radar.fileview.open")}<input type="file" accept=".json,.jsonl,.ndjson,application/json" aria-label={t("radar.fileview.openLabel")} onChange={e => { void inspect(e.target.files?.[0]); e.target.value = ""; }} /></label></div>
    {error && <p className="tr-capture-error" role="alert">{error}</p>}
    <div className="tr-workspace" data-empty={rows.length === 0}><section className="tr-feed" aria-label={t("radar.fileview.records")}>
      {rows.length > 0 && <h3>{name || t("radar.fileview.records")} <span className="tr-count">{matches.length}</span></h3>}
      {rows.length > 0 && <input type="search" className="tr-input tr-search" aria-label={t("radar.fileview.searchLabel")} placeholder={t("radar.fileview.searchPlaceholder")} value={search} onChange={e => { setSearch(e.target.value); setSelected(null); }} />}
      {shown.length ? <ul className="tr-connections">{shown.map(row => <li key={row.line}><button className="tr-message" aria-pressed={chosen?.line === row.line} onClick={() => { setSelected(row.line); setCopied(false); }}><span className="tr-event-top"><span>{t("radar.fileview.line", { n: row.line })}</span><span className={!row.valid ? "tr-tone-enabled" : ""}>{row.valid ? "JSON" : t("radar.invalidJson")}</span></span><strong>{row.label}</strong>{row.timestamp && <span>{row.timestamp}</span>}<span>{row.sessionIds.join(", ") || t("radar.session.unidentified")}</span></button></li>)}</ul> : <div className="tr-empty-capture"><h4>{rows.length ? t("radar.fileview.noMatch") : t("radar.fileview.openTitle")}</h4><p className="tr-note">{rows.length ? t("radar.fileview.tryOther") : t("radar.fileview.choose")}</p></div>}
      {matches.length > shown.length && <p className="tr-note">{t("radar.fileview.first")}</p>}
    </section><section className="tr-inspector" hidden={!rows.length} aria-label={t("radar.fileview.contents")}>
      {chosen ? <><div className="tr-feed-head"><h3>{t("radar.fileview.line", { n: chosen.line })}</h3><button className="btn" onClick={() => { navigator.clipboard.writeText(chosen.raw).then(() => setCopied(true), () => setError(t("radar.clipboard.json"))); }}>{copied ? t("radar.copied") : t("radar.copyJson")}</button></div><p className="tr-note">{t("radar.fileview.original")}</p><pre className="tr-value">{chosen.raw}</pre></> : <div className="tr-inspector-empty"><h3>{t("radar.fileview.inspect")}</h3><p className="tr-note">{t("radar.fileview.select")}</p></div>}
    </section></div>
  </div>;
}
