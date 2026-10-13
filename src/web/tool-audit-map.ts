import { auditMetricValue, type AuditRow } from './tool-audit';

export type AuditMapMetric = 'medianMs' | 'p95Ms';
export type AuditMapScale = 'auto' | 'linear' | 'log';
export interface AuditMapAxis {
  kind: 'linear' | 'log'; max: number; ticks: number[];
  position: (value: number) => number;
}
export interface AuditMapPoint { row: AuditRow; interval: number; x: number; y: number }
export interface AuditMapCluster { key: string; points: AuditMapPoint[]; x: number; y: number }

/** Zero-safe log1p is explicitly labelled; never turn missing intervals into zero. */
export function auditMapAxis(values: number[], requested: AuditMapScale): AuditMapAxis {
  const valid = values.filter(value => Number.isFinite(value) && value >= 0);
  const positive = valid.filter(value => value > 0);
  const largest = valid.reduce((max, value) => Math.max(max, value), 0);
  const kind = requested === 'log' || requested === 'auto' && positive.length > 1
    && largest / positive.reduce((min, value) => Math.min(min, value), Infinity) >= 100 ? 'log' : 'linear';
  const rough = Math.max(1, largest / 4);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find(value => value * power >= rough)! * power;
  const max = Math.max(1, Math.ceil(largest / step) * step);
  const ticks = [0];
  if (kind === 'log') {
    for (let value = 1; value < max; value *= 10) ticks.push(value);
    ticks.push(max);
  } else {
    for (let value = step; value <= max; value += step) ticks.push(value);
  }
  return { kind, max, ticks, position: value => {
    const bounded = Math.max(0, Math.min(max, value));
    return kind === 'log' ? Math.log1p(bounded) / Math.log1p(max) : bounded / max;
  } };
}

export function auditMapData(rows: AuditRow[], metric: AuditMapMetric, scale: AuditMapScale) {
  const eligible = rows.filter(row => auditMetricValue(row, metric) !== null);
  // X scope stays the complete dataset, including unplotted operations.
  const x = auditMapAxis(rows.map(row => row.calls), 'linear');
  const y = auditMapAxis(eligible.map(row => auditMetricValue(row, metric)!), scale);
  const points: AuditMapPoint[] = eligible.slice().sort((a, b) => a.operation.localeCompare(b.operation)).map(row => {
    const interval = auditMetricValue(row, metric)!;
    return { row, interval, x: x.position(row.calls), y: 1 - y.position(interval) };
  });
  return { x, y, points, excluded: rows.filter(row => auditMetricValue(row, metric) === null) };
}

/** Group screen-space neighbours without adding jitter or inventing aggregate metrics. */
export function auditMapClusters(points: AuditMapPoint[], width: number, height: number, cell = 16): AuditMapCluster[] {
  const buckets = new Map<string, AuditMapPoint[]>();
  for (const point of points) {
    const key = `${Math.floor(point.x * width / cell)}:${Math.floor(point.y * height / cell)}`;
    const bucket = buckets.get(key) ?? []; bucket.push(point); buckets.set(key, bucket);
  }
  let clusters: AuditMapCluster[] = Array.from(buckets, ([key, members]) => ({ key, points: members,
    x: members.reduce((sum, point) => sum + point.x, 0) / members.length,
    y: members.reduce((sum, point) => sum + point.y, 0) / members.length,
  }));
  // Grid neighbours can overlap across a cell boundary. Merge intersecting
  // rendered footprints, then recheck the new centroids; never jitter a sample.
  // A spatial index bounds candidate checks for large operation collections.
  while (clusters.length > 1) {
    const parent = clusters.map((_, index) => index);
    const find = (index: number): number => {
      while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
      return index;
    };
    const index = new Map<string, number[]>();
    const paired = new Set<number>();
    let merged = false;
    clusters.forEach((cluster, i) => {
      const x = cluster.x * width, y = cluster.y * height;
      const bx = Math.floor(x / 40), by = Math.floor(y / 40);
      let nearest = -1, nearestDistance = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of index.get(`${bx + dx}:${by + dy}`) ?? []) {
          if (paired.has(i) || paired.has(j)) continue;
          const other = clusters[j];
          const radius = (cluster.points.length > 1 ? 16 : 12) + (other.points.length > 1 ? 16 : 12) + 4;
          const distance = (x - other.x * width) ** 2 + (y - other.y * height) ** 2;
          if (distance < radius ** 2 && distance < nearestDistance) { nearest = j; nearestDistance = distance; }
        }
      }
      // Pair before recomputing centroids: transitive overlap chains must not
      // swallow an entire visible distribution into one giant badge.
      if (nearest >= 0) { parent[i] = nearest; paired.add(i); paired.add(nearest); merged = true; }
      const key = `${bx}:${by}`;
      const nearby = index.get(key) ?? []; nearby.push(i); index.set(key, nearby);
    });
    if (!merged) break;
    const groups = new Map<number, AuditMapPoint[]>();
    clusters.forEach((cluster, i) => { const key = find(i); const group = groups.get(key) ?? []; group.push(...cluster.points); groups.set(key, group); });
    clusters = Array.from(groups.values(), members => ({ key: members[0].row.operation, points: members,
      x: members.reduce((sum, point) => sum + point.x, 0) / members.length,
      y: members.reduce((sum, point) => sum + point.y, 0) / members.length,
    }));
  }
  return clusters;
}
