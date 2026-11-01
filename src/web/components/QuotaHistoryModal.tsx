import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Providers } from "../providers";
import { currentLanguage, t as translate, useT } from "../i18n";
import { quotaPlot, quotaSeriesKey, type QuotaHistory, type QuotaSeries } from "../quota-history";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import ReadActivity from "./ReadActivity";
import { RefreshGlyph } from "./action-glyphs";

const timestamp = (ms: number) => new Date(ms).toLocaleString(currentLanguage(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit" });
type Provider = "claude" | "codex";

/** The window's name: the two the server records by id, anything else as it sent it. */
const windowLabel = (series: QuotaSeries) => series.id === "five_hour" || series.id === "seven_day" ? translate(`insights.quota.window.${series.id}`) : series.label;

/** How long ago a reading was taken. */
function captureAge(ms: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return translate("insights.quota.justNow");
  if (minutes < 60) return translate("insights.quota.minutesAgo", { m: minutes });
  if (minutes < 1440) return translate("insights.quota.hoursAgo", { h: Math.floor(minutes / 60), m: minutes % 60 });
  return translate("insights.quota.daysAgo", { d: Math.floor(minutes / 1440) });
}

function QuotaChart({ series }: { series: QuotaSeries }) {
  const t = useT();
  const segments = quotaPlot(series);
  const start = (series.resetAt - series.windowSec) * 1000;
  const end = series.resetAt * 1000;
  return <>
    <div className="qh-chart-wrap">
    <div className="qh-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
    <svg className="qh-chart" viewBox="36 12 516 150" role="img"
      aria-label={t("insights.quota.chartAria", { label: windowLabel(series) })}>
      {[0, 50, 100].map(used => <g key={used}>
        <line className="qh-grid" x1="36" x2="552" y1={12 + used * 1.5} y2={12 + used * 1.5} />
      </g>)}
      <path className="qh-guide" d="M36 12 L552 162" />
      {segments.map((segment, i) => <g key={i}>
        {segment.length > 1 && <path className="qh-observed" d={segment.map((p, j) => `${j ? "L" : "M"}${p.x} ${p.y}`).join(" ")} />}
        {[segment[0], ...(segment.length > 1 ? [segment.at(-1)!] : [])].map(p =>
          <circle className="qh-point" key={p.t} cx={p.x} cy={p.y} r="2.5"><title>{t("insights.quota.pointTitle", { when: timestamp(p.t), pct: Math.round(100 - p.pct) })}</title></circle>)}
      </g>)}
    </svg>
    <div className="qh-times" aria-hidden="true"><span>{series.windowSec > 86400 ? timestamp(start) : clock(start)}</span><span>{series.windowSec > 86400 ? timestamp(end) : clock(end)}</span></div>
    </div>
    <div className="qh-legend"><span><i className="qh-key" />{t("insights.quota.observed")}</span><span><i className="qh-key qh-key-guide" />{t("insights.quota.guide")}</span></div>
  </>;
}

export default function QuotaHistoryModal({ providers, accounts, onClose, instant = false }: {
  providers: Providers; accounts: { claude?: string; codex?: string }; onClose: () => void; instant?: boolean;
}) {
  const t = useT();
  const [provider, setProvider] = useState<Provider>(providers.claude ? "claude" : "codex");
  const [data, setData] = useState<QuotaHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selection, setSelection] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const busyRef = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const scrim = useScrimDismiss(onClose);
  const account = accounts[provider];

  useEffect(() => {
    let disposed = false;
    let current: AbortController | null = null;
    setData(null);
    setError(false);
    const read = async () => {
      if (current) return;
      if (!account) { busyRef.current = false; setLoading(false); return; }
      const controller = new AbortController();
      current = controller;
      busyRef.current = true;
      const deadline = window.setTimeout(() => controller.abort(), 12_000);
      setLoading(true);
      try {
        const res = await fetch(`/api/quota/history?provider=${provider}&account=${encodeURIComponent(account)}`, { signal: controller.signal });
        const reply = await res.json() as QuotaHistory;
        if (!res.ok || !reply.ok || !Array.isArray(reply.series)) throw new Error("History unavailable");
        if (!disposed) { setData(reply.account === account ? reply : { ...reply, series: [] }); setError(false); }
      } catch { if (!disposed) setError(true); }
      finally { window.clearTimeout(deadline); current = null; if (!disposed) { busyRef.current = false; setLoading(false); } }
    };
    void read();
    const timer = window.setInterval(() => { setNow(Date.now()); if (document.visibilityState === "visible") void read(); }, 60_000);
    return () => { disposed = true; current?.abort(); window.clearInterval(timer); };
  }, [provider, account, refresh]);

  const series = (data?.series ?? []).slice().sort((a, b) => b.resetAt - a.resetAt || a.windowSec - b.windowSec);
  const picked = series.find(s => quotaSeriesKey(s) === selection) ?? series.find(s => s.resetAt * 1000 > now && s.windowSec <= 6 * 3600) ?? series[0];
  const latest = picked?.points.at(-1);
  const refreshHistory = () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setRefresh(n => n + 1);
  };

  return createPortal(<div className="modal-backdrop" role="presentation" {...scrim}>
    <div className="modal qh-modal" data-keyboard-interaction={instant || undefined} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="quota-history-title">
      <header className="modal-head">
        <h2 id="quota-history-title">{t("insights.quota.title")}</h2>
        <div className="qh-header-actions">
          <button type="button" className="glyph-btn" aria-label={t("insights.quota.refresh")} title={t("insights.quota.read")} {...selfPressProps(loading)} onClick={refreshHistory}><RefreshGlyph /></button>
          <button type="button" ref={closeRef} className="glyph-btn" onClick={onClose} aria-label={t("insights.quota.close")}>×</button>
        </div>
      </header>
      <div className="modal-body qh-body" aria-busy={loading}>
        <div className="qh-controls">
          <div className="qh-providers" role="group" aria-label={t("insights.quota.provider")}>
            {(["claude", "codex"] as const).filter(p => providers[p]).map(p => <button type="button" className="qh-provider" key={p}
              aria-pressed={provider === p} onClick={() => { setProvider(p); setSelection(""); }}>{p === "claude" ? "Claude" : "Codex"}</button>)}
          </div>
          {series.length > 0 && <label className="qh-window">{t("insights.quota.window")}
            <select aria-label={t("insights.quota.windowAria")} value={picked ? quotaSeriesKey(picked) : ""} onChange={e => setSelection(e.target.value)}>
              {series.map(s => <option key={quotaSeriesKey(s)} value={quotaSeriesKey(s)}>{windowLabel(s)} · {timestamp(s.resetAt * 1000)}</option>)}
            </select>
          </label>}
        </div>
        {error && <p className="qh-message" role="status">{t("insights.quota.error")}{data && ` ${t("insights.quota.lastLoaded")}`}</p>}
        {picked && latest ? <div className="qh-result read-result">
          <div className="qh-summary"><strong>{t("insights.quota.remaining", { pct: Math.round(100 - latest.pct) })}</strong>
            <span title={timestamp(latest.t)}>{t("insights.quota.captured", { age: captureAge(latest.t, now) })}{picked.resetAt * 1000 <= now && ` · ${t("insights.quota.ended")}`}</span>
          </div>
          <QuotaChart series={picked} />
          <p className="qh-note">{t("insights.quota.note")}</p>
          <details className="qh-readings"><summary>{t("insights.quota.readings", { n: picked.points.length })}</summary>
            <table><caption>{picked.points.length > 50 ? t("insights.quota.latest50") : t("insights.quota.recorded")}</caption>
              <thead><tr><th scope="col">{t("insights.quota.colCaptured")}</th><th scope="col">{t("insights.quota.colRemaining")}</th></tr></thead>
              <tbody>{picked.points.slice(-50).reverse().map(p => <tr key={p.t}><td>{timestamp(p.t)}</td><td>{(100 - p.pct).toLocaleString(currentLanguage(), { maximumFractionDigits: 1 })}%</td></tr>)}</tbody>
            </table>
          </details>
        </div> : !error && (loading && account
          ? <ReadActivity kind="quota" title={t("insights.quota.reading")} note={t("insights.quota.loading")} />
          : <p className="qh-message" role="status">{!account
            ? t("insights.quota.noAccount")
            : t("insights.quota.noReadings")}</p>)}
        {data?.storageOk === false && <p className="qh-note" role="status">{t("insights.quota.notSaved")}</p>}
        <footer className="qh-note qh-footer">{t("insights.quota.footer")}</footer>
      </div>
    </div>
  </div>, document.body);
}
