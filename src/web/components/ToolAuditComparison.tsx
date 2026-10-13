import { useMemo } from 'react';
import { auditDuration, auditMetricText, auditMetricValue, auditMetrics, type AuditRow } from '../tool-audit';
import ToolAuditIntervalPlot from './ToolAuditIntervalPlot';
import { reportComparison, reportIntervalScale, reportLabels, type ReportMetric } from '../tool-audit-report';

export type SelectAuditOperation = (operation: string, keyboard: boolean, origin: HTMLElement) => void;
const subtitles: Record<ReportMetric, string> = {
  calls: 'Containing calls · counts overlap', totalMs: 'Associated call intervals · not wall-clock time',
  p95Ms: 'Median to P95 · at least 20 timings', failed: 'Failed containing calls · ranked by count',
};
const empty: Record<ReportMetric, string> = {
  calls: 'No operations recorded in this period.', totalMs: 'No measured intervals in this selection.',
  p95Ms: 'No operations have 20 measured calls yet.', failed: 'No reported failures in this selection.',
};
export default function ToolAuditComparison({ rows, metric, search, selected, onSelect, onExplore }: {
  rows: AuditRow[]; metric: ReportMetric; search: string; selected: string | null;
  onSelect: SelectAuditOperation; onExplore: (metric: ReportMetric) => void;
}) {
  const limit = metric === 'calls' || metric === 'totalMs' ? 5 : 3;
  const comparison = useMemo(() => reportComparison(rows, metric, search, limit), [rows, metric, search, limit]);
  const intervalScale = reportIntervalScale(comparison.maximum);
  return <section className="ta-comparison" data-metric={metric} aria-labelledby={`ta-chart-${metric}`}>
    <header className="ta-comparison-head"><h3 id={`ta-chart-${metric}`}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">{metric === 'p95Ms' ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></> : metric === 'failed' ? <><path d="m12 3 9 17H3Z" /><path d="M12 9v4m0 3v1" /></> : <><path d="M4 4v16h16M8 8h11M8 12h7M8 16h4" /></>}</svg>{reportLabels[metric]}</h3><button type="button" className="ta-text-button" onClick={() => onExplore(metric)} aria-label={`Explore all operations by ${reportLabels[metric].toLowerCase()}`}>Explore<span aria-hidden="true"> →</span></button></header>
    <p className="ta-chart-caption">{subtitles[metric]}</p>
    {metric === 'p95Ms' && comparison.rows.length > 0 && <div className="ta-plot-key" aria-label="Hollow point: median. Solid point: P95. Endpoints are not minimum and maximum."><span><svg width="12" height="12" aria-hidden="true"><circle className="ta-plot-median" cx="6" cy="6" r="4" /></svg>Median</span><span><svg width="12" height="12" aria-hidden="true"><circle className="ta-plot-p95" cx="6" cy="6" r="3.5" /></svg>P95</span><span>Observed interval</span></div>}
    {comparison.rows.length ? <ol className="ta-comparison-list" aria-label={`${reportLabels[metric]} operations`}>{comparison.rows.map(row => {
      const value = auditMetricValue(row, metric)!;
      return <li key={row.operation}><button type="button" className="ta-chart-operation" data-operation={row.operation} data-selected={selected === row.operation || undefined} aria-label={`${row.operation}: ${auditMetricText(value, metric)} ${auditMetrics[metric].unit}${metric === 'p95Ms' ? `; median ${auditDuration(row.medianMs)}; ${row.measured} measured calls` : metric === 'failed' ? `; ${row.completed} completed outcomes; ${row.completed >= 20 && row.errorRate !== null ? auditMetricText(row.errorRate, 'errorRate') + ' reported failure rate' : 'small sample; rate not compared'}` : ''}`} aria-haspopup="dialog" onClick={event => onSelect(row.operation, event.detail === 0, event.currentTarget)} title={`${row.operation} — ${auditMetrics[metric].note}${metric === 'p95Ms' ? ` Median ${auditDuration(row.medianMs)}; P95 ${auditDuration(value)} from ${row.measured} measured calls. These are not minimum/maximum endpoints.` : metric === 'failed' ? ' Rates require 20 completed outcomes; smaller samples are not rate-ranked.' : ''}`}>
        <span className="ta-chart-identity"><span className="ta-operation-name">{row.operation}</span>{metric === 'p95Ms' && <small>{row.measured.toLocaleString()} timed calls</small>}</span><span className="ta-chart-value">{auditMetricText(value, metric)}{metric === 'failed' && <small> / {row.completed.toLocaleString()} outcomes</small>}{metric === 'p95Ms' && <small>Median {auditDuration(row.medianMs)}</small>}</span>
        {metric === 'p95Ms' ? <ToolAuditIntervalPlot median={row.medianMs} p95={value} ceiling={intervalScale.ceiling} /> : metric === 'failed' ? <>
          <span className="ta-failure-context">{auditMetricValue(row, 'errorRate') === null ? 'Small sample · rate not compared' : `${auditMetricText(row.errorRate, 'errorRate')} of completed outcomes`}</span>
          <span className="ta-count-plot" aria-hidden="true"><svg width="100%" height="14"><line className="ta-plot-count" x1="0" x2={`${comparison.maximum ? value / comparison.maximum * 100 : 0}%`} y1="7" y2="7" /><circle className="ta-plot-failure" data-count-position={comparison.maximum ? value / comparison.maximum * 100 : 0} cx={`${comparison.maximum ? value / comparison.maximum * 100 : 0}%`} cy="7" r="3.5" /></svg></span>
        </> : <span className="ta-rank-track" aria-hidden="true"><span style={{ width: `${comparison.maximum ? value / comparison.maximum * 100 : 0}%` }} /></span>}

      </button></li>;
    })}</ol> : <div className="ta-chart-empty" role="status"><strong>{search && !comparison.eligible ? metric === 'calls' ? 'No operations match your search.' : metric === 'failed' ? 'No reported failures among matching operations.' : metric === 'p95Ms' ? 'No matching operations have 20 measured calls.' : 'No matching measured intervals.' : empty[metric]}</strong><span>{metric === 'p95Ms' ? 'Exact medians and available timings are in All operations.' : metric === 'failed' ? 'Missing outcomes are not counted as failures.' : 'Try another provider, period or search.'}</span></div>}
    {metric === 'p95Ms' && comparison.rows.length > 0 && <div className="ta-plot-axis" aria-label={`Shared observed-interval scale in ${intervalScale.unit}, zero to ${intervalScale.ticks[2].label}`}><div>{intervalScale.ticks.map(tick => <span key={tick.value}>{tick.label}</span>)}</div><span>{intervalScale.unit} · median and P95, not min/max</span></div>}
    {metric === 'failed' && comparison.rows.length > 0 && <p className="ta-plot-footnote">Reported outcomes can be shared across operations.</p>}
  </section>;
}
