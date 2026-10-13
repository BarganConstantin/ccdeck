export type AuditProvider = 'all' | 'claude' | 'codex';
export interface AuditRow {
  operation: string; calls: number; completed: number; failed: number; errorRate: number | null;
  measured: number; missingTiming: number; unmatched: number; shared: number;
  providers: { claude: number; codex: number }; tools: string[];
  totalMs: number | null; medianMs: number | null; p95Ms: number | null; maxMs: number | null;
}
export interface AuditCall {
  id: string; operation: string; provider: 'claude' | 'codex'; tool: string; capturedAt: number;
  durationMs: number | null; state: 'unmatched' | 'failed' | 'success'; clock: 'hook' | 'rollout'; shared: boolean;
}
export interface AuditReport {
  ok: boolean; capturedAt: number; since: number; until: number; provider: AuditProvider;
  total: number; measured: number; failed: number; unmatched: number; corrupt: number; orphaned: number;
  rows: AuditRow[]; details: { operation: string; total: number; slowest: AuditCall[]; recent: AuditCall[] } | null;
  totalMs: number | null; completed: number; observedSince: number | null; observedUntil: number | null; retainedSince: number;
  providers: Record<'claude' | 'codex', { calls: number; measured: number; failed: number }>;
  duplicates: number;
  bytes: number; storageOk: boolean; dropped: number; deviceId: string; startedAt: number; retentionDays: number;
}
export interface AuditStorage { ok: boolean; bytes: number; retentionDays: 30 | 60 | 90; startedAt: number; storageOk: boolean; dropped: number }
export const auditDuration = (ms: number | null) => {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
  if (ms < 3600000) return `${(ms / 60000).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
  return `${(ms / 3600000).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
};
export const auditBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576
  ? `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
  : `${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
export const auditDate = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const auditRange = (since: number, until: number) => {
  const start = new Date(since), end = new Date(until);
  return `${auditDate(since)} – ${start.toDateString() === end.toDateString() ? end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : auditDate(until)}`;
};
export type AuditMetric = 'calls' | 'totalMs' | 'medianMs' | 'p95Ms' | 'maxMs' | 'failed' | 'errorRate';
export const auditMetrics: Record<AuditMetric, { label: string; short: string; unit: string; note: string }> = {
  calls: { label: 'Most called', short: 'Calls', unit: 'containing calls', note: 'Calls containing each detected operation. One call can appear in several rows; counts are not additive.' },
  totalMs: { label: 'Cumulative time', short: 'Cumulative', unit: 'cumulative measured interval', note: 'Sum of measured containing-call intervals for each operation. Shared and parallel intervals overlap; this is not wall-clock time.' },
  medianMs: { label: 'Typical latency', short: 'Median', unit: 'median measured interval', note: 'Middle measured containing-call interval. Approval, delivery and orchestration waits may be included.' },
  p95Ms: { label: 'Slow tails · P95', short: 'P95', unit: '95th percentile interval', note: '95% of measured intervals fall at or below P95. Requires at least 20 measured calls; smaller samples are unavailable.' },
  maxMs: { label: 'Slowest single call', short: 'Max', unit: 'maximum measured interval', note: 'Largest observed containing-call interval, not a typical duration or a trend.' },
  failed: { label: 'Reported failures', short: 'Failures', unit: 'reported failed containing calls', note: 'Reported failed outcomes, attributed to the containing call. In shared calls this does not identify which inner command failed.' },
  errorRate: { label: 'Reported failure rate', short: 'Failure rate', unit: '% of completed outcomes', note: 'Reported failures / observed completed outcomes. Ranking requires at least 20 outcomes; this threshold is a sample floor, not statistical confidence.' },
};
export const auditMetricValue = (row: AuditRow, metric: AuditMetric): number | null => {
  if (metric === 'p95Ms' && row.measured < 20 || metric === 'errorRate' && row.completed < 20) return null;
  return row[metric];
};
export const auditMetricText = (value: number | null, metric: AuditMetric) => value === null ? '—'
  : metric === 'errorRate' ? `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
  : metric === 'calls' || metric === 'failed' ? value.toLocaleString() : auditDuration(value);
export const sortAuditRows = (rows: AuditRow[], key: AuditMetric, search: string) => rows
  .filter(r => r.operation.toLowerCase().includes(search.trim().toLowerCase()))
  .slice().sort((a, b) => (auditMetricValue(b, key) ?? -1) - (auditMetricValue(a, key) ?? -1) || a.operation.localeCompare(b.operation));

/** Busy responses do no disk work. Retry briefly while a cancelled worker exits. */
export async function readAuditReport(query: string, signal: AbortSignal): Promise<AuditReport> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`/api/tool-audit?${query}`, { signal });
    const reply = await res.json();
    if (res.status === 409 && reply.reason === 'busy' && attempt < 3) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { window.clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 300);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      continue;
    }
    if (!res.ok || !reply.ok || !Array.isArray(reply.rows)) throw new Error('Could not build the tool report. Try Refresh or reduce history retention in Settings.');
    return reply as AuditReport;
  }
  throw new Error('A tool report is already running. Try Refresh in a moment.');
}
