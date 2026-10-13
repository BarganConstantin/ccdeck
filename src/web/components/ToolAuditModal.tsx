import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { auditDate, auditRange, auditDuration, readAuditReport, type AuditMetric, type AuditProvider, type AuditReport } from '../tool-audit';
import { reportMetrics, reportOperations } from '../tool-audit-report';
import ToolAuditComparison from './ToolAuditComparison';
import ToolAuditOperations from './ToolAuditOperations';
import ToolAuditDrawer from './ToolAuditDrawer';
import { useModalDismiss } from './use-modal-dismiss';

const periodLabels: Record<string, string> = { '1': 'Last 24 hours', '7': 'Last 7 days', '30': 'Last 30 days', '60': 'Last 60 days', '90': 'Last 90 days' };

export default function ToolAuditModal({ onClose, instant = false }: { onClose: () => void; instant?: boolean }) {
  const [provider, setProvider] = useState<AuditProvider>('all');
  const [period, setPeriod] = useState('7');
  const [since, setSince] = useState(''); const [until, setUntil] = useState('');
  const [metric, setMetric] = useState<AuditMetric>('calls'); const [ascending, setAscending] = useState(false);
  const [search, setSearch] = useState(''); const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string | null>(null); const [keyboardSelection, setKeyboardSelection] = useState(false);
  const selectionOrigin = useRef<HTMLElement | null>(null);
  const [data, setData] = useState<AuditReport | null>(null);
  const [details, setDetails] = useState<AuditReport['details']>(null);
  const [detailKind, setDetailKind] = useState<'slowest' | 'recent'>('slowest');
  const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState('');
  const [refresh, setRefresh] = useState(0); const busy = useRef(false); const loadedQuery = useRef<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeReport = () => {
    onClose();
    requestAnimationFrame(() => {
      const original = opener.current;
      const fallback = Array.from(document.querySelectorAll<HTMLElement>('[data-rail-item="tool-activity"], [data-rail-item="more"]')).find(element => element.checkVisibility());
      (original?.isConnected && original.checkVisibility() ? original : fallback)?.focus({ preventScroll: true });
    });
  };
  const dialogRef = useModalDismiss(closeReport, { focusRef: closeRef });
  const validRange = period !== 'custom' || (!!since && !!until && since <= until && Date.parse(until) - Date.parse(since) < 90 * 86400000);
  const query = new URLSearchParams({ provider, days: period === 'custom' ? '90' : period, ...(period === 'custom' ? { since, until } : {}) }).toString();

  useEffect(() => {
    const controller = new AbortController(); let live = true;
    const deadline = window.setTimeout(() => controller.abort(), 65000);
    setError('');
    // Keep the visible snapshot during refresh; never display old data under new filters.
    if (loadedQuery.current !== query || !validRange) { setData(null); setDetails(null); setLimit(50); }
    if (!validRange) { setLoading(false); busy.current = false; window.clearTimeout(deadline); return; }
    busy.current = true; setLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport(query, controller.signal);
        if (live) { loadedQuery.current = query; setData(reply); setSelected(current => reply.rows.some(row => row.operation === current) ? current : null); }
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

  const rows = useMemo(() => reportOperations(data?.rows ?? [], metric, search, ascending), [data, metric, search, ascending]);
  const selection = data?.rows.find(row => row.operation === selected);
  const selectOperation = (operation: string, keyboard: boolean, origin: HTMLElement) => {
    selectionOrigin.current = origin; setKeyboardSelection(keyboard); setSelected(operation); setDetailKind('slowest');
  };
  const closeInspector = () => {
    const operation = selected; setSelected(null);
    requestAnimationFrame(() => {
      const original = selectionOrigin.current;
      const row = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('[data-operation]') ?? []).find(button => button.dataset.operation === operation);
      (original?.isConnected ? original : row ?? closeRef.current)?.focus({ preventScroll: true });
    });
  };
  const doRefresh = () => { if (busy.current || detailLoading || !validRange) return; busy.current = true; setRefresh(value => value + 1); };
  const reset = () => { setProvider('all'); setPeriod('7'); setSearch(''); setMetric('calls'); setAscending(false); setLimit(50); };
  const sort = (next: AuditMetric) => { setAscending(next === metric ? !ascending : false); setMetric(next); setLimit(50); };
  const explore = (next: AuditMetric) => {
    setMetric(next); setAscending(false); setLimit(50);
    const heading = document.getElementById('ta-all-operations');
    heading?.scrollIntoView({ block: 'start' }); heading?.focus({ preventScroll: true });
  };

  return createPortal(<div className="ta-report-backdrop">
    <div className="ta-report ta-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-audit-title" data-keyboard-interaction={instant || undefined}>
      <header className="ta-report-header"><button type="button" ref={closeRef} className="ta-back" onClick={closeReport} aria-label="Close tool report"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18" /></svg><span>Back to workspace</span></button>
        <h2 id="tool-audit-title">Tool Activity Report</h2><div className="ta-actions"><span className="ta-freshness" role="status">{loading ? data ? 'Refreshing…' : 'Reading local history…' : data ? `Updated ${auditDate(data.capturedAt)}` : 'Local to this device'}</span>
        <button type="button" className="glyph-btn" aria-label="Refresh tool report" data-loading={loading || undefined} aria-disabled={loading || detailLoading || !validRange} onClick={doRefresh} title="Rebuild from local history"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" /></svg></button>
      </div></header>
      <div className="ta-body"><div className="ta-report-content">
        <div className="ta-toolbar">
          <label><span className="ta-filter-label">Provider</span><select aria-label="Provider" value={provider} onChange={event => setProvider(event.target.value as AuditProvider)}><option value="all">Claude + Codex</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
          <label><span className="ta-filter-label">Period</span><select aria-label="Period" value={period} onChange={event => setPeriod(event.target.value)}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label>
          <label className="ta-search"><span className="ta-filter-label">Find an operation</span><input type="search" placeholder="Search operations…" value={search} onChange={event => { setSearch(event.target.value); setLimit(50); }} /></label>
          {(provider !== 'all' || period !== '7' || search) && <button type="button" className="ta-reset" onClick={reset}>Reset</button>}
        </div>
        {period === 'custom' && <div className="ta-dates"><label>From<input type="date" value={since} onChange={event => setSince(event.target.value)} /></label><label>Through<input type="date" value={until} onChange={event => setUntil(event.target.value)} /></label><span className="ta-note">Up to 90 calendar days · UTC</span></div>}
        {!validRange && <p className="ta-message" role="status">Choose a start and end date, up to 90 calendar days inclusive.</p>}
        {loading && !data && <div className="ta-loading" role="status"><span className="ta-loading-mark" aria-hidden="true" /><strong>Building your tool report</strong><span>Reading local history and calculating intervals…</span><div className="ta-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(i => <div key={i}><i /><i /><i /></div>)}</div></div>}
        {error && <div className="ta-message" role="alert"><p>{data && 'Showing the previous snapshot. '}{error}</p><button type="button" className="ta-more" onClick={doRefresh}>Try again</button></div>}
        {data && <>
          {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <div className="ta-data-quality" role="status"><strong>Incomplete history</strong><p>{data.dropped > 0 && `${data.dropped.toLocaleString()} records could not be saved. `}{data.corrupt > 0 && `${data.corrupt.toLocaleString()} invalid retained-journal records were skipped. `}{!data.storageOk && 'History could not be saved. Check disk space and permissions. '}Totals exclude unavailable records.</p></div>}
          <dl className="ta-overview" aria-label="All calls in selected provider and period">
            <div className="ta-overview-primary"><dt>Observed tool calls</dt><dd>{data.total.toLocaleString()}</dd></div>
            <div><dt title="Cumulative measured containing-call intervals. Each measured call counted once; intervals overlap and are not wall-clock time.">Cumulative intervals</dt><dd>{auditDuration(data.totalMs)}</dd></div>
            <div><dt>Reported failures</dt><dd className={data.failed ? 'ta-failures' : undefined}>{data.failed.toLocaleString()}<span> / {data.completed.toLocaleString()} outcomes</span></dd></div>
            <div className="ta-summary-coverage"><dt>Timing coverage</dt><dd>{data.total ? `${Math.round(data.measured / data.total * 100)}%` : '—'}<span>{data.measured.toLocaleString()} / {data.total.toLocaleString()} calls</span></dd></div>
          </dl>
          <details className="ta-coverage">
            <summary><span>{data.observedSince === null ? 'No observed starts' : `Observed ${auditRange(data.observedSince, data.observedUntil!)}`}</span><span className="ta-quality-count">{data.measured.toLocaleString()} / {data.total.toLocaleString()} timed</span><span className="ta-coverage-label">Coverage & definitions</span></summary>
            <div><p>Requested {periodLabels[period] ?? 'custom dates'}: {auditRange(data.since, data.until)}.</p><p>Recording retained since {auditDate(data.retainedSince)} · refreshed {auditDate(data.capturedAt)}. Observed endpoints describe recorded starts, not continuous coverage.</p><p>{data.unmatched.toLocaleString()} calls have no observed outcome. Missing timing is not failure.</p><p>Claude {data.providers.claude.calls.toLocaleString()} · Codex {data.providers.codex.calls.toLocaleString()} calls.</p>
            <p>One observed tool call may contain several detected operations. Counts, intervals and reported failures belong to containing calls, not independent inner executions. Conditional commands are identified from inputs; this is not proof that every command ran. Do not add operation totals together.</p>
            <p>Cumulative interval time includes overlapping calls and is not wall-clock execution time. Claude uses received hook intervals; Codex uses rollout timestamps. Approval, delivery and orchestration waits can be included. Timing does not imply API cost or token usage. Periods filter call starts; completed intervals are counted in full even when their outcome arrives after the range.</p>
            <p>Failures are reported outcomes. Codex recognizes specific wrapper failure markers; unrecognized errors can be missed. No command arguments, outputs or error messages are saved. Missing timing is not failure. P95 needs 20 measurements. Failure rates use observed completed outcomes.</p>
            <p>Retained since {auditDate(data.retainedSince)}; retention {data.retentionDays} days. Observed endpoints describe recorded call starts, not continuous coverage. Journal-wide: {data.orphaned} outcomes without a retained start, {data.duplicates} duplicate records ignored, {data.corrupt} invalid records. This report is local to this device.</p></div>
          </details>

          {provider === 'all' && data.providers.claude.measured > 0 && data.providers.codex.measured > 0 && <p className="ta-note ta-clock-note">Mixed timing sources · not a provider speed benchmark.</p>}
          {search && <p className="ta-note ta-search-scope">Charts and operations match “{search}”. Summary totals cover the selected provider and period.</p>}
          <div className="ta-report-charts">{reportMetrics.map(key => <ToolAuditComparison key={key} rows={data.rows} metric={key} search={search} selected={selected} onSelect={selectOperation} onExplore={explore} />)}</div>
          <ToolAuditOperations rows={rows} total={data.rows.length} metric={metric} ascending={ascending} limit={limit} search={search} selected={selected} onSort={sort} onSelect={selectOperation} onMore={() => setLimit(value => value + 50)} onClear={() => setSearch('')} />
          <footer className="ta-report-footer">This device · {data.retentionDays}-day retention · Arguments and outputs are not retained.</footer>
        </>}
      </div></div>
      {selection && <ToolAuditDrawer keyboard={keyboardSelection} row={selection} details={details} loading={detailLoading} error={detailError} kind={detailKind} setKind={setDetailKind} onClose={closeInspector} />}
    </div>
  </div>, document.body);
}
