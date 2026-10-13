import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { auditDate, auditRange, auditDuration, auditMetrics, auditMetricText, auditMetricValue, sortAuditRows, readAuditReport, type AuditProvider, type AuditReport } from '../tool-audit';
import { useMediaQuery } from '../use-media-query';
import ToolAuditInspector, { AuditCloseGlyph } from './ToolAuditInspector';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';

const periodLabels: Record<string, string> = { '1': 'Last 24 hours', '7': 'Last 7 days', '30': 'Last 30 days', '60': 'Last 60 days', '90': 'Last 90 days' };
const rankingMetrics = ['calls', 'totalMs', 'p95Ms', 'failed'] as const;
type RankingMetric = typeof rankingMetrics[number];
const rankingLabels: Record<RankingMetric, string> = { calls: 'Most used', totalMs: 'Most measured time', p95Ms: 'Slowest P95', failed: 'Reported failures' };
const rankingContext: Record<RankingMetric, string> = {
  calls: 'Calls containing each operation · counts overlap',
  totalMs: 'Recorded call intervals · not wall-clock time',
  p95Ms: 'Long recorded intervals · at least 20 timings',
  failed: 'Calls with a reported failure · shared outcomes',
};

export default function ToolAuditModal({ onClose, instant = false }: { onClose: () => void; instant?: boolean }) {
  const [provider, setProvider] = useState<AuditProvider>('all');
  const [period, setPeriod] = useState('7');
  const [since, setSince] = useState(''); const [until, setUntil] = useState('');
  const [metric, setMetric] = useState<RankingMetric>('calls');
  const [search, setSearch] = useState(''); const [limit, setLimit] = useState(8);
  const [selected, setSelected] = useState<string | null>(null);
  const selectionOrigin = useRef<HTMLElement | null>(null);
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
  const validRange = period !== 'custom' || (!!since && !!until && since <= until && Date.parse(until) - Date.parse(since) < 90 * 86400000);
  const query = new URLSearchParams({ provider, days: period === 'custom' ? '90' : period, ...(period === 'custom' ? { since, until } : {}) }).toString();

  useEffect(() => {
    const controller = new AbortController(); let live = true;
    const deadline = window.setTimeout(() => controller.abort(), 65000);
    setData(null); setDetails(null); setError(''); setLimit(8);
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
  const selectOperation = (operation: string, keyboard: boolean, origin: HTMLElement) => {
    selectionOrigin.current = origin;
    setSelected(operation); setDetailKind('slowest');
    requestAnimationFrame(() => {
      const heading = document.getElementById('tool-operation-heading');
      if (!wide) heading?.scrollIntoView({ block: 'nearest' });
      if (keyboard) heading?.focus({ preventScroll: true });
    });
  };
  const closeInspector = () => {
    const operation = selected; setSelected(null);
    requestAnimationFrame(() => {
      const original = selectionOrigin.current;
      const row = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('[data-operation]') ?? []).find(button => button.dataset.operation === operation);
      (original?.isConnected ? original : row ?? closeRef.current)?.focus({ preventScroll: true });
    });
  };
  const inspector = selection && <ToolAuditInspector row={selection} details={details} loading={detailLoading} error={detailError} kind={detailKind} setKind={setDetailKind} onClose={closeInspector} />;
  const doRefresh = () => { if (busy.current || detailLoading || !validRange) return; busy.current = true; setRefresh(value => value + 1); };
  const reset = () => { setProvider('all'); setPeriod('7'); setSearch(''); setMetric('calls'); setLimit(8); };

  return createPortal(<div className="modal-backdrop" {...scrim}>
    <div className="modal ta-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-audit-title" data-keyboard-interaction={instant || undefined}>
      <header className="modal-head"><div className="ta-title"><h2 id="tool-audit-title">Tool activity</h2><span>Operations on this device</span></div><div className="ta-actions">
        <button type="button" className="glyph-btn" aria-label="Refresh tool report" aria-disabled={loading || detailLoading || !validRange} onClick={doRefresh} title="Rebuild from local history"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" /></svg></button>
        <button type="button" ref={closeRef} className="glyph-btn" onClick={onClose} aria-label="Close tool report"><AuditCloseGlyph /></button>
      </div></header>
      <div className="modal-body ta-body">
        <div className="ta-toolbar">
          <label><span className="ta-filter-label">Provider</span><select aria-label="Provider" value={provider} onChange={event => setProvider(event.target.value as AuditProvider)}><option value="all">Claude + Codex</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
          <label><span className="ta-filter-label">Period</span><select aria-label="Period" value={period} onChange={event => setPeriod(event.target.value)}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label>
          <label className="ta-search"><span className="ta-filter-label">Find an operation</span><input type="search" placeholder="git commit, rg, Read…" value={search} onChange={event => { setSearch(event.target.value); setLimit(8); }} /></label>
          {(provider !== 'all' || period !== '7' || search) && <button type="button" className="ta-reset" onClick={reset}>Reset</button>}
        </div>
        {period === 'custom' && <div className="ta-dates"><label>From<input type="date" value={since} onChange={event => setSince(event.target.value)} /></label><label>Through<input type="date" value={until} onChange={event => setUntil(event.target.value)} /></label><span className="ta-note">Up to 90 calendar days · UTC</span></div>}
        {!validRange && <p className="ta-message" role="status">Choose a start and end date, up to 90 calendar days inclusive.</p>}
        {loading && <div className="ta-loading" role="status" aria-live="polite"><span className="ta-loading-mark" aria-hidden="true" /><strong>Building your tool report</strong><span>Reading local history and calculating intervals…</span><div className="ta-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(i => <div key={i}><i /><i /><i /></div>)}</div></div>}
        {error && <div className="ta-message" role="alert"><p>{error}</p><button type="button" className="ta-more" onClick={doRefresh}>Try again</button></div>}
        {data && <>
          {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <div className="ta-data-quality" role="status"><strong>Incomplete history</strong><p>{data.dropped > 0 && `${data.dropped.toLocaleString()} records could not be saved. `}{data.corrupt > 0 && `${data.corrupt.toLocaleString()} invalid retained-journal records were skipped. `}{!data.storageOk && 'History could not be saved. Check disk space and permissions. '}Totals exclude unavailable records.</p></div>}
          <dl className="ta-overview" aria-label="All calls in selected provider and period">
            <div className="ta-overview-primary"><dt>Observed tool calls</dt><dd>{data.total.toLocaleString()}</dd></div>
            <div><dt title="Cumulative measured containing-call intervals. Each measured call counted once; intervals may overlap and are not wall-clock time.">Cumulative intervals</dt><dd>{auditDuration(data.totalMs)}</dd></div>
            <div><dt>Reported failures</dt><dd className={data.failed ? 'ta-failures' : undefined}>{data.failed.toLocaleString()}<span> / {data.completed.toLocaleString()} outcomes</span></dd></div>
          </dl>
          <details className="ta-coverage">
            <summary><span>{data.observedSince === null ? 'No observed starts' : `Observed ${auditRange(data.observedSince, data.observedUntil!)}`}</span><span className="ta-quality-count">{data.measured.toLocaleString()} / {data.total.toLocaleString()} timed</span><span className="ta-coverage-label">Coverage & definitions</span></summary>
            <div><p>Requested {periodLabels[period] ?? 'custom dates'}: {auditRange(data.since, data.until)}.</p><p>Recording retained since {auditDate(data.retainedSince)} · refreshed {auditDate(data.capturedAt)}. Observed endpoints describe recorded starts, not continuous coverage.</p><p>{data.unmatched.toLocaleString()} calls have no observed outcome. Missing timing is not failure.</p><p>Claude {data.providers.claude.calls.toLocaleString()} · Codex {data.providers.codex.calls.toLocaleString()} calls.</p>
            <p>One observed tool call may contain several detected operations. Counts, intervals and reported failures belong to containing calls, not independent inner executions. Conditional commands are identified from inputs; this is not proof that every command ran. Do not add operation totals together.</p>
            <p>Cumulative interval time includes overlapping calls and is not wall-clock execution time. Claude uses received hook intervals; Codex uses rollout timestamps. Approval, delivery and orchestration waits can be included. Timing does not imply API cost or token usage. Periods filter call starts; completed intervals are counted in full even when their outcome arrives after the range.</p>
            <p>Failures are reported outcomes. Codex recognizes specific wrapper failure markers; unrecognized errors can be missed. No command arguments, outputs or error messages are saved. Missing timing is not failure. P95 needs 20 measurements. Failure rates use observed completed outcomes.</p>
            <p>Retained since {auditDate(data.retainedSince)}; retention {data.retentionDays} days. Observed endpoints describe recorded call starts, not continuous coverage. Journal-wide: {data.orphaned} outcomes without a retained start, {data.duplicates} duplicate records ignored, {data.corrupt} invalid records. This report is local to this device.</p></div>
          </details>
          <div className="ta-ranking-header">
            <div className="ta-metric-switch" role="group" aria-label="Compare operations">{rankingMetrics.map(key => <button type="button" key={key} aria-pressed={metric === key} onClick={() => { setMetric(key); setLimit(8); }}>{rankingLabels[key]}</button>)}</div>
            <label className="ta-mobile-metric">Compare<select aria-label="Compare operations" value={metric} onChange={event => { setMetric(event.target.value as RankingMetric); setLimit(8); }}>{rankingMetrics.map(key => <option key={key} value={key}>{rankingLabels[key]}</option>)}</select></label>
          </div>
          <div className="ta-workspace" data-inspecting={!!selection || undefined}>
            <div className="ta-results">
              <section className="ta-operations" aria-label="Exact operation rankings">
          <div className="ta-chart-heading"><h3>Operations</h3>
            <span className="ta-result-count">{search ? `${rows.length.toLocaleString()} of ${data.rows.length.toLocaleString()}` : data.rows.length.toLocaleString()} operations</span>
            {rows.length > 8 && <button type="button" className="ta-ranking-more" aria-label={limit === 8 ? `View all ${rows.length} operations` : 'Show top 8'} onClick={() => setLimit(limit === 8 ? 50 : 8)}>{limit === 8 ? 'View all' : 'Top 8'}</button>}
            <details className="ta-metric-definition"><summary aria-label="Metric definition"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg></summary><p id="tool-ranking-definition">{auditMetrics[metric].note}</p></details>
          </div>
          <div className="ta-ranking-context"><span>{rankingContext[metric]}</span>{provider === 'all' && !['calls', 'failed'].includes(metric) && <span>Claude / Codex use different clocks</span>}{search && <span>Search narrows operations; summary totals unchanged</span>}</div>
              {rows.length ? <ol className="ta-ranking" aria-label={`${rankingLabels[metric]} operations`} data-failures={metric === 'failed' || undefined}>
                {rows.slice(0, limit).map((row, index) => {
                  const value = auditMetricValue(row, metric);
                  return <li key={row.operation}>
                    <button type="button" className="ta-operation" data-operation={row.operation} data-selected={row.operation === selected || undefined} aria-label={row.operation} aria-expanded={row.operation === selected} aria-controls={row.operation === selected ? 'tool-operation-inspector' : undefined} aria-describedby={`tool-ranking-value-${index}`} onClick={event => selectOperation(row.operation, event.detail === 0, event.currentTarget)}>
                      <span className="ta-operation-name">{row.operation}</span>
                      <span className="ta-rank-plot"><span className="ta-rank-track" aria-hidden="true"><span style={{ width: `${scale && value !== null ? value / scale * 100 : 0}%` }} /></span></span>
                      <span className="ta-sr-only" id={`tool-ranking-value-${index}`}>{auditMetricText(value, metric)} {auditMetrics[metric].unit}. {value === null ? metric === 'p95Ms' ? 'Requires 20 measured calls.' : 'No measured duration.' : ''} {row.calls} containing calls; {row.measured} measured; {row.failed} reported failures in {row.completed} outcomes.{row.shared > 0 && ' Shared containing-call interval.'}</span>
                      <span className="ta-rank-value">{auditMetricText(value, metric)}{value === null ? <small>{metric === 'p95Ms' ? `${row.measured} / 20 timed` : 'Not measured'}</small> : null}</span>
                      <svg className="ta-row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
                    </button>
                    {!wide && row.operation === selected && inspector}
                  </li>;
                })}
              </ol> : <div className="ta-message" role="status">{data.rows.length ? <><p>No operations match “{search}”.</p><button type="button" className="ta-more" onClick={() => setSearch('')}>Clear search</button></> : <p>No calls recorded in this period. Collection starts with new tool events; older sessions are not imported. Try another provider or period.</p>}</div>}
              {limit > 8 && rows.length > limit && <button type="button" className="ta-more" onClick={() => setLimit(value => value === 8 ? 50 : value + 50)}>{limit === 8 ? `View all ${rows.length.toLocaleString()} operations` : `Show 50 more · ${rows.length - limit} remaining`}</button>}
              {!wide && selection && !rows.slice(0, limit).some(row => row.operation === selected) && inspector}
              </section>
            </div>
            {wide && inspector}
          </div>

        </>}
      </div>
    </div>
  </div>, document.body);
}
