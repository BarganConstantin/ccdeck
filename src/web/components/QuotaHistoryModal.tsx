import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Providers } from "../providers";
import { captureAge, quotaPlot, quotaSeriesKey, type QuotaHistory, type QuotaSeries } from "../quota-history";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { selfPressAccepted, selfPressProps } from "../panel-press";

const timestamp = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
type Provider = "claude" | "codex";

function QuotaChart({ series }: { series: QuotaSeries }) {
  const segments = quotaPlot(series);
  const start = (series.resetAt - series.windowSec) * 1000;
  const end = series.resetAt * 1000;
  return <>
    <div className="qh-chart-wrap">
    <div className="qh-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
    <svg className="qh-chart" viewBox="36 12 516 150" role="img"
      aria-label={`${series.label}: observed remaining quota over time. Dashed line is an even-use guide, not a forecast.`}>
      {[0, 50, 100].map(used => <g key={used}>
        <line className="qh-grid" x1="36" x2="552" y1={12 + used * 1.5} y2={12 + used * 1.5} />
      </g>)}
      <path className="qh-guide" d="M36 12 L552 162" />
      {segments.map((segment, i) => <g key={i}>
        {segment.length > 1 && <path className="qh-observed" d={segment.map((p, j) => `${j ? "L" : "M"}${p.x} ${p.y}`).join(" ")} />}
        {[segment[0], ...(segment.length > 1 ? [segment.at(-1)!] : [])].map(p =>
          <circle className="qh-point" key={p.t} cx={p.x} cy={p.y} r="2.5"><title>{timestamp(p.t)} · {Math.round(100 - p.pct)}% remaining</title></circle>)}
      </g>)}
    </svg>
    <div className="qh-times" aria-hidden="true"><span>{series.windowSec > 86400 ? timestamp(start) : clock(start)}</span><span>{series.windowSec > 86400 ? timestamp(end) : clock(end)}</span></div>
    </div>
    <div className="qh-legend"><span><i className="qh-key" />Observed remaining</span><span><i className="qh-key qh-key-guide" />Even-use guide</span></div>
  </>;
}

export default function QuotaHistoryModal({ providers, accounts, onClose, instant = false }: {
  providers: Providers; accounts: { claude?: string; codex?: string }; onClose: () => void; instant?: boolean;
}) {
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
        <h2 id="quota-history-title">Quota history</h2>
        <div className="qh-header-actions">
          <button type="button" className="glyph-btn" aria-label="Refresh quota history" title="Read recorded quota history" {...selfPressProps(loading)} onClick={refreshHistory}>{loading ? "…" : "↻"}</button>
          <button type="button" ref={closeRef} className="glyph-btn" onClick={onClose} aria-label="Close quota history">×</button>
        </div>
      </header>
      <div className="modal-body qh-body" aria-busy={loading}>
        <div className="qh-controls">
          <div className="qh-providers" role="group" aria-label="Quota provider">
            {(["claude", "codex"] as const).filter(p => providers[p]).map(p => <button type="button" className="qh-provider" key={p}
              aria-pressed={provider === p} onClick={() => { setProvider(p); setSelection(""); }}>{p === "claude" ? "Claude" : "Codex"}</button>)}
          </div>
          {series.length > 0 && <label className="qh-window">Window
            <select aria-label="Quota window" value={picked ? quotaSeriesKey(picked) : ""} onChange={e => setSelection(e.target.value)}>
              {series.map(s => <option key={quotaSeriesKey(s)} value={quotaSeriesKey(s)}>{s.label} · {timestamp(s.resetAt * 1000)}</option>)}
            </select>
          </label>}
        </div>
        {error && <p className="qh-message" role="status">Could not read saved quota history. Use Refresh to try again.{data && " Showing the last loaded history."}</p>}
        {picked && latest ? <>
          <div className="qh-summary"><strong>{Math.round(100 - latest.pct)}% remaining</strong>
            <span title={timestamp(latest.t)}>Captured {captureAge(latest.t, now)}{picked.resetAt * 1000 <= now && " · window ended"}</span>
          </div>
          <QuotaChart series={picked} />
          <p className="qh-note">Recorded quota readings. The dashed guide shows even use until reset; it is not a forecast. Gaps are left unconnected.</p>
          <details className="qh-readings"><summary>Recorded readings ({picked.points.length})</summary>
            <table><caption>{picked.points.length > 50 ? "Latest 50 readings" : "Recorded readings"}</caption>
              <thead><tr><th scope="col">Captured</th><th scope="col">Remaining</th></tr></thead>
              <tbody>{picked.points.slice(-50).reverse().map(p => <tr key={p.t}><td>{timestamp(p.t)}</td><td>{(100 - p.pct).toLocaleString(undefined, { maximumFractionDigits: 1 })}%</td></tr>)}</tbody>
            </table>
          </details>
        </> : !error && <p className="qh-message" role="status">{loading ? "Reading quota history…" : !account
          ? "History starts when a quota reading can be matched to your active account."
          : "No recorded readings yet. History fills in as ccdeck receives quota updates."}</p>}
        {data?.storageOk === false && <p className="qh-note" role="status">History is available for this run, but could not be saved to disk.</p>}
        <footer className="qh-note qh-footer">Recorded on this machine from existing quota reads. No extra provider requests. Account changes and resets are kept separate.</footer>
      </div>
    </div>
  </div>, document.body);
}
