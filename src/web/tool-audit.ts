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
export const sortAuditRows = (rows: AuditRow[], key: 'calls' | 'totalMs' | 'medianMs' | 'maxMs' | 'failed', search: string) => rows
  .filter(r => r.operation.toLowerCase().includes(search.trim().toLowerCase()))
  .slice().sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.operation.localeCompare(b.operation));

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
