import type { ReactNode } from 'react';
import { t as translate, useT } from '../i18n';
import ToolAuditHistory, { HistorySkeleton } from './ToolAuditHistory';
import { operationDescription, operationName } from '../operation-glossary';
import { auditDuration, type AuditCall, type AuditReport, type AuditRow } from '../tool-audit';
import { callTime, countOf, failureShare } from '../tool-audit-report';

export function AuditCloseGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

/** A number still being read: a quiet bar where it will stand, never the last period's. */
export const Pending = ({ width = '3ch' }: { width?: string }) => <i className="ta-skel" style={{ width }} aria-hidden="true" />;

/** The latest calls or uses while they are read: lines in their place. */
export const PendingLines = ({ label }: { label: string }) => <div className="ta-skel-lines" role="status" aria-label={label}>
  {[92, 78, 86, 70, 82].map(width => <i key={width} className="ta-skel" style={{ width: `${width}%` }} />)}
</div>;

const stateWord = (state: AuditCall['state']) => translate(`insights.audit.state.${state}`);
const StateGlyph = ({ state }: { state: AuditCall['state'] }) => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d={state === 'failed' ? 'm4 4 8 8m0-8-8 8' : state === 'success' ? 'm3 8.5 3 3 7-7' : 'M4 8h8'} /></svg>;

function whoUsed(row: AuditRow) {
  const { claude, codex } = row.providers;
  if (claude && codex) return translate('insights.audit.by.both', { claude: claude.toLocaleString(), codex: codex.toLocaleString() });
  return translate(claude ? 'insights.audit.by.claude' : 'insights.audit.by.codex');
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
  const t = useT();
  const description = operationDescription(row.operation);
  const calls = details?.[kind] ?? [];
  const now = Date.now();
  const share = failureShare(row);
  const reading = (loading || pending) && !details;
  const n = (value: ReactNode) => pending ? <Pending /> : value;
  return <section className="ta-inspector" aria-label={t('insights.audit.insp.details', { name: operationName(row.operation) })} id="tool-operation-inspector">
    <header className="ta-inspector-head">
      <div>
        <h3 tabIndex={-1} id="tool-operation-heading">{operationName(row.operation)}</h3>
        {description && <p>{description}</p>}
      </div>
      <button type="button" className="glyph-btn" aria-label={t('insights.audit.insp.close')} onClick={onClose}><AuditCloseGlyph /></button>
    </header>

    <dl className="ta-facts" aria-busy={pending || undefined}>
      <div><dt>{t('insights.audit.col.calls')}</dt><dd>{n(row.calls.toLocaleString())}</dd></div>
      <div><dt>{t('insights.audit.col.time')}</dt><dd>{n(auditDuration(row.totalMs))}</dd></div>
      <div><dt>{t('insights.audit.col.usually')}</dt><dd>{n(auditDuration(row.medianMs))}</dd></div>
      <div><dt>{t('insights.audit.col.failed')}</dt><dd data-bad={(!pending && row.failed > 0) || undefined}>{n(<>{row.failed.toLocaleString()}{share && <small>{share}</small>}</>)}</dd></div>
    </dl>
    <p className="ta-note">
      {pending ? <Pending width="14em" /> : <>
        {whoUsed(row)}
        {row.maxMs !== null && row.measured > 1 && <> · {t('insights.audit.insp.longest', { time: auditDuration(row.maxMs) })}</>}
        {row.unmatched > 0 && <> · {t('insights.audit.insp.noResult', { calls: countOf(row.unmatched, 'call') })}</>}
      </>}
    </p>
    {onShowSkills && <button type="button" className="btn ta-show-skills" onClick={onShowSkills}>{t('insights.audit.insp.skills')}</button>}

    {error && <p className="ta-message" role="alert">{error}</p>}
    {details?.history ? <ToolAuditHistory key={row.operation} history={details.history} /> : reading && charted && <HistorySkeleton />}

    <section className="ta-calls-section" aria-labelledby="ta-calls-title">
      <div className="ta-calls-head">
        <h4 id="ta-calls-title">{t('insights.audit.col.calls')}</h4>
        <div className="uh-range" role="group" aria-label={t('insights.audit.insp.showCalls')}>
          <button type="button" className="uh-range-btn" aria-pressed={kind === 'recent'} onClick={() => setKind('recent')}>{t('insights.audit.insp.latest')}</button>
          <button type="button" className="uh-range-btn" aria-pressed={kind === 'slowest'} onClick={() => setKind('slowest')}>{t('insights.audit.sort.slowest')}</button>
        </div>
      </div>
      {reading && <PendingLines label={t('insights.audit.insp.readingCalls')} />}
      {details && <>
        <ul className="ta-calls">{calls.map(call => <li key={call.id} data-state={call.state}>
          <span className="ta-call-when">{callTime(call.capturedAt, now)}</span>
          <span className="ta-call-who">{call.provider === 'claude' ? 'Claude' : 'Codex'}</span>
          <span className="ta-call-took">{auditDuration(call.durationMs)}</span>
          <span className="ta-call-state"><StateGlyph state={call.state} />{stateWord(call.state)}</span>
        </li>)}</ul>
        {!calls.length && <p className="ta-note">{kind === 'slowest' ? t('insights.audit.insp.noneTimed') : t('insights.audit.insp.noCalls')}</p>}
        {details.total > calls.length && calls.length > 0 && <p className="ta-note">{t(kind === 'recent' ? 'insights.audit.insp.latestOf' : 'insights.audit.insp.slowestOf', { n: calls.length, total: details.total.toLocaleString() })}</p>}
      </>}
    </section>
    <p className="ta-note ta-inspector-foot">{t('insights.audit.insp.foot')}</p>
  </section>;
}
