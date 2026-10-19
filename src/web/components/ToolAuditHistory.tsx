import { useState, type CSSProperties } from 'react';
import { auditDuration, type AuditDay } from '../tool-audit';
import { count } from '../tool-audit-report';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
/** A day as the bars need it: a tool's calls, or a skill's uses under the same name. */
type HistoryDay = Pick<AuditDay, 'date' | 'calls' | 'status'> & { medianMs?: number | null };

function dayText(day: HistoryDay, noun: string) {
  if (day.status === 'outside-history') return `${dateLabel(day.date)} · before recording started`;
  if (!day.calls) return `${dateLabel(day.date)} · no ${noun}s`;
  return `${dateLabel(day.date)} · ${count(day.calls, noun)}${day.medianMs != null ? ` · usually ${auditDuration(day.medianMs)}` : ''}`;
}

/** Calls per day. A pointer over a bar names that day; the label below always
 *  says which day it is describing, so nothing depends on hover alone. */
export default function ToolAuditHistory({ history, noun = 'call' }: { history: { days: HistoryDay[] }; noun?: string }) {
  const days = history.days;
  const last = [...days].reverse().find(day => day.calls > 0) ?? days.at(-1);
  const [shown, setShown] = useState<string | null>(null);
  if (days.length < 3 || !last) return null;
  const day = days.find(item => item.date === shown) ?? last;
  const most = days.reduce((best, item) => item.calls > best.calls ? item : best, days[0]);
  const max = Math.max(1, most.calls);
  const title = `${noun[0].toUpperCase()}${noun.slice(1)}s`;
  return <section className="ta-history" aria-labelledby="ta-history-title">
    <h4 id="ta-history-title">{title} per day</h4>
    <div className="ta-history-bars" role="img" aria-label={`${title} per day from ${dateLabel(days[0].date)} to ${dateLabel(days.at(-1)!.date)}. The busiest day was ${dateLabel(most.date)} with ${count(most.calls, noun)}.`} onPointerLeave={() => setShown(null)} style={{ "--ta-days": days.length } as CSSProperties}>
      {days.map(item => <span key={item.date} data-shown={item.date === day.date || undefined} data-outside={item.status === 'outside-history' || undefined} onPointerEnter={() => setShown(item.date)}><i style={{ "--ta-height": item.calls / max } as CSSProperties} /></span>)}
    </div>
    <div className="ta-history-axis" aria-hidden="true"><span>{dateLabel(days[0].date)}</span><span>{dateLabel(days.at(-1)!.date)}</span></div>
    <p className="ta-note ta-history-day" aria-live="polite">{dayText(day, noun)}</p>
  </section>;
}
