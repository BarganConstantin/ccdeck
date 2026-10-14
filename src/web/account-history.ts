export interface SnapshotWindow {
  pct: number;
  resetAt: number | null;
}
export interface AccountSnapshot {
  t: number;
  savedAt: number;
  five_hour: SnapshotWindow | null;
  seven_day: SnapshotWindow | null;
}
export interface SnapshotAccount {
  id: string;
  name: string;
  removed?: boolean | null;
  points: AccountSnapshot[];
}
export interface AccountHistory {
  ok: boolean;
  enabled: boolean;
  retentionDays: number;
  bytes: number;
  storageError: string | null;
  accounts: SnapshotAccount[];
  error?: string;
}
export const storageSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
export function historySegments(
  points: AccountSnapshot[],
  window: "five_hour" | "seven_day",
) {
  const segments: { t: number; pct: number }[][] = [];
  let prev: AccountSnapshot | null = null;
  let segmentReset: number | null = null;
  for (const p of points) {
    const w = p[window];
    if (!w) {
      prev = null;
      continue;
    }
    if (
      !prev ||
      p.t - prev.t > 30 * 60_000 ||
      // Reported timestamps can jitter below second precision between readings.
      // Compare with the segment anchor so small changes cannot accumulate.
      (segmentReset == null || w.resetAt == null
        ? segmentReset !== w.resetAt
        : Math.abs(segmentReset - w.resetAt) > 1)
    ) {
      segments.push([]);
      segmentReset = w.resetAt;
    }
    segments.at(-1)!.push({ t: p.t, pct: w.pct });
    prev = p;
  }
  return segments;
}

export const formatSnapshotTime = (t: number, timeZone?: string) =>
  new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });

/** Fit real observations, not the full lookback. Padding is viewing space only. */
export function historyTimeDomain(times: number[], from: number, to: number) {
  let first = Infinity;
  let last = -Infinity;
  for (const t of times) {
    if (!Number.isFinite(t) || t < from || t > to) continue;
    first = Math.min(first, t);
    last = Math.max(last, t);
  }
  if (!Number.isFinite(first)) return { start: from, end: to };
  const padding = Math.max(15 * 60_000, (last - first) * 0.05);
  return { start: first - padding, end: last + padding };
}

export function formatHistoryAxis(t: number, start: number, end: number) {
  const sameDay =
    new Date(start).toDateString() === new Date(end).toDateString();
  return new Date(t).toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    ...(end - start < 2 * 86400_000
      ? { hour: "numeric", minute: "2-digit" }
      : {}),
  });
}

export interface HistoryRange {
  start: number;
  end: number;
}

export function clampHistoryRange(
  range: HistoryRange,
  full: HistoryRange,
): HistoryRange {
  const span = Math.min(
    Math.max(
      range.end - range.start,
      Math.min(5 * 60_000, full.end - full.start),
    ),
    full.end - full.start,
  );
  const start = Math.max(full.start, Math.min(range.start, full.end - span));
  return { start, end: start + span };
}

export function zoomHistoryRange(
  range: HistoryRange,
  full: HistoryRange,
  factor: number,
  anchor = 0.5,
) {
  const span = Math.max(
    Math.min(5 * 60_000, full.end - full.start),
    Math.min(full.end - full.start, (range.end - range.start) * factor),
  );
  const pivot = range.start + (range.end - range.start) * anchor;
  return clampHistoryRange(
    { start: pivot - span * anchor, end: pivot + span * (1 - anchor) },
    full,
  );
}
