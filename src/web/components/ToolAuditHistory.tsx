import { useState, type CSSProperties } from 'react';
import { auditDuration, type AuditDay, type AuditHistory } from '../tool-audit';
import { count } from '../tool-audit-report';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });

function dayText(day: AuditDay) {
  if (day.status === 'outside-history') return `${dateLabel(day.date)} · before recording started`;
  if (!day.calls) return `${dateLabel(day.date)} · no calls`;
  return `${dateLabel(day.date)} · ${count(day.calls, 'call')}${day.medianMs !== null ? ` · usually ${auditDuration(day.medianMs)}` : ''}`;
}

/** Calls per day. A pointer over a bar names that day; the label below always
 *  says which day it is describing, so nothing depends on hover alone. */
export default function ToolAuditHistory({ history }: { history: AuditHistory }) {
  const days = history.days;
  const last = [...days].reverse().find(day => day.calls > 0) ?? days.at(-1);
  const [shown, setShown] = useState<string | null>(null);
  if (days.length < 3 || !last) return null;
  const day = days.find(item => item.date === shown) ?? last;
  const most = days.reduce((best, item) => item.calls > best.calls ? item : best, days[0]);
  const max = Math.max(1, most.calls);
  return <section className="ta-history" aria-labelledby="ta-history-title">
    <h4 id="ta-history-title">Calls per day</h4>
    <div className="ta-history-bars" role="img" aria-label={`Calls per day from ${dateLabel(days[0].date)} to ${dateLabel(days.at(-1)!.date)}. The busiest day was ${dateLabel(most.date)} with ${count(most.calls, 'call')}.`} onPointerLeave={() => setShown(null)} style={{ "--ta-days": days.length } as CSSProperties}>
      {days.map(item => <span key={item.date} data-shown={item.date === day.date || undefined} data-outside={item.status === 'outside-history' || undefined} onPointerEnter={() => setShown(item.date)}><i style={{ "--ta-height": item.calls / max } as CSSProperties} /></span>)}
    </div>
    <div className="ta-history-axis" aria-hidden="true"><span>{dateLabel(days[0].date)}</span><span>{dateLabel(days.at(-1)!.date)}</span></div>
    <p className="ta-note ta-history-day" aria-live="polite">{dayText(day)}</p>
  </section>;
}
