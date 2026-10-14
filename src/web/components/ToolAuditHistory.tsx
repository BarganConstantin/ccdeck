import { useId, useLayoutEffect, useRef, useState } from 'react';
import { type AuditHistory } from '../tool-audit';
import { historyDayStatus, historyLabels, historySegments, historyIntervalText, historyAxisText, type HistoryMetric } from '../tool-audit-history';
import { reportExactInterval, reportIntervalScale } from '../tool-audit-report';

const dateLabel = (date: string, full = false) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: full ? 'long' : 'short', day: 'numeric', ...(full ? { year: 'numeric' } : {}) });
export default function ToolAuditHistory({ history }: { history: AuditHistory }) {
  const id = useId();
  const [comparison, setComparison] = useState<HistoryMetric | 'none'>('medianMs');
  const [selected, setSelected] = useState([...history.days].reverse().find(day => day.calls > 0)?.date ?? history.days.at(-1)?.date ?? '');
  const chartRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(240, chart.clientWidth)));
    observer.observe(chart); return () => observer.disconnect();
  }, []);
  const days = history.days;
  if (!days.length) return <p className="ta-note">No daily history in this selection.</p>;
  const found = days.findIndex(day => day.date === selected);
  const index = found < 0 ? days.length - 1 : found, day = days[index];
  const metrics: HistoryMetric[] = comparison === 'none' ? ['averageMs'] : ['averageMs', comparison];
  const hasMeasurements = days.some(day => day.averageMs !== null);
  const max = Math.max(0, ...days.flatMap(day => metrics.map(metric => day[metric] ?? 0)));
  const scale = reportIntervalScale(max), left = 64, right = width - 12, top = 16, bottom = 150;
  const x = (index: number) => days.length === 1 ? (left + right) / 2 : left + index / (days.length - 1) * (right - left);
  const y = (value: number) => bottom - value / scale.ceiling * (bottom - top);
  const maxCalls = Math.max(1, ...days.map(day => day.calls));
  const tickIndices = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const choosePoint = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - box.left) / box.width * width - left) / (right - left);
    setSelected(days[Math.max(0, Math.min(days.length - 1, Math.round(position * (days.length - 1))))].date);
  };
  return <section className="ta-history" aria-labelledby={`${id}-heading`}>
    <div className="ta-history-heading"><h4 id={`${id}-heading`}>Performance over time</h4><label className="ta-history-series">Compare<select aria-label="Compare daily interval" value={comparison} onChange={event => setComparison(event.target.value as HistoryMetric | 'none')}><option value="none">Average only</option><option value="medianMs">Median</option><option value="maxMs">Maximum</option><option value="p95Ms">P95</option></select></label></div>
    <p className="ta-note">Observed call intervals · {history.timeZone}</p>
    <div className="ta-history-key"><span>Average</span>{comparison !== 'none' && <span data-secondary>{historyLabels[comparison]}</span>}</div>
    <svg ref={chartRef} className="ta-history-chart" viewBox={`0 0 ${width} 180`} role="img" aria-label="Daily observed call intervals. Gaps indicate missing measurements. Use the day selector below for exact values." onPointerMove={choosePoint} onPointerDown={choosePoint}>
      {hasMeasurements && scale.ticks.map(tick => <g key={tick.value}><line className="ta-plot-grid" x1={left} x2={right} y1={y(tick.value)} y2={y(tick.value)} /><text x={left - 7} y={y(tick.value) + 4} textAnchor="end">{historyAxisText(tick.value)}</text></g>)}
      {!hasMeasurements && <text x={width / 2} y="80" textAnchor="middle">No valid timings</text>}
      <line className="ta-history-cursor" x1={x(index)} x2={x(index)} y1={top} y2={bottom} />
      {metrics.map((metric, m) => <g key={metric} data-series={metric} className={m ? 'ta-history-secondary' : 'ta-history-primary'}>{historySegments(days, metric).map((segment, i) => <g key={i}>
        {segment.length > 1 && <polyline fill="none" points={segment.map(point => `${x(point.index)},${y(point.value)}`).join(' ')} />}
        {segment.filter((point, i) => days.length <= 30 || point.index === index || segment.length === 1 || i === 0 || i === segment.length - 1).map(point => <circle key={point.index} cx={x(point.index)} cy={y(point.value)} r={point.index === index ? 4 : 2.5} />)}
      </g>)}</g>)}
      {tickIndices.map(i => <text key={i} x={x(i)} y="172" textAnchor={days.length === 1 ? 'middle' : i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>{dateLabel(days[i].date)}</text>)}
    </svg>
    <div className="ta-history-count-label"><span>Containing calls per day</span><span>0–{maxCalls.toLocaleString()}</span></div>
    <svg className="ta-history-counts" viewBox={`0 0 ${width} 38`} role="img" aria-label="Daily containing-call count, on a separate count scale." onPointerMove={choosePoint} onPointerDown={choosePoint}>
      <line className="ta-history-cursor" x1={x(index)} x2={x(index)} y1="2" y2="36" />
      {days.map((day, i) => <rect key={day.date} x={x(i) - Math.min(5, (right - left) / days.length / 3)} y={34 - day.calls / maxCalls * 30} width={Math.min(10, (right - left) / days.length * .65)} height={day.calls / maxCalls * 30} data-selected={i === index || undefined} />)}
    </svg>
    <div className="ta-history-day-nav"><button type="button" className="ta-history-step" aria-label="Previous day" disabled={index === 0} onClick={() => setSelected(days[index - 1].date)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button><label id={`${id}-day-label`} htmlFor={`${id}-day`}>{dateLabel(day.date, true)}</label><button type="button" className="ta-history-step" aria-label="Next day" disabled={index === days.length - 1} onClick={() => setSelected(days[index + 1].date)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button></div>
    <input id={`${id}-day`} className="ta-history-day-slider" type="range" min="0" max={days.length - 1} value={index} disabled={days.length === 1} aria-labelledby={`${id}-day-label`} aria-valuetext={`${dateLabel(day.date, true)}, ${day.calls} containing calls, ${day.measured} timed, ${historyDayStatus(day)}`} onChange={event => setSelected(days[Number(event.target.value)].date)} />
    <div className="ta-history-day" aria-live="polite" aria-atomic="true"><p className="ta-note">{historyDayStatus(day)}{day.partial && ' · partial day'}</p><dl><div><dt>Calls</dt><dd>{day.calls.toLocaleString()}</dd></div><div><dt>Valid timings</dt><dd>{day.measured.toLocaleString()}</dd></div>{(['averageMs', 'medianMs', 'p95Ms', 'maxMs'] as const).map(metric => <div key={metric}><dt>{historyLabels[metric]}</dt><dd title={reportExactInterval(day[metric])} aria-label={reportExactInterval(day[metric])}>{historyIntervalText(day[metric])}</dd></div>)}</dl>
      {day.measured < 20 && day.status !== 'outside-history' && <p className="ta-note">P95 needs 20 valid timings in this day.</p>}
      <p className="ta-note">Claude {day.providers.claude.toLocaleString()} · Codex {day.providers.codex.toLocaleString()}{day.shared > 0 && ` · ${day.shared.toLocaleString()} shared ${day.shared === 1 ? 'call' : 'calls'}`}</p>
    </div>
    <p className="ta-note ta-history-caption">Select a day on either chart or use the day controls. Gaps are unknown, not zero; waits and shared intervals can affect measurements.</p>
  </section>;
}
