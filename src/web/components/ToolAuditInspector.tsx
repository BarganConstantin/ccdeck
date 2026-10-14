import ToolAuditMetricHelp from './ToolAuditMetricHelp';
import ToolAuditHistory from './ToolAuditHistory';
import { historyIntervalText } from '../tool-audit-history';
import { operationDescription, operationFallback, operationPurposeNote } from '../operation-glossary';
import { auditExplanations } from '../tool-audit-education';
import { auditDate, auditDuration, auditMetricValue, type AuditReport, type AuditRow } from '../tool-audit';
import { reportExactInterval } from '../tool-audit-report';

export function AuditCloseGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}
export default function ToolAuditInspector({ row, details, loading, error, kind, setKind, onClose, incomplete = false }: {
  row: AuditRow; details: AuditReport['details']; loading: boolean; error: string;
  incomplete?: boolean; kind: 'slowest' | 'recent'; setKind: (kind: 'slowest' | 'recent') => void; onClose: () => void;
}) {
  const average = row.averageMs ?? (row.measured && row.totalMs !== null ? row.totalMs / row.measured : null);
  const intervals = [['Average', average], ['Median', row.medianMs], ['P95', auditMetricValue(row, 'p95Ms')], ['Maximum', row.maxMs]] as const;
  return <section className="ta-inspector" aria-label={`${row.operation} details`} id="tool-operation-inspector">
    <header className="ta-inspector-head"><h3 tabIndex={-1} id="tool-operation-heading">{row.operation}</h3><button type="button" className="glyph-btn" aria-label="Close operation details" onClick={onClose}><AuditCloseGlyph /></button></header>
    <div className="ta-inspector-intro">
      <div className="ta-operation-purpose"><p>{operationDescription(row.operation)?.purpose ?? operationFallback(row.operation)}</p></div>
      <div className="ta-provider-counts" aria-label="Calls by provider"><span>Claude <b>{row.providers.claude.toLocaleString()}</b></span><span>Codex <b>{row.providers.codex.toLocaleString()}</b></span></div>
    </div>
    {incomplete && <p className="ta-note" role="status">Incomplete retained history. Unavailable records are excluded.</p>}
    <section className="ta-inspector-section" aria-label="Measured containing-call intervals">
      <div className="ta-inspector-section-head"><h4>Observed call intervals</h4><ToolAuditMetricHelp kind="intervals" /></div>
      <dl className="ta-interval-stats">{intervals.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={reportExactInterval(value)} aria-label={reportExactInterval(value)}>{historyIntervalText(value)}</dd></div>)}</dl>
      <p className="ta-note">{row.measured.toLocaleString()} valid {row.measured === 1 ? 'timing' : 'timings'} · {row.calls.toLocaleString()} containing {row.calls === 1 ? 'call' : 'calls'}</p>
      {row.measured < 20 && <p className="ta-note">P95 unavailable · needs 20 valid measurements.</p>}
      {row.providers.claude > 0 && row.providers.codex > 0 && <p className="ta-note">Mixed clocks · not a provider speed benchmark.</p>}
      <p className="ta-note">Includes waits; not isolated command runtime.</p>
    </section>
    {loading && <p className="ta-note" role="status">Reading recorded calls and daily history…</p>}
    {error && <p className="ta-message" role="alert">{error}</p>}
    {details?.history && <ToolAuditHistory key={row.operation} history={details.history} />}
    <section className="ta-inspector-section" aria-label="Activity and outcomes">
      <h4>Activity & outcomes</h4><dl className="ta-stat-grid">
        <div><dt>Containing calls</dt><dd>{row.calls.toLocaleString()}</dd></div>
        <div><dt>Timed calls</dt><dd>{row.measured.toLocaleString()}<span> / {row.calls.toLocaleString()}</span></dd></div>
        <div><dt>Reported failures</dt><dd className={row.failed ? 'ta-failures' : undefined}>{row.failed.toLocaleString()}<span> / {row.completed.toLocaleString()}</span></dd></div>
        <div><dt>Failure rate</dt><dd>{row.errorRate === null ? '—' : `${(row.errorRate * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</dd></div>
      </dl><p className="ta-note">Reported containing-call outcomes; an inner command may not have failed.</p>
      {row.missingTiming > 0 && <p className="ta-note">{row.missingTiming.toLocaleString()} {row.missingTiming === 1 ? 'call lacks' : 'calls lack'} timing. Missing measurements are unknown, not zero.</p>}
      {row.completed < 20 && row.errorRate !== null && <p className="ta-note">Small sample · {row.completed} completed {row.completed === 1 ? 'outcome' : 'outcomes'}. The rate describes this sample, not reliability.</p>}
      <p className="ta-note">Associated cumulative intervals: <b>{auditDuration(row.totalMs)}</b>. Overlaps are included; this is not elapsed time.</p>
    </section>
    <section className="ta-inspector-section" aria-label="Recorded calls">
      <div className="ta-calls-head"><h4>Recorded calls</h4><div className="ta-detail-tabs" role="group" aria-label="Operation calls"><button type="button" aria-pressed={kind === 'slowest'} onClick={() => setKind('slowest')}>Slowest calls</button><button type="button" aria-pressed={kind === 'recent'} onClick={() => setKind('recent')}>Recent calls</button></div></div>
      {details && <><p className="ta-note">Showing {details[kind].length} of {details.total.toLocaleString()} {details.total === 1 ? 'call' : 'calls'}</p>
        <ul className="ta-calls">{details[kind].map(call => <li key={call.id} data-outcome={call.state}><span>{auditDate(call.capturedAt)}<small>{call.provider === 'claude' ? 'Claude · hook interval' : 'Codex · rollout interval'}{call.shared && ' · shared'}</small></span><span title={reportExactInterval(call.durationMs)}>{auditDuration(call.durationMs)}<small><span className="ta-outcome"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d={call.state === 'failed' ? 'm4 4 8 8m0-8-8 8' : call.state === 'success' ? 'm3 8 3 3 7-7' : 'M4 8h8'} /></svg>{call.state === 'unmatched' ? 'No outcome' : call.state === 'failed' ? 'Reported failure' : 'Success'}</span></small></span></li>)}</ul>
        {!details[kind].length && <p className="ta-note">{kind === 'slowest' ? 'No measured calls to inspect.' : 'No recent calls in this snapshot.'}</p>}
      </>}
    </section>
    {details?.capturedAt && <p className="ta-note">Detail snapshot {auditDate(details.capturedAt)} · not the latest call start.</p>}
    <details className="ta-inspector-definitions"><summary>Definitions & coverage</summary>
      <p>{operationPurposeNote} Detected in {row.tools.join(', ')}.</p>
      <p>Average adds valid intervals and divides by their count. Missing timings are excluded. Maximum is the largest observed interval. {auditExplanations.median} {auditExplanations.p95}</p>
      <p>{auditExplanations.sample}</p>
      <p>Counts are nonadditive. {row.shared.toLocaleString()} calls contain multiple detected operations and share any recorded interval/outcome. Cumulative intervals can overlap and are not elapsed wall-clock time.</p>
      <p>Claude uses hook receipt intervals; Codex uses rollout timestamps. Approval, delivery and orchestration waits can be included. Different clocks are not a provider speed comparison.</p>
      <p>{auditExplanations.failures} Rates divide failures by completed observed outcomes; {row.unmatched.toLocaleString()} calls have no observed outcome. Neither missing outcomes nor missing timing implies failure.</p>
      <p>Daily history uses observed call starts in its stated timezone. A call crossing midnight belongs to its start day. Partial days include requested-range and retention boundaries. Sparse observations do not prove continuous coverage.</p>
    </details>
  </section>;
}
