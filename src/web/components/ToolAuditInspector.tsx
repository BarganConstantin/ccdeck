import type { ReactNode } from 'react';
import ToolAuditHistory, { HistorySkeleton } from './ToolAuditHistory';
import { operationDescription, operationName } from '../operation-glossary';
import { auditDuration, type AuditCall, type AuditReport, type AuditRow } from '../tool-audit';
import { callTime, count, failureShare } from '../tool-audit-report';

export function AuditCloseGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

/** A number still being read: a quiet bar where it will stand, never the last period's. */
export const Pending = ({ width = '3ch' }: { width?: string }) => <i className="ta-skel" style={{ width }} aria-hidden="true" />;

/** The latest calls or uses while they are read: lines in their place. */
export const PendingLines = ({ label }: { label: string }) => <div className="ta-skel-lines" role="status" aria-label={label}>
  {[92, 78, 86, 70, 82].map(width => <i key={width} className="ta-skel" style={{ width: `${width}%` }} />)}
</div>;

const stateWord: Record<AuditCall['state'], string> = { success: 'Done', failed: 'Failed', unmatched: 'No result' };
const StateGlyph = ({ state }: { state: AuditCall['state'] }) => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d={state === 'failed' ? 'm4 4 8 8m0-8-8 8' : state === 'success' ? 'm3 8.5 3 3 7-7' : 'M4 8h8'} /></svg>;

function whoUsed(row: AuditRow) {
  const { claude, codex } = row.providers;
  if (claude && codex) return `${claude.toLocaleString()} by Claude, ${codex.toLocaleString()} by Codex`;
  return claude ? 'All by Claude' : 'All by Codex';
}

export default function ToolAuditInspector({ row, details, loading, pending = false, charted = true, error, kind, setKind, onClose, onShowSkills }: {
  row: AuditRow; details: AuditReport['details']; loading: boolean; error: string;
  /** A new period or agent is being read: the row is the last one's, so its numbers wait. */
  pending?: boolean;
  /** Whether the period is long enough to chart by day, so its chart's place is kept while read. */
  charted?: boolean;
  kind: 'recent' | 'slowest'; setKind: (kind: 'recent' | 'slowest') => void; onClose: () => void;
  /** The Skill tool's row: which skills those calls loaded is the Skills view's answer. */
  onShowSkills?: () => void;
}) {
  const description = operationDescription(row.operation);
  const calls = details?.[kind] ?? [];
  const now = Date.now();
  const share = failureShare(row);
  const reading = (loading || pending) && !details;
  const n = (value: ReactNode) => pending ? <Pending /> : value;
  return <section className="ta-inspector" aria-label={`${operationName(row.operation)} details`} id="tool-operation-inspector">
    <header className="ta-inspector-head">
      <div>
        <h3 tabIndex={-1} id="tool-operation-heading">{operationName(row.operation)}</h3>
        {description && <p>{description}</p>}
      </div>
      <button type="button" className="glyph-btn" aria-label="Close details" onClick={onClose}><AuditCloseGlyph /></button>
    </header>

    <dl className="ta-facts" aria-busy={pending || undefined}>
      <div><dt>Calls</dt><dd>{n(row.calls.toLocaleString())}</dd></div>
      <div><dt>Total time</dt><dd>{n(auditDuration(row.totalMs))}</dd></div>
      <div><dt>Usually</dt><dd>{n(auditDuration(row.medianMs))}</dd></div>
      <div><dt>Failed</dt><dd data-bad={(!pending && row.failed > 0) || undefined}>{n(<>{row.failed.toLocaleString()}{share && <small>{share}</small>}</>)}</dd></div>
    </dl>
    <p className="ta-note">
      {pending ? <Pending width="14em" /> : <>
        {whoUsed(row)}
        {row.maxMs !== null && row.measured > 1 && <> · longest {auditDuration(row.maxMs)}</>}
        {row.unmatched > 0 && <> · {count(row.unmatched, 'call')} without a result yet</>}
      </>}
    </p>
    {onShowSkills && <button type="button" className="btn ta-show-skills" onClick={onShowSkills}>See which skills ran →</button>}

    {error && <p className="ta-message" role="alert">{error}</p>}
    {details?.history ? <ToolAuditHistory key={row.operation} history={details.history} /> : reading && charted && <HistorySkeleton />}

    <section className="ta-calls-section" aria-labelledby="ta-calls-title">
      <div className="ta-calls-head">
        <h4 id="ta-calls-title">Calls</h4>
        <div className="uh-range" role="group" aria-label="Show calls">
          <button type="button" className="uh-range-btn" aria-pressed={kind === 'recent'} onClick={() => setKind('recent')}>Latest</button>
          <button type="button" className="uh-range-btn" aria-pressed={kind === 'slowest'} onClick={() => setKind('slowest')}>Slowest</button>
        </div>
      </div>
      {reading && <PendingLines label="Reading calls" />}
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
