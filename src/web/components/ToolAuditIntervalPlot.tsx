import { reportIntervalPosition } from '../tool-audit-report';

/** Decorative geometry: the enclosing operation button provides exact text values. */
export default function ToolAuditIntervalPlot({ median, p95, ceiling }: { median: number | null; p95: number; ceiling: number }) {
  const start = reportIntervalPosition(median, ceiling), end = reportIntervalPosition(p95, ceiling)!;
  return <span className="ta-interval-plot" aria-hidden="true"><svg width="100%" height="20">
    {[0, 50, 100].map(tick => <line key={tick} className="ta-plot-grid" x1={`${tick}%`} x2={`${tick}%`} y1="3" y2="17" />)}
    {start !== null && <><line className="ta-plot-range" data-median-position={start} data-p95-position={end} x1={`${start}%`} x2={`${end}%`} y1="10" y2="10" /><circle className="ta-plot-median" cx={`${start}%`} cy="10" r="5" /></>}
    <circle className="ta-plot-p95" data-p95-position={end} cx={`${end}%`} cy="10" r="3.5" />
  </svg></span>;
}
