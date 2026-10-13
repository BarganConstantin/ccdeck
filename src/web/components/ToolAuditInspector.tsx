import { auditDate, auditDuration, type AuditReport, type AuditRow } from '../tool-audit';

export function AuditCloseGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export default function ToolAuditInspector({ row, details, loading, error, kind, setKind, onClose }: {
  row: AuditRow; details: AuditReport['details']; loading: boolean; error: string;
  kind: 'slowest' | 'recent'; setKind: (kind: 'slowest' | 'recent') => void; onClose: () => void;
}) {
  const intervals = [
    ['Cumulative', auditDuration(row.totalMs)], ['Median', auditDuration(row.medianMs)],
    ['P95', auditDuration(row.p95Ms)], ['Maximum', auditDuration(row.maxMs)],
  ];
  return <section className="ta-inspector" aria-label={`${row.operation} details`} id="tool-operation-inspector">
    <header className="ta-inspector-head"><h3 tabIndex={-1} id="tool-operation-heading">{row.operation}</h3><button type="button" className="glyph-btn" aria-label="Close operation details" onClick={onClose}><AuditCloseGlyph /></button></header>
    <div className="ta-provider-counts" aria-label="Calls by provider"><span>Claude <b>{row.providers.claude.toLocaleString()}</b></span><span>Codex <b>{row.providers.codex.toLocaleString()}</b></span></div>
    <section className="ta-inspector-section" aria-label="Activity and outcomes">
      <h4>Activity & outcomes</h4>
      <dl className="ta-stat-grid">
        <div><dt>Containing calls</dt><dd>{row.calls.toLocaleString()}</dd></div>
        <div><dt>Timed calls</dt><dd>{row.measured.toLocaleString()}<span> / {row.calls.toLocaleString()}</span></dd></div>
        <div><dt>Reported failures</dt><dd className={row.failed ? 'ta-failures' : undefined}>{row.failed.toLocaleString()}<span> / {row.completed.toLocaleString()}</span></dd></div>
        <div><dt>Failure rate</dt><dd>{row.errorRate === null ? '—' : `${(row.errorRate * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</dd></div>
      </dl>
    </section>
    <section className="ta-inspector-section" aria-label="Measured containing-call intervals">
      <h4>Measured intervals</h4>
      <dl className="ta-stat-grid">{intervals.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="ta-note">Cumulative intervals overlap; not wall-clock time.</p>
      {row.shared > 0 && <p className="ta-note">{row.shared.toLocaleString()} calls share their full interval and outcome across operations.</p>}
    </section>
    <details className="ta-inspector-definitions"><summary>Definitions & coverage</summary>
      <p>Detected in {row.tools.join(', ')}. Arguments and outputs are not retained.</p>
      <p>Median is the middle measured interval; P95 is its 95th percentile; maximum is the largest. These include containing-call waits, not just inner command execution. Claude uses hook receipt intervals; Codex uses rollout timestamps. Different clocks are not a provider speed comparison.</p>
      {row.measured < 20 && <p>P95 needs 20 measured calls; this operation has {row.measured}.</p>}
      {row.completed < 20 && <p>Failure-rate ranking needs 20 outcomes. The raw rate above describes this small sample.</p>}
      <p>Reported failures refer to observed containing-call outcomes, not proof of inner-command failure.</p>
      <p>{row.missingTiming.toLocaleString()} calls lack timing; {row.unmatched.toLocaleString()} have no observed outcome. Neither implies failure.</p>
    </details>
    <div className="ta-detail-tabs" role="group" aria-label="Operation calls"><button type="button" aria-pressed={kind === 'slowest'} onClick={() => setKind('slowest')}>Slowest calls</button><button type="button" aria-pressed={kind === 'recent'} onClick={() => setKind('recent')}>Recent calls</button></div>
    {loading && <p className="ta-note" role="status">Reading recorded calls…</p>}
    {error && <p className="ta-message" role="alert">{error}</p>}
    {details && <>
      <p className="ta-note">{kind === 'slowest' ? '20 slowest measured' : '30 most recent'} · fresh snapshot of {details.total.toLocaleString()} calls</p>
      <ul className="ta-calls">{details[kind].map(call => <li key={call.id}><span>{auditDate(call.capturedAt)}<small>{call.provider === 'claude' ? 'Claude · hook interval' : 'Codex · rollout interval'}{call.shared && ' · shared'}</small></span><span>{auditDuration(call.durationMs)}<small>{call.state === 'unmatched' ? 'No outcome' : call.state === 'failed' ? 'Reported failure' : 'Reported success'}</small></span></li>)}</ul>
      {!details[kind].length && <p className="ta-note">{kind === 'slowest' ? 'No measured calls to inspect.' : 'No recent calls in this snapshot.'}</p>}
    </>}
  </section>;
}
