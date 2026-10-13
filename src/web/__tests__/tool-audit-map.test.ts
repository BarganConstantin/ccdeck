import { describe, expect, it } from 'vitest';
import { auditMapAxis, auditMapClusters, auditMapData } from '../tool-audit-map';
import type { AuditRow } from '../tool-audit';

const row = (operation: string, calls: number, interval: number | null, extra: Partial<AuditRow> = {}): AuditRow => ({
  operation, calls, completed: calls, failed: 0, errorRate: 0, measured: interval === null ? 0 : calls,
  missingTiming: interval === null ? calls : 0, unmatched: 0, shared: 0,
  providers: { claude: 0, codex: calls }, tools: ['exec'],
  medianMs: interval, p95Ms: interval, totalMs: interval === null ? null : calls * interval, maxMs: interval, ...extra,
});

describe('observed interval map', () => {
  it('maps fast frequent and slow rare operations to different dimensions', () => {
    const data = auditMapData([row('rg', 150, 100), row('build', 10, 8000)], 'medianMs', 'linear');
    const [build, rg] = data.points;
    expect(rg.x).toBeGreaterThan(build.x); expect(build.y).toBeLessThan(rg.y);
    expect(rg.interval).toBe(100); expect(build.interval).toBe(8000);
  });
  it('preserves measured zero and excludes unknown, never imputing it', () => {
    const data = auditMapData([row('zero', 20, 0), row('unknown', 200, null)], 'medianMs', 'auto');
    expect(data.points).toHaveLength(1); expect(data.points[0].y).toBe(1);
    expect(data.excluded[0].operation).toBe('unknown'); expect(data.x.max).toBe(200);
  });
  it('enforces P95 sample eligibility independently of frequency', () => {
    const data = auditMapData([row('few', 300, 1000, { measured: 19 }), row('enough', 20, 700)], 'p95Ms', 'linear');
    expect(data.points.map(point => point.row.operation)).toEqual(['enough']); expect(data.excluded).toHaveLength(1);
  });
  it('auto log is justified by positive range, not a performance threshold', () => {
    expect(auditMapAxis([0, 68, 30007.5], 'auto').kind).toBe('log');
    expect(auditMapAxis([0, 100, 200], 'auto').kind).toBe('linear');
    expect(auditMapAxis([0, 10000], 'auto').kind).toBe('linear');
    expect(auditMapAxis([1, 10000], 'linear').kind).toBe('linear');
  });
  it('zero-safe log maps exact endpoints and remains monotone', () => {
    const axis = auditMapAxis([0, 10000], 'log');
    expect(axis.position(0)).toBe(0); expect(axis.position(axis.max)).toBe(1);
    expect(axis.position(100)).toBeLessThan(axis.position(1000)); expect(axis.ticks).toContain(0);
  });
  it('empty/all-zero datasets have finite nondegenerate axes', () => {
    for (const values of [[], [0, 0]]) { const axis = auditMapAxis(values, 'auto');
      expect(axis.max).toBe(1); expect(axis.position(0)).toBe(0); expect(axis.ticks).toEqual([0, 1]); }
  });
  it('keeps every coincident operation accessible without fabricated jitter', () => {
    const points = auditMapData([row('a', 10, 100), row('b', 10, 100)], 'medianMs', 'linear').points;
    const clusters = auditMapClusters(points, 500, 300);
    expect(clusters).toHaveLength(1); expect(clusters[0].points).toHaveLength(2);
    expect(clusters[0].x).toBe(points[0].x); expect(clusters[0].y).toBe(points[0].y);
  });
  it('does not alter stats or aggregate mixed provider intervals again', () => {
    const mixed = row('git status', 30, 700, { shared: 15, providers: { claude: 10, codex: 20 }, failed: 3 });
    const data = auditMapData([mixed], 'medianMs', 'linear');
    expect(data.points[0].row).toBe(mixed); expect(data.points[0].interval).toBe(700); expect(mixed.shared).toBe(15);
  });
  it('retains all members in dense clusters and deterministic operation ordering', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`op${i}`, 2, 100));
    const a = auditMapData(rows, 'medianMs', 'auto'), b = auditMapData(rows.reverse(), 'medianMs', 'auto');
    expect(a.points).toEqual(b.points);
    expect(auditMapClusters(a.points, 200, 120).flatMap(cluster => cluster.points)).toHaveLength(300);
  });
  it('merges intersecting footprints across grid boundaries without losing samples', () => {
    const data = auditMapData(Array.from({ length: 100 }, (_, i) => row(`boundary${i}`, i + 1, 100 + i * 5)), 'medianMs', 'linear');
    const clusters = auditMapClusters(data.points, 400, 200);
    expect(clusters.length).toBeGreaterThan(1);
    expect(clusters.flatMap(cluster => cluster.points)).toHaveLength(100);
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i], b = clusters[j];
      const minimum = (a.points.length > 1 ? 16 : 12) + (b.points.length > 1 ? 16 : 12) + 4;
      expect(Math.hypot((a.x - b.x) * 400, (a.y - b.y) * 200)).toBeGreaterThanOrEqual(minimum);
    }
  });
});
