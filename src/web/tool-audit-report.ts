import { currentLanguage, t } from './i18n';
import { operationDescription } from './operation-glossary';
import { auditDuration, type AuditProvider, type AuditReport, type AuditRow } from './tool-audit';

/** The four questions the list answers. Each is one column of the row. */
export type ToolSort = 'calls' | 'time' | 'slowest' | 'failed';
export const toolSorts: { id: ToolSort }[] = [{ id: 'calls' }, { id: 'time' }, { id: 'slowest' }, { id: 'failed' }];
/** The sort's name in the language on show. */
export const toolSortLabel = (id: ToolSort) => t(`insights.audit.sort.${id}`);

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
    found.push({ kind: 'time', operation: hog.operation, title: t('insights.audit.hl.time'),
      detail: t('insights.audit.hl.time.detail', { time: auditDuration(hog.totalMs), calls: countOf(hog.calls, 'call'), share: percent(hog.totalMs!, totalMs) }) });
  }
  const failing = rows.filter(row => row.completed >= 5 && row.failed >= 2 && row.failed / row.completed >= 0.1)
    .sort((a, b) => b.failed / b.completed - a.failed / a.completed || b.failed - a.failed)[0];
  if (failing) {
    found.push({ kind: 'failing', operation: failing.operation, title: t('insights.audit.hl.failing'),
      detail: t('insights.audit.hl.failing.detail', { failed: failing.failed.toLocaleString(currentLanguage()), calls: countOf(failing.completed, 'call'), share: failureShare(failing) ?? '' }) });
  }
  const slow = rows.filter(row => row.medianMs !== null && row.measured >= 3 && row.medianMs >= 10000 && row.operation !== hog?.operation)
    .sort((a, b) => b.medianMs! - a.medianMs!)[0];
  if (slow) {
    found.push({ kind: 'slow', operation: slow.operation, title: t('insights.audit.hl.slow'),
      detail: t('insights.audit.hl.slow.detail', { usual: auditDuration(slow.medianMs), longest: auditDuration(slow.maxMs) }) });
  }
  return found;
}

export const count = (n: number, noun: string) => `${n.toLocaleString(currentLanguage())} ${noun}${n === 1 ? '' : 's'}`;

/** What `count` counts, in the language on show: "1 call", "3 tool calls", "2 sessions". */
export type Countable = 'call' | 'toolCall' | 'use' | 'session' | 'repeat' | 'repeatedRun' | 'time' | 'reply' | 'turn' | 'skill' | 'moreProject';
export const countOf = (n: number, kind: Countable) => t(`insights.count.${kind}`, { count: n, n: n.toLocaleString(currentLanguage()) });

export const periodLabels: Record<string, string> = { '1': '24 hours', '7': '7 days', '30': '30 days', '90': '90 days' };
const who: Record<AuditProvider, string> = { all: 'your agents', claude: 'Claude', codex: 'Codex' };
/** The period in words, in the language on show ("7 days", "24 hours"). */
export const periodLabel = (period: string) => periodLabels[period] ? t(`insights.audit.period.${period}`) : t('insights.audit.period.days', { n: period });
export const whoLabel = (provider: AuditProvider) => provider === 'all' ? t('insights.audit.who.all') : who[provider];

/** The report in one sentence, as parts so the numbers can be emphasised. */
export function summaryParts(report: Pick<AuditReport, 'total' | 'totalMs' | 'failed' | 'completed'>, provider: AuditProvider, period: string) {
  return {
    period: periodLabel(period),
    who: whoLabel(provider),
    calls: countOf(report.total, 'toolCall'),
    time: report.totalMs ? auditDuration(report.totalMs) : null,
    failed: report.failed,
    failedShare: report.failed && report.completed ? percent(report.failed, report.completed) : null,
  };
}

export const auditDay = (ms: number) => new Date(ms).toLocaleDateString(currentLanguage(), { month: 'short', day: 'numeric' });

/** A call's day as a list groups by it: "Today", "Yesterday", "Oct 21". */
export function callDay(ms: number, now = Date.now(), inSentence = false) {
  const day = (t: number) => new Date(t).toDateString();
  if (day(ms) === day(now)) return t(inSentence ? 'insights.audit.todayMid' : 'insights.audit.today');
  if (day(ms) === day(now - 86400000)) return t(inSentence ? 'insights.audit.yesterdayMid' : 'insights.audit.yesterday');
  return new Date(ms).toLocaleDateString(currentLanguage(), { month: 'short', day: 'numeric' });
}
export const callClock = (ms: number) => new Date(ms).toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit' });

/** "Today 09:12", "Yesterday 18:40", "Oct 12, 14:03". */
export function callTime(ms: number, now = Date.now(), inSentence = false) {
  const day = callDay(ms, now, inSentence);
  const relative = day === t(inSentence ? 'insights.audit.todayMid' : 'insights.audit.today') || day === t(inSentence ? 'insights.audit.yesterdayMid' : 'insights.audit.yesterday');
  return relative ? t('insights.audit.dayTime', { day, time: callClock(ms) }) : t('insights.audit.dateTime', { day, time: callClock(ms) });
}
