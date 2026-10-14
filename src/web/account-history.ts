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
  for (const p of points) {
    const w = p[window];
    if (!w) {
      prev = null;
      continue;
    }
    if (
      !prev ||
      p.t - prev.t > 30 * 60_000 ||
      prev[window]?.resetAt !== w.resetAt
    )
      segments.push([]);
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
