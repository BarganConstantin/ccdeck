import { useState, type CSSProperties } from 'react';
import { auditDuration, type AuditDay } from '../tool-audit';
import { currentLanguage, t as translate, useT } from '../i18n';
import { countOf, type Countable } from '../tool-audit-report';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(currentLanguage(), { timeZone: 'UTC', month: 'short', day: 'numeric' });
/** A day as the bars need it: a tool's calls, or a skill's uses under the same name. */
type HistoryDay = Pick<AuditDay, 'date' | 'calls' | 'status'> & { medianMs?: number | null };

const kindOf = (noun: string): Countable => noun === 'use' ? 'use' : 'call';

function dayText(day: HistoryDay, noun: string) {
  if (day.status === 'outside-history') return translate('insights.audit.hist.before', { date: dateLabel(day.date) });
  if (!day.calls) return translate(noun === 'use' ? 'insights.audit.hist.noUses' : 'insights.audit.hist.noCalls', { date: dateLabel(day.date) });
  return `${dateLabel(day.date)} · ${countOf(day.calls, kindOf(noun))}${day.medianMs != null ? ` · ${translate('insights.audit.hist.usually', { time: auditDuration(day.medianMs) })}` : ''}`;
}

/** The chart's shape while its days are read, in its place and at its height, so
 *  nothing below moves when the bars land. */
export function HistorySkeleton({ noun = 'call' }: { noun?: string }) {
  const t = useT();
  return <section className="ta-history" aria-hidden="true">
    <h4>{t(noun === 'use' ? 'insights.audit.hist.usesPerDay' : 'insights.audit.hist.callsPerDay')}</h4>
    <div className="ta-history-bars ta-history-skeleton" style={{ "--ta-days": 7 } as CSSProperties}>{[0.35, 0.6, 0.25, 0.8, 0.45, 0.3, 0.7].map((height, at) => <span key={at}><i className="ta-skel" style={{ "--ta-height": height } as CSSProperties} /></span>)}</div>
    <div className="ta-history-axis"><span>&nbsp;</span></div>
    <p className="ta-note ta-history-day"><i className="ta-skel" style={{ width: '9em' }} /></p>
  </section>;
}

/** Calls per day. A pointer over a bar names that day; the label below always
 *  says which day it is describing, so nothing depends on hover alone. */
export default function ToolAuditHistory({ history, noun = 'call' }: { history: { days: HistoryDay[] }; noun?: string }) {
  const t = useT();
  const days = history.days;
  const last = [...days].reverse().find(day => day.calls > 0) ?? days.at(-1);
  const [shown, setShown] = useState<string | null>(null);
  if (days.length < 3 || !last) return null;
  const day = days.find(item => item.date === shown) ?? last;
  const most = days.reduce((best, item) => item.calls > best.calls ? item : best, days[0]);
  const max = Math.max(1, most.calls);
  const title = t(noun === 'use' ? 'insights.audit.hist.usesPerDay' : 'insights.audit.hist.callsPerDay');
  return <section className="ta-history" aria-labelledby="ta-history-title">
    <h4 id="ta-history-title">{title}</h4>
    <div className="ta-history-bars" role="img" aria-label={t('insights.audit.hist.aria', { title, from: dateLabel(days[0].date), to: dateLabel(days.at(-1)!.date), busiest: dateLabel(most.date), count: countOf(most.calls, kindOf(noun)) })} onPointerLeave={() => setShown(null)} style={{ "--ta-days": days.length } as CSSProperties}>
      {days.map(item => <span key={item.date} data-shown={item.date === day.date || undefined} data-outside={item.status === 'outside-history' || undefined} onPointerEnter={() => setShown(item.date)}><i style={{ "--ta-height": item.calls / max } as CSSProperties} /></span>)}
    </div>
    <div className="ta-history-axis" aria-hidden="true"><span>{dateLabel(days[0].date)}</span><span>{dateLabel(days.at(-1)!.date)}</span></div>
    <p className="ta-note ta-history-day" aria-live="polite">{dayText(day, noun)}</p>
  </section>;
}
