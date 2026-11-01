// "Where the time went", read off a report's split: what each lane is called, what
// its share reads as, and what each lane opens into when it is pressed.
import { t, currentLanguage } from './i18n';
import { operationDescription, operationName } from './operation-glossary';
import { percent } from './tool-audit-report';
import { auditDuration, type TimePart, type TimeSplit } from './tool-audit';

export type Lane = 'claude' | 'machine' | 'you';
export interface LaneShare { id: Lane; label: string; ms: number; share: string; hint: string }

/** The calls' start-up, as the report names it: no command, so never in the table. */
export const STARTING = '(starting tools)';

const lanes = (lane: Lane) => ({ label: t(`insights.split.lane.${lane}`), hint: t(`insights.split.hint.${lane}`) });

/** The lanes that held any time, in the bar's fixed order. "You" is left out when it
 *  is zero rather than drawn as a sliver nobody can press. */
export function laneShares(split: TimeSplit): LaneShare[] {
  const ms: Record<Lane, number> = { claude: split.claudeMs, machine: split.machineMs, you: split.youMs };
  return (['claude', 'machine', 'you'] as Lane[]).filter(id => ms[id] > 0 || id !== 'you')
    .map(id => ({ id, ...lanes(id), ms: ms[id], share: split.totalMs ? percent(ms[id], split.totalMs) : '0%' }));
}

/** A long time as the ring's centre and the legend say it: whole hours from an hour up. */
export const glanceTime = (ms: number) => ms >= 3600000 ? `${Math.round(ms / 3600000).toLocaleString(currentLanguage())} h` : auditDuration(ms);

/** A ring's arcs, on a circle 100 long from the top: each part its share, less the
 *  gap that separates it from the next. One part alone closes the ring. */
export function ringArcs<T extends string>(parts: { id: T; value: number }[], gap = 0.8) {
  const live = parts.filter(part => part.value > 0);
  const total = live.reduce((sum, part) => sum + part.value, 0);
  if (!total) return [];
  if (live.length === 1) return [{ id: live[0].id, from: 0, length: 100 }];
  let at = 0;
  return live.map(part => {
    const share = part.value / total * 100, from = at;
    at += share;
    return { id: part.id, from: from + gap / 2, length: Math.max(0.3, share - gap) };
  });
}

/** The time ring's arcs: each lane by its time. */
export const donutArcs = (parts: LaneShare[], gap = 0.8) => ringArcs(parts.map(part => ({ id: part.id, value: part.ms })), gap);

/** What a lane mostly was, in the words of one line under it in the legend. */
export function laneFact(split: TimeSplit, lane: Lane) {
  if (lane === 'claude') return split.replies.count ? t('insights.split.fact.answers', { time: auditDuration(split.replies.medianMs) }) : t('insights.split.fact.thinking');
  const top = (lane === 'machine' ? split.machine : split.you)[0];
  if (!top) return t(lane === 'machine' ? 'insights.split.fact.tools' : 'insights.split.fact.approvals');
  const { operation } = top;
  if (operation === STARTING) return t('insights.split.fact.starting');
  if (lane === 'you') return operation === 'AskUserQuestion' ? t('insights.split.fact.questions')
    : operation === 'ExitPlanMode' ? t('insights.split.fact.plans') : t('insights.split.fact.approving', { name: operationName(operation) });
  return t('insights.split.fact.mostly', { name: operationName(operation) });
}

export interface PartRow extends TimePart { label: string; detail: string | null; share: string; inTable: boolean; more?: boolean }

/** A lane's parts as rows: the first `n`, then the rest as one row that opens them.
 *  Past the report's longest parts, what is left reads as everything else. */
export function laneParts(split: TimeSplit, lane: 'machine' | 'you', n = 6): PartRow[] {
  const parts = lane === 'machine' ? split.machine : split.you;
  const total = lane === 'machine' ? split.machineMs : split.youMs;
  const share = (ms: number) => total ? percent(ms, total) : '0%';
  const shown = parts.length > n + 1 ? parts.slice(0, n) : parts;
  const rest = total - shown.reduce((sum, part) => sum + part.ms, 0);
  const rows: PartRow[] = shown.map(part => ({ ...part, share: share(part.ms), ...partName(part.operation, lane) }));
  if (shown.length < parts.length) rows.push({ operation: '', ms: rest, share: share(rest), label: t('insights.split.more', { n: parts.length - shown.length }), detail: null, inTable: false, more: true });
  // Rounding leaves a few milliseconds; a real remainder is at least a second.
  else if (rest >= 1000) rows.push({ operation: '', ms: rest, share: share(rest), label: t('insights.split.else'), detail: null, inTable: false });
  return rows;
}

function partName(operation: string, lane: 'machine' | 'you') {
  if (operation === STARTING) return { label: t('insights.split.part.starting'), detail: t('insights.split.part.startingDetail'), inTable: false };
  if (lane === 'you' && operation === 'AskUserQuestion') return { label: t('insights.split.part.questions'), detail: null, inTable: true };
  if (lane === 'you' && operation === 'ExitPlanMode') return { label: t('insights.split.part.plan'), detail: null, inTable: true };
  return { label: operationName(operation), detail: lane === 'you' ? t('insights.split.part.waiting') : operationDescription(operation), inTable: true };
}

/** Days Claude answered clearly slower than it usually does in the period: half as
 *  slow again, over enough replies that one long answer is not a slow day. */
export function slowDays(split: TimeSplit) {
  const usual = split.replies.medianMs;
  if (!usual) return [];
  return split.replies.days.filter(day => day.count >= 5 && day.medianMs !== null && day.medianMs >= usual * 1.5);
}

const stopNames = new Set(['overloaded', 'rate_limit', 'server_error', 'authentication_failed']);
const stopName = (kind: string) => stopNames.has(kind) ? t(`insights.split.stop.${kind}`) : kind.replace(/_/g, ' ');
/** "2 turns ended on an error: Claude overloaded 1, server error 1", or null. */
export function stopsLine(stops: Record<string, number>) {
  const entries = Object.entries(stops).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return null;
  return t('insights.split.stops', { count: total, n: total.toLocaleString(currentLanguage()), list: entries.map(([kind, n]) => `${stopName(kind)} ${n.toLocaleString(currentLanguage())}`).join(t('insights.split.listSep')) });
}
