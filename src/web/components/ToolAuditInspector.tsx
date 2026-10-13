import { auditDate, auditDuration, type AuditReport, type AuditRow } from '../tool-audit';

export function AuditCloseGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export default function ToolAuditInspector({ row, details, loading, error, kind, setKind, onClose }: {
  row: AuditRow; details: AuditReport['details']; loading: boolean; error: string;
  kind: 'slowest' | 'recent'; setKind: (kind: 'slowest' | 'recent') => void; onClose: () => void;
}) {
  const stats = [
    ['Containing calls', row.calls.toLocaleString()], ['Measured', `${row.measured.toLocaleString()} / ${row.calls.toLocaleString()}`],
    ['Cumulative interval', auditDuration(row.totalMs)], ['Median interval', auditDuration(row.medianMs)],
    ['P95 interval', auditDuration(row.p95Ms)], ['Largest interval', auditDuration(row.maxMs)],
    ['Reported failures', `${row.failed.toLocaleString()} / ${row.completed.toLocaleString()} outcomes`],
    ['Reported failure rate', row.errorRate === null ? '—' : `${(row.errorRate * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`],
  ];
  return <section className="ta-inspector" aria-label={`${row.operation} details`} id="tool-operation-inspector">
    <header className="ta-inspector-head"><h3 tabIndex={-1} id="tool-operation-heading">{row.operation}</h3><button type="button" className="glyph-btn" aria-label="Close operation details" onClick={onClose}><AuditCloseGlyph /></button></header>
    <p className="ta-note">Detected in {row.tools.join(', ')}. Arguments and outputs are not retained.</p>
    <div className="ta-provider-counts" aria-label="Calls by provider"><span>Claude <b>{row.providers.claude.toLocaleString()}</b></span><span>Codex <b>{row.providers.codex.toLocaleString()}</b></span></div>
    <dl className="ta-stat-grid">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {row.measured < 20 && <p className="ta-note">P95 needs 20 measured calls; this operation has {row.measured}.</p>}
    {row.completed < 20 && <p className="ta-note">Failure-rate ranking needs 20 outcomes. The raw rate above is descriptive of this small sample.</p>}
    {row.shared > 0 && <p className="ta-qualification">{row.shared.toLocaleString()} calls contain several operations. Their full interval and reported outcome are shared; individual commands are not independently measured.</p>}
    {(row.missingTiming > 0 || row.unmatched > 0) && <p className="ta-note">{row.missingTiming.toLocaleString()} calls lack timing; {row.unmatched.toLocaleString()} have no observed outcome. Neither implies failure.</p>}
    <div className="ta-detail-tabs" role="group" aria-label="Operation calls"><button type="button" aria-pressed={kind === 'slowest'} onClick={() => setKind('slowest')}>Slowest calls</button><button type="button" aria-pressed={kind === 'recent'} onClick={() => setKind('recent')}>Recent calls</button></div>
    {loading && <p className="ta-note" role="status">Reading recorded calls…</p>}
    {error && <p className="ta-message" role="alert">{error}</p>}
    {details && <>
      <p className="ta-note">{kind === 'slowest' ? 'Up to 20 measured calls' : 'Latest 30 recorded calls'} · {details.total.toLocaleString()} in this fresh detail snapshot.</p>
      <ul className="ta-calls">{details[kind].map(call => <li key={call.id}><span>{auditDate(call.capturedAt)}<small>{call.provider === 'claude' ? 'Claude · hook interval' : 'Codex · rollout interval'}{call.shared && ' · shared'}</small></span><span>{auditDuration(call.durationMs)}<small>{call.state === 'unmatched' ? 'No outcome' : call.state === 'failed' ? 'Reported failure' : 'Reported success'}</small></span></li>)}</ul>
      {!details[kind].length && <p className="ta-note">{kind === 'slowest' ? 'No measured calls to inspect.' : 'No recent calls in this snapshot.'}</p>}
    </>}
  </section>;
}
