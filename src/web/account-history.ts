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

export const createSnapshotTimeFormatter = (timeZone?: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
export const formatSnapshotTime = (t: number, timeZone?: string) =>
  createSnapshotTimeFormatter(timeZone).format(t);

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

export function historyTooltipPosition(
  width: number,
  height: number,
  tooltipWidth: number,
  tooltipHeight: number,
  mouseX: number,
  mouseY: number,
  pointX: number,
  pointY: number,
) {
  const gap = 16,
    padding = 4;
  const left = Math.min(mouseX, pointX) - gap,
    right = Math.max(mouseX, pointX) + gap;
  const top = Math.min(mouseY, pointY) - gap,
    bottom = Math.max(mouseY, pointY) + gap;
  const clampX = (x: number) =>
    Math.max(padding, Math.min(x, width - tooltipWidth - padding));
  const clampY = (y: number) =>
    Math.max(padding, Math.min(y, height - tooltipHeight - padding));
  const candidates = [
    { x: right, y: clampY(mouseY - tooltipHeight / 2) },
    { x: left - tooltipWidth, y: clampY(mouseY - tooltipHeight / 2) },
    { x: clampX(mouseX - tooltipWidth / 2), y: top - tooltipHeight },
    { x: clampX(mouseX - tooltipWidth / 2), y: bottom },
  ];
  return (
    candidates.find(
      (p) =>
        p.x >= padding &&
        p.y >= padding &&
        p.x + tooltipWidth <= width - padding &&
        p.y + tooltipHeight <= height - padding,
    ) ?? { x: clampX(right), y: clampY(top - tooltipHeight) }
  );
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

/** Shape-preserving cubic guide: passes through readings, never overshoots them. */
export function smoothHistoryPath(points: { x: number; y: number }[]) {
  if (!points.length) return "";
  const move = `M${points[0].x},${points[0].y}`;
  if (points.length === 1) return move;
  const dx = points.slice(1).map((p, i) => p.x - points[i].x);
  if (dx.some((d) => d <= 0))
    return (
      move +
      points
        .slice(1)
        .map((p) => `L${p.x},${p.y}`)
        .join("")
    );
  const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / dx[i]);
  const tangents = points.map((_, i) =>
    i === 0
      ? slopes[0]
      : i === slopes.length
        ? slopes[i - 1]
        : slopes[i - 1] * slopes[i] <= 0
          ? 0
          : (slopes[i - 1] + slopes[i]) / 2,
  );
  slopes.forEach((slope, i) => {
    if (slope === 0) {
      tangents[i] = tangents[i + 1] = 0;
      return;
    }
    const length = Math.hypot(tangents[i] / slope, tangents[i + 1] / slope);
    if (length > 3) {
      tangents[i] *= 3 / length;
      tangents[i + 1] *= 3 / length;
    }
  });
  return (
    move +
    points
      .slice(1)
      .map((p, i) => {
        const a = points[i],
          step = dx[i] / 3;
        return `C${a.x + step},${a.y + tangents[i] * step} ${p.x - step},${p.y - tangents[i + 1] * step} ${p.x},${p.y}`;
      })
      .join("")
  );
}
/** Usage percentages stay inside their real 0–100 domain, with a 5pp minimum. */
export function clampUsageRange(range: HistoryRange): HistoryRange {
  const span = Math.max(5, Math.min(100, range.end - range.start));
  const start = Math.max(0, Math.min(range.start, 100 - span));
  return { start, end: start + span };
}

export function zoomUsageRange(
  range: HistoryRange,
  factor: number,
  anchor = 0.5,
) {
  const span = Math.max(5, Math.min(100, (range.end - range.start) * factor));
  const pivot = range.start + (range.end - range.start) * anchor;
  return clampUsageRange({
    start: pivot - span * anchor,
    end: pivot + span * (1 - anchor),
  });
}
