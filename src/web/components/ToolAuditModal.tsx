import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { auditDate, auditRange, auditDuration, auditMetrics, auditMetricText, auditMetricValue, sortAuditRows, readAuditReport, type AuditMetric, type AuditProvider, type AuditReport } from '../tool-audit';
import { useMediaQuery } from '../use-media-query';
import ToolAuditInspector, { AuditCloseGlyph } from './ToolAuditInspector';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';

const primaryMetrics: AuditMetric[] = ['calls', 'totalMs', 'p95Ms', 'failed'];
const periodLabels: Record<string, string> = { '1': 'Last 24 hours', '7': 'Last 7 days', '30': 'Last 30 days', '60': 'Last 60 days', '90': 'Last 90 days' };
const extraMetrics: AuditMetric[] = ['medianMs', 'maxMs', 'errorRate'];

export default function ToolAuditModal({ onClose, instant = false }: { onClose: () => void; instant?: boolean }) {
  const [provider, setProvider] = useState<AuditProvider>('all');
  const [period, setPeriod] = useState('7');
  const [since, setSince] = useState(''); const [until, setUntil] = useState('');
  const [metric, setMetric] = useState<AuditMetric>('calls');
  const [search, setSearch] = useState(''); const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<AuditReport | null>(null);
  const [details, setDetails] = useState<AuditReport['details']>(null);
  const [detailKind, setDetailKind] = useState<'slowest' | 'recent'>('slowest');
  const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState('');
  const [refresh, setRefresh] = useState(0); const busy = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const scrim = useScrimDismiss(onClose);
  const wide = useMediaQuery('(min-width: 960px)');
  const phone = useMediaQuery('(max-width: 600px)');
  const secondaryMetrics: AuditMetric[] = phone ? [...extraMetrics, 'failed'] : extraMetrics;
  const validRange = period !== 'custom' || (!!since && !!until && since <= until && Date.parse(until) - Date.parse(since) < 90 * 86400000);
  const query = new URLSearchParams({ provider, days: period === 'custom' ? '90' : period, ...(period === 'custom' ? { since, until } : {}) }).toString();

  useEffect(() => {
    const controller = new AbortController(); let live = true;
    const deadline = window.setTimeout(() => controller.abort(), 65000);
    setData(null); setDetails(null); setError(''); setLimit(50);
    if (!validRange) { setLoading(false); busy.current = false; window.clearTimeout(deadline); return; }
    busy.current = true; setLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport(query, controller.signal);
        if (live) { setData(reply); setSelected(current => reply.rows.some(row => row.operation === current) ? current : null); }
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
      try { const reply = await readAuditReport(`${query}&operation=${encodeURIComponent(selected)}`, controller.signal); if (live) setDetails(reply.details); }
      catch { if (live) setDetailError('Could not read recorded calls. Close and select this operation to retry.'); }
      finally { window.clearTimeout(deadline); if (live) setDetailLoading(false); }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [selected, data, loading, query]);

  const rows = useMemo(() => sortAuditRows(data?.rows ?? [], metric, search), [data, metric, search]);
  const scale = rows.reduce((max, row) => Math.max(max, auditMetricValue(row, metric) ?? 0), 0);
  const selection = data?.rows.find(row => row.operation === selected);
  const selectOperation = (operation: string, keyboard: boolean) => {
    setSelected(operation); setDetailKind('slowest');
    requestAnimationFrame(() => {
      const heading = document.getElementById('tool-operation-heading');
      if (!wide) heading?.scrollIntoView({ block: 'nearest' });
      if (keyboard) heading?.focus({ preventScroll: true });
    });
  };
  const closeInspector = () => {
    const operation = selected; setSelected(null);
    requestAnimationFrame(() => (Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('[data-operation]') ?? []).find(button => button.dataset.operation === operation) ?? closeRef.current)?.focus({ preventScroll: true }));
  };
  const inspector = selection && <ToolAuditInspector row={selection} details={details} loading={detailLoading} error={detailError} kind={detailKind} setKind={setDetailKind} onClose={closeInspector} />;
  const doRefresh = () => { if (busy.current || detailLoading || !validRange) return; busy.current = true; setRefresh(value => value + 1); };
  const reset = () => { setProvider('all'); setPeriod('7'); setSearch(''); setMetric('calls'); setLimit(50); };

  return createPortal(<div className="modal-backdrop" {...scrim}>
    <div className="modal ta-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-audit-title" data-keyboard-interaction={instant || undefined}>
      <header className="modal-head"><div className="ta-title"><h2 id="tool-audit-title">Tool activity</h2><span>Operations on this device</span></div><div className="ta-actions">
        <button type="button" className="glyph-btn" aria-label="Refresh tool report" aria-disabled={loading || detailLoading || !validRange} onClick={doRefresh} title="Rebuild from local history"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" /></svg></button>
        <button type="button" ref={closeRef} className="glyph-btn" onClick={onClose} aria-label="Close tool report"><AuditCloseGlyph /></button>
      </div></header>
      <div className="modal-body ta-body">
        <div className="ta-toolbar">
          <label>Provider<select aria-label="Provider" value={provider} onChange={event => setProvider(event.target.value as AuditProvider)}><option value="all">Claude + Codex</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
          <label>Period<select aria-label="Period" value={period} onChange={event => setPeriod(event.target.value)}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label>
          <label className="ta-search">Find an operation<input type="search" placeholder="git commit, rg, Read…" value={search} onChange={event => { setSearch(event.target.value); setLimit(50); }} /></label>
          {(provider !== 'all' || period !== '7' || search || metric !== 'calls') && <button type="button" className="ta-reset" onClick={reset}>Reset</button>}
        </div>
        {period === 'custom' && <div className="ta-dates"><label>From<input type="date" value={since} onChange={event => setSince(event.target.value)} /></label><label>Through<input type="date" value={until} onChange={event => setUntil(event.target.value)} /></label><span className="ta-note">Up to 90 calendar days · UTC</span></div>}
        {!validRange && <p className="ta-message" role="status">Choose a start and end date, up to 90 calendar days inclusive.</p>}
        {loading && <div className="ta-loading" role="status" aria-live="polite"><span className="ta-loading-mark" aria-hidden="true" /><strong>Building your tool report</strong><span>Reading local history and calculating intervals…</span><div className="ta-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(i => <div key={i}><i /><i /><i /></div>)}</div></div>}
        {error && <div className="ta-message" role="alert"><p>{error}</p><button type="button" className="ta-more" onClick={doRefresh}>Try again</button></div>}
        {data && <>
          {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <div className="ta-data-quality" role="status"><strong>Incomplete history</strong><p>{data.dropped > 0 && `${data.dropped.toLocaleString()} records could not be saved. `}{data.corrupt > 0 && `${data.corrupt.toLocaleString()} invalid retained-journal records were skipped. `}{!data.storageOk && 'History could not be saved. Check disk space and permissions. '}Totals exclude unavailable records.</p></div>}
          <dl className="ta-overview" aria-label="All calls in selected provider and period">
            <div><dt>Tool calls</dt><dd>{data.total.toLocaleString()}</dd><small>Unique containing calls</small></div>
            <div><dt>Cumulative interval</dt><dd>{auditDuration(data.totalMs)}</dd><small>Each measured call once · overlaps</small></div>
            <div><dt>Reported failures</dt><dd className={data.failed ? 'ta-failures' : undefined}>{data.failed.toLocaleString()}<span> / {data.completed.toLocaleString()}</span></dd><small>Observed outcomes</small></div>
            <div><dt>Measured timing</dt><dd>{data.measured.toLocaleString()}<span> / {data.total.toLocaleString()}</span></dd><small>{data.unmatched.toLocaleString()} without an outcome</small></div>
          </dl>
          <div className="ta-coverage">
            <p><span>Requested</span> {periodLabels[period] ?? auditRange(data.since, data.until)}</p>
            <p><span>Observed starts</span> {data.observedSince === null ? 'None in this period' : auditRange(data.observedSince, data.observedUntil!)}</p>
            <details><summary>Coverage & freshness</summary><p>Requested dates: {auditRange(data.since, data.until)}.</p><p>Recording retained since {auditDate(data.retainedSince)} · refreshed {auditDate(data.capturedAt)}.</p><p>Observed endpoints describe recorded starts, not continuous coverage.</p></details>
          </div>
          {provider === 'all' && <p className="ta-provider-note">Claude {data.providers.claude.calls.toLocaleString()} · Codex {data.providers.codex.calls.toLocaleString()} {wide ? 'calls · different clocks, not a speed comparison.' : 'calls · different clocks.'}</p>}
          <div className="ta-rank-controls" role="group" aria-label="Ranking metric">
            {primaryMetrics.filter(key => !phone || key !== 'failed').map(key => <button type="button" key={key} aria-label={auditMetrics[key].label} aria-pressed={metric === key} onClick={() => { setMetric(key); setLimit(50); }}>{phone ? key === 'totalMs' ? 'Cumulative' : key === 'p95Ms' ? 'P95 tails' : auditMetrics[key].label : auditMetrics[key].label}</button>)}

          </div>
          <div className="ta-ranking-caption"><h3>{auditMetrics[metric].label}</h3><div className="ta-ranking-meta"><span>{rows.length.toLocaleString()} / {data.rows.length.toLocaleString()} operations</span>            <label><span className="ta-sr-only">More ranking metrics</span><select aria-label="More ranking metrics" value={secondaryMetrics.includes(metric) ? metric : ''} onChange={event => { if (event.target.value) { setMetric(event.target.value as AuditMetric); setLimit(50); } }}><option value="" disabled>More metrics</option>{secondaryMetrics.map(key => <option key={key} value={key}>{auditMetrics[key].label}</option>)}</select></label></div></div>
          {search && <p className="ta-note">Search filters operations; overview totals still include all calls in this provider and period.</p>}
          <p className="ta-note" id="tool-ranking-definition">{auditMetrics[metric].note}</p>
          <div className="ta-workspace" data-inspecting={!!selection || undefined}>
            <div className="ta-results">
              {rows.length ? <ol className="ta-ranking" aria-label={`${auditMetrics[metric].label} operations`}>
                {rows.slice(0, limit).map((row, index) => {
                  const value = auditMetricValue(row, metric);
                  return <li key={row.operation}>
                    <button type="button" className="ta-operation" data-operation={row.operation} data-selected={row.operation === selected || undefined} aria-label={row.operation} aria-expanded={row.operation === selected} aria-controls={row.operation === selected ? 'tool-operation-inspector' : undefined} aria-describedby={`tool-ranking-value-${index} tool-ranking-definition`} onClick={event => selectOperation(row.operation, event.detail === 0)}>
                      <span className="ta-operation-name">{row.operation}<small>{row.providers.claude > 0 && 'Claude'}{row.providers.claude > 0 && row.providers.codex > 0 && ' + '}{row.providers.codex > 0 && 'Codex'}{row.shared > 0 && (phone ? ' · shared' : ' · shared interval')}</small></span>
                      <span className="ta-rank-plot"><span className="ta-rank-track" aria-hidden="true"><span style={{ width: `${scale && value !== null ? value / scale * 100 : 0}%` }} /></span><small>{metric === 'errorRate' || metric === 'failed' ? `${row.failed.toLocaleString()} / ${row.completed.toLocaleString()} outcomes` : `${row.calls.toLocaleString()} calls · ${row.measured.toLocaleString()} timed`}</small></span>
                      <span className="ta-sr-only" id={`tool-ranking-value-${index}`}>{auditMetricText(value, metric)} {auditMetrics[metric].unit}. {value === null ? metric === 'p95Ms' ? 'Requires 20 measured calls.' : metric === 'errorRate' ? 'Requires 20 completed outcomes.' : 'No measured duration.' : ''} {row.calls} containing calls; {row.measured} measured; {row.failed} reported failures in {row.completed} outcomes.{row.shared > 0 && ' Shared containing-call interval.'}</span>
                      <span className="ta-rank-value">{auditMetricText(value, metric)}<small>{value === null ? metric === 'p95Ms' ? 'Needs 20 timings' : metric === 'errorRate' ? 'Needs 20 outcomes' : 'Not measured' : auditMetrics[metric].short}</small></span>
                    </button>
                    {!wide && row.operation === selected && inspector}
                  </li>;
                })}
              </ol> : <div className="ta-message" role="status">{data.rows.length ? <><p>No operations match “{search}”.</p><button type="button" className="ta-more" onClick={() => setSearch('')}>Clear search</button></> : <p>No calls recorded in this period. Collection starts with new tool events; older sessions are not imported. Try another provider or period.</p>}</div>}
              {rows.length > limit && <button type="button" className="ta-more" onClick={() => setLimit(value => value + 50)}>Show 50 more · {rows.length - limit} remaining</button>}
              {!wide && selection && !rows.slice(0, limit).some(row => row.operation === selected) && inspector}
            </div>
            {wide && (inspector || <aside className="ta-inspector-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 19h16M7 15V9m5 6V5m5 10v-3" /></svg><h3>Inspect an operation</h3><p>Select a row to see measured intervals, reported outcomes and recorded calls.</p><p>Frequent does not mean slow. Compare cumulative intervals and P95 to decide what to investigate.</p></aside>)}
          </div>
          <details className="ta-method"><summary>Measurement & data quality</summary>
            <p>One observed tool call may contain several detected operations. Counts, intervals and reported failures belong to containing calls, not independent inner executions. Conditional commands are identified from inputs; this is not proof that every command ran. Do not add operation totals together.</p>
            <p>Cumulative interval time includes overlapping calls and is not wall-clock execution time. Claude uses received hook intervals; Codex uses rollout timestamps. Approval, delivery and orchestration waits can be included. Timing does not imply API cost or token usage. Periods filter call starts; completed intervals are counted in full even when their outcome arrives after the range.</p>
            <p>Failures are reported outcomes. Codex recognizes specific wrapper failure markers; unrecognized errors can be missed. No command arguments, outputs or error messages are saved. Missing timing is not failure. P95 needs 20 measurements; failure-rate ranking needs 20 completed outcomes.</p>
            <p>Retained since {auditDate(data.retainedSince)}; retention {data.retentionDays} days. Observed endpoints describe recorded call starts, not continuous coverage. Journal-wide: {data.orphaned} outcomes without a retained start, {data.duplicates} duplicate records ignored, {data.corrupt} invalid records. This report is local to this device.</p>
          </details>
        </>}
      </div>
    </div>
  </div>, document.body);
}
