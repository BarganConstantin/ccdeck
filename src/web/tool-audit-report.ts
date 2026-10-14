import { operationDescription, operationPurposeNote } from './operation-glossary';
import { auditMetricValue, auditMetricText, auditMetrics, sortAuditRows, type AuditMetric, type AuditRow } from './tool-audit';

export const reportMetrics = ['calls', 'totalMs', 'p95Ms', 'failed'] as const;
export type ReportMetric = typeof reportMetrics[number];
export const reportLabels: Record<ReportMetric, string> = {
  calls: 'Most used', totalMs: 'Most measured time', p95Ms: 'Slowest P95', failed: 'Reported failures',
};

/** Exact recorded milliseconds supplement the compact chart display, never inferred timing. */
export const reportExactInterval = (value: number | null) => value === null ? 'not measured' : `${value.toLocaleString(undefined, { maximumFractionDigits: 20 })} milliseconds`;
export function reportComparisonDescription(row: AuditRow, metric: ReportMetric) {
  const value = auditMetricValue(row, metric);
  const measurements = metric === 'p95Ms'
    ? `Median ${reportExactInterval(row.medianMs)}; P95 ${reportExactInterval(value)}; ${row.measured.toLocaleString()} measured containing calls. Endpoints are median and P95, not minimum and maximum.`
    : metric === 'failed'
      ? `${row.failed.toLocaleString()} reported failed containing calls / ${row.completed.toLocaleString()} completed outcomes. Ranked by failure count, not rate. ${auditMetricValue(row, 'errorRate') === null ? 'Small sample; rate not compared.' : `Reported failure rate ${auditMetricText(row.errorRate, 'errorRate')}.`}`
      : `${auditMetricText(value, metric)} ${auditMetrics[metric].unit}.`;
  const entry = operationDescription(row.operation);
  return `${row.operation}. ${entry ? entry.purpose + " " + operationPurposeNote + " " : ""}${measurements} ${auditMetrics[metric].note}`;
}

/** Rank only measured/eligible evidence; zero is measured, not missing. */
export function reportComparison(rows: AuditRow[], metric: ReportMetric, search: string, limit = 6) {
  const eligible = sortAuditRows(rows, metric, search).filter(row => {
    const value = auditMetricValue(row, metric);
    return value !== null && (metric !== 'failed' || value > 0);
  });
  const maximum = eligible.length ? auditMetricValue(eligible[0], metric)! : 0;
  return { rows: eligible.slice(0, limit), eligible: eligible.length, maximum };
}

/** Unknown metrics stay last in both directions, with stable identity ties. */
export function reportOperations(rows: AuditRow[], metric: AuditMetric, search: string, ascending: boolean) {
  const sorted = sortAuditRows(rows, metric, search);
  if (!ascending) return sorted;
  return sorted.sort((a, b) => {
    const av = auditMetricValue(a, metric), bv = auditMetricValue(b, metric);
    if (av === null) return bv === null ? a.operation.localeCompare(b.operation) : 1;
    if (bv === null) return -1;
    return av - bv || a.operation.localeCompare(b.operation);
  });
}

/** Round a nonnegative interval domain, preserving a linear zero origin. */
export function reportIntervalScale(maximum: number) {
  const value = Math.max(1, maximum);
  const power = 10 ** Math.floor(Math.log10(value));
  const ceiling = [1, 2, 5, 10].find(step => step * power >= value)! * power;
  const divisor = ceiling >= 1000 ? 1000 : 1;
  return { ceiling, unit: divisor === 1000 ? 'seconds' : 'milliseconds', ticks: [0, ceiling / 2, ceiling].map(tick => ({ value: tick, label: (tick / divisor).toLocaleString(undefined, { maximumFractionDigits: 3 }) })) };
}
export function reportIntervalPosition(value: number | null, ceiling: number): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value / ceiling * 100));
}
