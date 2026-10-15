import { operationDescription } from './operation-glossary';
import { auditDuration, type AuditProvider, type AuditReport, type AuditRow } from './tool-audit';

/** The four questions the list answers. Each is one column of the row. */
export type ToolSort = 'calls' | 'time' | 'slowest' | 'failed';
export const toolSorts: { id: ToolSort; label: string }[] = [
  { id: 'calls', label: 'Most used' },
  { id: 'time', label: 'Most time' },
  { id: 'slowest', label: 'Slowest' },
  { id: 'failed', label: 'Failures' },
];

/** Null is "not measured", which sorts last rather than reading as zero. */
export function toolSortValue(row: AuditRow, sort: ToolSort): number | null {
  if (sort === 'calls') return row.calls;
  if (sort === 'time') return row.totalMs;
  if (sort === 'slowest') return row.medianMs;
  return row.failed;
}

const matches = (row: AuditRow, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || row.operation.toLowerCase().includes(q) || (operationDescription(row.operation) ?? '').toLowerCase().includes(q);
};

export function sortTools(rows: AuditRow[], sort: ToolSort, search = ''): AuditRow[] {
  return rows.filter(row => matches(row, search)).sort((a, b) => {
    const av = toolSortValue(a, sort), bv = toolSortValue(b, sort);
    if (av !== bv) {
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    }
    return b.calls - a.calls || a.operation.localeCompare(b.operation);
  });
}

export const percent = (part: number, whole: number) => {
  const value = part / whole * 100;
  return `${value > 0 && value < 1 ? '<1' : Math.round(value)}%`;
};

/** Failed calls over calls that finished; calls still running have no outcome yet. */
export const failureShare = (row: Pick<AuditRow, 'failed' | 'completed'>) =>
  row.failed > 0 && row.completed > 0 ? percent(row.failed, row.completed) : null;

export interface Highlight { kind: 'time' | 'failing' | 'slow'; operation: string; title: string; detail: string }

/** At most three plain findings, each a fact read straight off the rows, and
 *  only when the sample is big enough not to make a story out of one call. */
export function findHighlights(rows: AuditRow[], totalMs: number | null): Highlight[] {
  const found: Highlight[] = [];
  const timed = rows.filter(row => row.totalMs !== null && row.measured >= 2);
  const hog = timed.slice().sort((a, b) => b.totalMs! - a.totalMs!)[0];
  if (hog && totalMs && hog.totalMs! >= totalMs * 0.2) {
    found.push({ kind: 'time', operation: hog.operation, title: 'takes the most time',
      detail: `${auditDuration(hog.totalMs)} over ${count(hog.calls, 'call')}, ${percent(hog.totalMs!, totalMs)} of all tool time.` });
  }
  const failing = rows.filter(row => row.completed >= 5 && row.failed >= 2 && row.failed / row.completed >= 0.1)
    .sort((a, b) => b.failed / b.completed - a.failed / a.completed || b.failed - a.failed)[0];
  if (failing) {
    found.push({ kind: 'failing', operation: failing.operation, title: 'fails often',
      detail: `${failing.failed.toLocaleString()} of ${count(failing.completed, 'call')} failed (${failureShare(failing)}).` });
  }
  const slow = rows.filter(row => row.medianMs !== null && row.measured >= 3 && row.medianMs >= 10000 && row.operation !== hog?.operation)
    .sort((a, b) => b.medianMs! - a.medianMs!)[0];
  if (slow) {
    found.push({ kind: 'slow', operation: slow.operation, title: 'is the slowest',
      detail: `Usually ${auditDuration(slow.medianMs)} per call; the longest took ${auditDuration(slow.maxMs)}.` });
  }
  return found;
}

export const count = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

export const periodLabels: Record<string, string> = { '1': '24 hours', '7': '7 days', '30': '30 days', '90': '90 days' };
const who: Record<AuditProvider, string> = { all: 'your agents', claude: 'Claude', codex: 'Codex' };

/** The report in one sentence, as parts so the numbers can be emphasised. */
export function summaryParts(report: Pick<AuditReport, 'total' | 'totalMs' | 'failed' | 'completed'>, provider: AuditProvider, period: string) {
  return {
    lead: `In the last ${periodLabels[period] ?? `${period} days`}, ${who[provider]} made`,
    calls: count(report.total, 'tool call'),
    time: report.totalMs ? auditDuration(report.totalMs) : null,
    failed: report.failed,
    failedShare: report.failed && report.completed ? percent(report.failed, report.completed) : null,
  };
}

export const auditDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** "Today 09:12", "Yesterday 18:40", "Oct 12, 14:03". */
export function callTime(ms: number, now = Date.now()) {
  const day = (t: number) => new Date(t).toDateString();
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (day(ms) === day(now)) return `Today ${time}`;
  if (day(ms) === day(now - 86400000)) return `Yesterday ${time}`;
  return `${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
