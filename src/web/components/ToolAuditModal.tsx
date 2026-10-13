import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { auditDate, auditDuration, sortAuditRows, readAuditReport, type AuditProvider, type AuditReport } from '../tool-audit';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';

export default function ToolAuditModal({ onClose, instant = false }: { onClose: () => void; instant?: boolean }) {
  const [provider, setProvider] = useState<AuditProvider>('all');
  const [period, setPeriod] = useState('7');
  const [since, setSince] = useState(''); const [until, setUntil] = useState('');
  const [sort, setSort] = useState<'calls' | 'totalMs' | 'medianMs' | 'maxMs' | 'failed'>('calls');
  const [search, setSearch] = useState(''); const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<AuditReport | null>(null);
  const [details, setDetails] = useState<AuditReport['details']>(null);
  const [detailKind, setDetailKind] = useState<'slowest' | 'recent'>('slowest');
  const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState(''); const [refresh, setRefresh] = useState(0);
  const busy = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef }); const scrim = useScrimDismiss(onClose);
  const validRange = period !== 'custom' || !!since && !!until && since <= until && Date.parse(until) - Date.parse(since) < 90 * 86400000;
  const params = new URLSearchParams({ provider, days: period === 'custom' ? '90' : period });
  if (period === 'custom' && validRange) { params.set('since', since); params.set('until', until); }
  const query = params.toString();
  useEffect(() => {
    const controller = new AbortController(); let live = true;
    const deadline = window.setTimeout(() => controller.abort(), 65000);
    setData(null); setSelected(null); setDetails(null); setError(''); setLimit(50);
    if (!validRange) { setLoading(false); busy.current = false; window.clearTimeout(deadline); return; }
    busy.current = true; setLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport(query, controller.signal);
        if (live) setData(reply);
      } catch (e) { if (live) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'The report took too long. Try Refresh or reduce retention in Settings.'); }
      finally { window.clearTimeout(deadline); if (live) { busy.current = false; setLoading(false); } }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [query, validRange, refresh]);
  useEffect(() => {
    setDetails(null); setDetailError('');
    if (!selected || !data || loading) { setDetailLoading(false); return; }
    let live = true; const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 65000); setDetailLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport(`${query}&operation=${encodeURIComponent(selected)}`, controller.signal);
        if (live) setDetails(reply.details);
      } catch { if (live) setDetailError('Could not read operation details. Select the operation again to retry.'); }
      finally { window.clearTimeout(deadline); if (live) setDetailLoading(false); }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [selected, data, loading, query]);
  const rows = sortAuditRows(data?.rows ?? [], sort, search);
  const selection = data?.rows.find(r => r.operation === selected);
  const doRefresh = () => { if (busy.current || detailLoading || !validRange) return; busy.current = true; setRefresh(n => n + 1); };
  return createPortal(<div className="modal-backdrop" {...scrim}>
    <div className="modal ta-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-audit-title" data-keyboard-interaction={instant || undefined}>
      <header className="modal-head"><h2 id="tool-audit-title">Tool activity</h2><div className="ta-actions">
        <button type="button" className="glyph-btn" aria-label="Refresh tool report" aria-disabled={loading || detailLoading || !validRange} onClick={doRefresh} title="Rebuild from local history"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" /></svg></button>
        <button type="button" ref={closeRef} className="glyph-btn" onClick={onClose} aria-label="Close tool report"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </div></header>
      <div className="modal-body ta-body">
        <p className="ta-intro">Concrete tools and shell operations across Claude and Codex on this device.</p>
        <div className="ta-filters">
          <label>Provider<select aria-label="Tool report provider" value={provider} onChange={e => setProvider(e.target.value as AuditProvider)}><option value="all">Claude + Codex</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
          <label>Period<select aria-label="Tool report period" value={period} onChange={e => setPeriod(e.target.value)}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Retained history</option><option value="custom">Custom dates</option></select></label>
          <label>Rank by<select aria-label="Rank by" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="calls">Most called</option><option value="totalMs">Total time</option><option value="medianMs">Typical duration</option><option value="maxMs">Slowest call</option><option value="failed">Most failures</option></select></label>
        </div>
        {period === 'custom' && <div className="ta-dates"><label>From<input type="date" value={since} onChange={e => setSince(e.target.value)} /></label><label>Through<input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label><span className="ta-note">Up to 90 days · UTC dates</span></div>}
        {!validRange && <p className="ta-message" role="status">Choose a start and end date, up to 90 days apart.</p>}
        {loading && <div className="ta-loading" role="status" aria-live="polite"><span className="ta-loading-mark" aria-hidden="true" /><strong>Building your tool report</strong><span>Reading local history and calculating timings…</span><div className="ta-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(i => <div key={i}><i /><i /><i /></div>)}</div></div>}
        {error && <p className="ta-message" role="alert">{error}</p>}
        {data && <>
          <div className="ta-summary"><strong>{data.total.toLocaleString()} calls</strong><span>{data.measured.toLocaleString()} with measured timing · {data.failed.toLocaleString()} failures</span></div>
          <p className="ta-note">Report range {auditDate(data.since)} – {auditDate(Math.min(data.until, data.capturedAt))}. Built {auditDate(data.capturedAt)}.</p>
          <label className="ta-search">Find an operation<input type="search" placeholder="git commit, Read, npm run build…" value={search} onChange={e => { setSearch(e.target.value); setLimit(50); }} /></label>
          {data.rows.length ? <>
            <p className="ta-table-hint">Select an operation for details. Scroll horizontally for all timing columns.</p>
            <div className="ta-table-wrap" tabIndex={0} role="region" aria-label="Tool operation statistics">
              <table className="ta-table"><caption>{rows.length.toLocaleString()} matching operations · timings from completed calls</caption><thead><tr><th scope="col">Operation</th><th scope="col" title="Observed tool calls containing this operation">Calls</th><th scope="col">Total</th><th scope="col">Median</th><th scope="col" title="95th percentile; requires 20 measured calls">P95</th><th scope="col">Max</th><th scope="col">Errors</th></tr></thead>
                <tbody>{rows.slice(0, limit).map(r => <tr key={r.operation} data-selected={selected === r.operation || undefined}><th scope="row"><button type="button" aria-expanded={selected === r.operation} onClick={() => { setSelected(s => s === r.operation ? null : r.operation); setDetailKind('slowest'); }}>{r.operation}</button>{r.shared > 0 && <span className="ta-shared" title={`${r.shared} calls include several shell operations sharing one measured duration`}>shared timing</span>}</th><td>{r.calls.toLocaleString()}</td><td>{auditDuration(r.totalMs)}</td><td>{auditDuration(r.medianMs)}</td><td title={r.measured < 20 ? 'Requires 20 measured calls' : undefined}>{auditDuration(r.p95Ms)}</td><td>{auditDuration(r.maxMs)}</td><td>{r.failed.toLocaleString()} <span className="ta-note">{r.errorRate === null ? '' : `(${Math.round(r.errorRate * 100)}%)`}</span></td></tr>)}</tbody>
              </table>
            </div>
            {!rows.length && <p className="ta-message" role="status">No operations match your search.</p>}
            {rows.length > limit && <button type="button" className="ta-more" onClick={() => setLimit(n => n + 50)}>Show 50 more operations</button>}
          </> : <p className="ta-message" role="status">No calls recorded in this period. Collection starts when this deck receives new Claude or Codex tool events; older sessions are not imported.</p>}
          {selection && <section className="ta-detail" aria-label={`${selected} details`}>
            <div className="ta-detail-head"><h3>{selected}</h3><button type="button" className="glyph-btn" aria-label="Close operation details" onClick={() => setSelected(null)}>×</button></div>
            <p className="ta-note">Claude {selection.providers.claude.toLocaleString()} · Codex {selection.providers.codex.toLocaleString()} · {selection.measured.toLocaleString()}/{selection.calls.toLocaleString()} timings measured. Tools: {selection.tools.join(', ')}.</p>
            {selection.shared > 0 && <p className="ta-note">Compound shell calls share one duration. Each operation is counted once per observed call or wrapper; their times must not be added together. Listed commands are identified from the input, not proof that every branch executed.</p>}
            <div className="ta-detail-tabs" role="group" aria-label="Operation calls"><button type="button" aria-pressed={detailKind === 'slowest'} onClick={() => setDetailKind('slowest')}>Slowest calls</button><button type="button" aria-pressed={detailKind === 'recent'} onClick={() => setDetailKind('recent')}>Recent calls</button></div>
            {detailLoading && <p className="ta-note" role="status">Reading operation details…</p>}{detailError && <p className="ta-message" role="alert">{detailError}</p>}
            {details && <><p className="ta-note">{detailKind === 'slowest' ? 'Up to 20 slowest measured calls' : 'Latest 30 recorded calls'} · {details.total.toLocaleString()} calls in this detail snapshot.</p>
              <ul className="ta-calls">{details[detailKind].map(c => <li key={c.id}><span>{auditDate(c.capturedAt)}<small>{c.provider === 'claude' ? 'Claude · hook interval' : 'Codex · rollout interval'}{c.shared && ' · shared'}</small></span><span>{auditDuration(c.durationMs)}<small>{c.state === 'unmatched' ? 'No outcome observed' : c.state === 'failed' ? 'Failed' : 'Succeeded'}</small></span></li>)}</ul>
              {!details[detailKind].length && <p className="ta-note">No measured calls available.</p>}
            </>}
          </section>}
          {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <p className="ta-message" role="status">History is incomplete: {data.dropped} records could not be saved; {data.corrupt} invalid records were skipped.{!data.storageOk && ' Check available disk space and permissions.'}</p>}
          <details className="ta-method"><summary>How these statistics are measured</summary><p>Recorded on this device, starting {auditDate(data.startedAt)}. Retention: {data.retentionDays} days. Completed failures are included in timing statistics. Error percentages use observed outcomes. P95 needs at least 20 measured calls.</p><p>Claude timings use the interval between received hooks; Codex uses timestamps from rollout records. These intervals can include approval or delivery waits. Codex exec wrappers also include orchestration time; their individual inner calls are not timed separately. Parallel calls overlap: total tool time is not elapsed session time. Missing outcomes and missing timestamps never become zero-duration measurements. For compound commands and exec wrappers, counts, errors and timing describe the containing tool call, not independent inner executions.</p><p>{data.unmatched.toLocaleString()} calls have no observed outcome in this snapshot; {data.orphaned.toLocaleString()} outcomes have no retained start. Command arguments and tool outputs are not stored. This report is not synchronized to other devices.</p></details>
        </>}
      </div>
    </div>
  </div>, document.body);
}
