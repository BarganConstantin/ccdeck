import ToolAuditHistory from './ToolAuditHistory';
import { operationDescription, operationName } from '../operation-glossary';
import { auditDuration, type AuditCall, type AuditReport, type AuditRow } from '../tool-audit';
import { callTime, count, failureShare } from '../tool-audit-report';

export function AuditCloseGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

const stateWord: Record<AuditCall['state'], string> = { success: 'Done', failed: 'Failed', unmatched: 'No result' };
const StateGlyph = ({ state }: { state: AuditCall['state'] }) => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d={state === 'failed' ? 'm4 4 8 8m0-8-8 8' : state === 'success' ? 'm3 8.5 3 3 7-7' : 'M4 8h8'} /></svg>;

function whoUsed(row: AuditRow) {
  const { claude, codex } = row.providers;
  if (claude && codex) return `${claude.toLocaleString()} by Claude, ${codex.toLocaleString()} by Codex`;
  return claude ? 'All by Claude' : 'All by Codex';
}

export default function ToolAuditInspector({ row, details, loading, error, kind, setKind, onClose }: {
  row: AuditRow; details: AuditReport['details']; loading: boolean; error: string;
  kind: 'recent' | 'slowest'; setKind: (kind: 'recent' | 'slowest') => void; onClose: () => void;
}) {
  const description = operationDescription(row.operation);
  const calls = details?.[kind] ?? [];
  const now = Date.now();
  const share = failureShare(row);
  return <section className="ta-inspector" aria-label={`${operationName(row.operation)} details`} id="tool-operation-inspector">
    <header className="ta-inspector-head">
      <div>
        <h3 tabIndex={-1} id="tool-operation-heading">{operationName(row.operation)}</h3>
        {description && <p>{description}</p>}
      </div>
      <button type="button" className="glyph-btn" aria-label="Close details" onClick={onClose}><AuditCloseGlyph /></button>
    </header>

    <dl className="ta-facts">
      <div><dt>Calls</dt><dd>{row.calls.toLocaleString()}</dd></div>
      <div><dt>Total time</dt><dd>{auditDuration(row.totalMs)}</dd></div>
      <div><dt>Usually</dt><dd>{auditDuration(row.medianMs)}</dd></div>
      <div><dt>Failed</dt><dd data-bad={row.failed > 0 || undefined}>{row.failed.toLocaleString()}{share && <small>{share}</small>}</dd></div>
    </dl>
    <p className="ta-note">
      {whoUsed(row)}
      {row.maxMs !== null && row.measured > 1 && <> · longest {auditDuration(row.maxMs)}</>}
      {row.unmatched > 0 && <> · {count(row.unmatched, 'call')} without a result yet</>}
    </p>

    {error && <p className="ta-message" role="alert">{error}</p>}
    {details?.history && <ToolAuditHistory key={row.operation} history={details.history} />}

    <section className="ta-calls-section" aria-labelledby="ta-calls-title">
      <div className="ta-calls-head">
        <h4 id="ta-calls-title">Calls</h4>
        <div className="uh-range" role="group" aria-label="Show calls">
          <button type="button" className="uh-range-btn" aria-pressed={kind === 'recent'} onClick={() => setKind('recent')}>Latest</button>
          <button type="button" className="uh-range-btn" aria-pressed={kind === 'slowest'} onClick={() => setKind('slowest')}>Slowest</button>
        </div>
      </div>
      {loading && !details && <p className="ta-note" role="status">Reading calls…</p>}
      {details && <>
        <ul className="ta-calls">{calls.map(call => <li key={call.id} data-state={call.state}>
          <span className="ta-call-when">{callTime(call.capturedAt, now)}</span>
          <span className="ta-call-who">{call.provider === 'claude' ? 'Claude' : 'Codex'}</span>
          <span className="ta-call-took">{auditDuration(call.durationMs)}</span>
          <span className="ta-call-state"><StateGlyph state={call.state} />{stateWord[call.state]}</span>
        </li>)}</ul>
        {!calls.length && <p className="ta-note">{kind === 'slowest' ? 'None of these calls was timed.' : 'No calls in this period.'}</p>}
        {details.total > calls.length && calls.length > 0 && <p className="ta-note">The {kind === 'recent' ? 'latest' : 'slowest'} {calls.length} of {details.total.toLocaleString()}.</p>}
      </>}
    </section>
    <p className="ta-note ta-inspector-foot">Times include any wait for your approval.</p>
  </section>;
}
