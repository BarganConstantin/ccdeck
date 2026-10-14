import { auditDuration, type AuditDay } from './tool-audit';
export type HistoryMetric = 'averageMs' | 'medianMs' | 'maxMs' | 'p95Ms';
export const historyLabels: Record<HistoryMetric, string> = { averageMs: 'Average', medianMs: 'Median', maxMs: 'Maximum', p95Ms: 'P95' };
export const historyDayStatus = (day: AuditDay) => day.status === 'outside-history' ? 'Outside retained history'
  : day.status === 'missing-timing' ? 'Calls recorded; timing unavailable' : day.status === 'no-calls' ? 'No recorded calls' : 'Measured intervals';
/** Null breaks a segment. Neither missing days nor ineligible P95 become zero. */
export function historySegments(days: AuditDay[], metric: HistoryMetric): { index: number; value: number }[][] {
  const segments: { index: number; value: number }[][] = [];
  let segment: { index: number; value: number }[] = [];
  days.forEach((day, index) => {
    const value = day[metric];
    if (value === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push({ index, value });
  });
  if (segment.length) segments.push(segment);
  return segments;
}

/** A fractional average/median must not read as an integer or a measured zero. */
export function historyIntervalText(ms: number | null): string {
  if (ms === null || ms >= 1000) return auditDuration(ms);
  if (ms > 0 && ms < .001) return '<0.001 ms';
  return `${ms.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`;
}

/** Axis labels stay compact even for long containing-call waits. */
export function historyAxisText(ms: number): string {
  if (ms >= 3600000) return `${(ms / 3600000).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
  return historyIntervalText(ms);
}
