export interface QuotaPoint { t: number; pct: number }
export interface QuotaSeries { id: string; label: string; resetAt: number; windowSec: number; points: QuotaPoint[] }
export interface QuotaHistory { ok: boolean; account: string | null; storageOk: boolean; series: QuotaSeries[] }
export const quotaSeriesKey = (s: QuotaSeries) => `${s.id}:${s.windowSec}:${s.resetAt}`;

// A gap is not an observed slope. The guide uses the whole window, while the
// solid line stops at the last recorded point, including for a stale reading.
export function quotaPlot(s: QuotaSeries) {
  const start = (s.resetAt - s.windowSec) * 1000;
  const x = (t: number) => 36 + Math.max(0, Math.min(1, (t - start) / (s.windowSec * 1000))) * 516;
  const y = (pct: number) => 12 + Math.max(0, Math.min(100, pct)) / 100 * 150;
  const segments: { x: number; y: number; t: number; pct: number }[][] = [];
  for (const p of s.points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.pct) || p.pct < 0 || p.pct > 100) continue;
    const prev = segments.at(-1)?.at(-1);
    if (!prev || p.t - prev.t > 10 * 60_000 || p.t <= prev.t) segments.push([]);
    segments.at(-1)!.push({ ...p, x: x(p.t), y: y(p.pct) });
  }
  return segments;
}

export function captureAge(t: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
