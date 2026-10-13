import { describe, expect, it } from 'vitest';
import { reportComparison, reportComparisonDescription, reportExactInterval, reportOperations, reportIntervalScale, reportIntervalPosition } from '../tool-audit-report';
import type { AuditRow } from '../tool-audit';
const row = (operation: string, extra: Partial<AuditRow> = {}): AuditRow => ({
  operation, calls: 20, completed: 20, failed: 0, errorRate: 0, measured: 20,
  missingTiming: 0, unmatched: 0, shared: 0, providers: { claude: 0, codex: 20 }, tools: ['exec'],
  totalMs: 2000, medianMs: 100, p95Ms: 120, maxMs: 200, ...extra,
});
describe('report evidence mapping', () => {
  const data = [row('frequent-fast', { calls: 150, totalMs: 15000 }), row('rare-slow', { calls: 10, measured: 10, totalMs: 80000, medianMs: 8000, p95Ms: 9000 }), row('slow-tail', { p95Ms: 9000, failed: 3 }), row('unknown', { totalMs: null, measured: 0, p95Ms: null }), row('zero', { totalMs: 0, p95Ms: 0 })];
  it('answers frequency and cumulative interval questions independently', () => {
    expect(reportComparison(data, 'calls', '').rows[0].operation).toBe('frequent-fast');
    const timing = reportComparison(data, 'totalMs', '');
    expect(timing.rows[0].operation).toBe('rare-slow');
    expect(timing.maximum).toBe(80000);
    expect(timing.rows.find(r => r.operation === 'frequent-fast')!.totalMs! / timing.maximum).toBe(.1875);
    expect(timing.rows.some(r => r.operation === 'unknown')).toBe(false);
    expect(timing.rows.some(r => r.operation === 'zero')).toBe(true);
  });
  it('excludes ineligible P95 even if an upstream row carries a value', () => {
    expect(reportComparison(data, 'p95Ms', '').rows.map(r => r.operation)).not.toContain('rare-slow');
    expect(reportComparison(data, 'p95Ms', '').rows[0].operation).toBe('slow-tail');
  });
  it('shows actual failure memberships only, without inflating zero outcomes', () => {
    expect(reportComparison(data, 'failed', '').rows.map(r => r.operation)).toEqual(['slow-tail']);
    expect(reportComparison(data, 'failed', 'zero').rows).toEqual([]);
  });
  it('filters all comparisons consistently without mutating source', () => {
    const before = JSON.stringify(data);
    expect(reportComparison(data, 'calls', ' FAST ').rows.map(r => r.operation)).toEqual(['frequent-fast']);
    expect(reportComparison(data, 'totalMs', 'unknown').eligible).toBe(0);
    expect(JSON.stringify(data)).toBe(before);
  });
  it('uses complete matching scale before slicing a dense ranking', () => {
    const dense = Array.from({ length: 150 }, (_, i) => row(`op${i}`, { calls: i + 1 }));
    expect(reportComparison(dense, 'calls', '', 6)).toMatchObject({ eligible: 150, maximum: 150 });
    expect(reportComparison(dense, 'calls', '', 6).rows).toHaveLength(6);
  });
  it('keeps unknowns last in both table sort directions; zero stays first ascending', () => {
    expect(reportOperations(data, 'totalMs', '', true).map(r => r.operation)).toEqual(['zero', 'slow-tail', 'frequent-fast', 'rare-slow', 'unknown']);
    expect(reportOperations(data, 'totalMs', '', false).at(-1)!.operation).toBe('unknown');
  });
  it('handles no data and deterministic ties', () => {
    expect(reportComparison([], 'calls', '')).toEqual({ rows: [], maximum: 0, eligible: 0 });
    expect(reportOperations([row('z'), row('a')], 'calls', '', true).map(r => r.operation)).toEqual(['a', 'z']);
  });
});

describe('median-to-P95 shared scale', () => {
  it('uses a readable zero-origin linear domain without changing metrics', () => {
    expect(reportIntervalScale(9000)).toEqual({ ceiling: 10000, unit: 'seconds', ticks: [{ value: 0, label: '0' }, { value: 5000, label: '5' }, { value: 10000, label: '10' }] });
    expect(reportIntervalPosition(100, 10000)).toBe(1);
    expect(reportIntervalPosition(9000, 10000)).toBe(90);
    expect(reportIntervalScale(31000).ceiling).toBe(50000);
  });
  it('does not fabricate a median when absent, and keeps equal/zero endpoints', () => {
    expect(reportIntervalPosition(null, 10000)).toBeNull();
    expect(reportIntervalPosition(0, 10000)).toBe(0);
    expect(reportIntervalPosition(120, 1000)).toBe(12);
    expect(reportIntervalScale(0).ceiling).toBe(1);
    expect(reportIntervalScale(120).unit).toBe('milliseconds');
  });
});


describe('accessible exact chart evidence', () => {
  it('preserves fractional milliseconds and missing versus zero', () => {
    expect(reportExactInterval(100.5)).toBe(`${(100.5).toLocaleString()} milliseconds`);
    expect(reportExactInterval(0)).toBe('0 milliseconds');
    expect(reportExactInterval(null)).toBe('not measured');
  });
  it('explains precise P95 endpoints, sample size and containing-call semantics', () => {
    const text = reportComparisonDescription(row('git status', { medianMs: 100.5, p95Ms: 9055 }), 'p95Ms');
    expect(text).toContain(`Median ${reportExactInterval(100.5)}; P95 ${reportExactInterval(9055)}`);
    expect(text).toContain('20 measured containing calls');
    expect(text).toContain('not minimum and maximum');
    expect(text).toContain('95%');
    expect(reportComparisonDescription(row('unknown', { medianMs: null, measured: 19, p95Ms: 9000 }), 'p95Ms')).toContain('P95 not measured');
  });
  it('states count ranking and completed denominator without promoting tiny rates', () => {
    const tiny = reportComparisonDescription(row('rare', { completed: 2, failed: 1, errorRate: .5 }), 'failed');
    expect(tiny).toContain('1 reported failed containing calls / 2 completed outcomes');
    expect(tiny).toContain('Ranked by failure count, not rate');
    expect(tiny).toContain('Small sample');
    expect(tiny).not.toContain('50%');
    expect(reportComparisonDescription(row('eligible', { failed: 1, errorRate: .05 }), 'failed')).toContain('Reported failure rate 5%');
  });
});
