import { t, currentLanguage } from './i18n';
import { auditDay, countOf, percent, periodIn, whoLabel } from './tool-audit-report';
import type { AuditProvider, SkillDay, SkillReport, SkillRow, SkillUse } from './tool-audit';

const DAY = 86400000;

/** Skill activity (#2181): which skills ran, how often, and when last. */
export type SkillSort = 'uses' | 'recent' | 'name';
export const skillSorts: { id: SkillSort }[] = [{ id: 'uses' }, { id: 'recent' }, { id: 'name' }];
/** The sort's name in the language on show. */
export const skillSortLabel = (id: SkillSort) => t(`insights.skills.sort.${id}`);

/** `anthropic-skills:docx` reads as a quiet `anthropic-skills:` before `docx`. */
export function skillParts(name: string) {
  const cut = name.lastIndexOf(':');
  return cut > 0 && cut < name.length - 1 ? { namespace: name.slice(0, cut + 1), short: name.slice(cut + 1) } : { namespace: '', short: name };
}

export function sortSkills(rows: SkillRow[], sort: SkillSort, search = ''): SkillRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter(row => !q || row.name.toLowerCase().includes(q)).sort((a, b) => {
    if (sort === 'recent' && a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
    if (sort === 'name') return skillParts(a.name).short.localeCompare(skillParts(b.name).short) || a.name.localeCompare(b.name);
    return b.uses - a.uses || b.lastAt - a.lastAt || a.name.localeCompare(b.name);
  });
}

/** Who ran it, in a few words: "Claude", "Claude and Codex". */
export function skillAgents(row: Pick<SkillRow, 'providers'>) {
  const { claude, codex } = row.providers;
  return claude && codex ? t('insights.skills.agents.both') : codex ? 'Codex' : 'Claude';
}

export type SkillOrigin = SkillUse['origin'];
/** The ring's and the bars' fixed order: the agents on their own, then you. */
export const skillOrigins: SkillOrigin[] = ['agent', 'detected', 'typed'];
const originLabel = (id: SkillOrigin) => t(`insights.skills.origin.${id}`);

/** Who started one use, in the words beside its time. */
export const useOrigin = (use: Pick<SkillUse, 'origin' | 'provider'>) =>
  use.origin === 'typed' && use.provider === 'codex' ? t('insights.skills.origin.typedCodex') : originLabel(use.origin);

/** A day's uses by who started them, a part each: "3 picked by Claude". */
export const dayOriginParts = (day: Pick<SkillDay, SkillOrigin>) =>
  skillOrigins.filter(id => day[id] > 0).map(id => ({ id, text: t(`insights.skills.day.${id}`, { n: day[id].toLocaleString(currentLanguage()) }) }));
/** The same in one line: "3 picked by Claude, 1 typed by you". */
export const dayOrigins = (day: Pick<SkillDay, SkillOrigin>) => dayOriginParts(day).map(part => part.text).join(t('insights.split.listSep'));
export interface OriginShare { id: SkillOrigin; label: string; uses: number; share: string; fact: string }

/** Whether the slash commands typed into Claude Code reach the deck for this view. */
const typedCounted = (report: Pick<SkillReport, 'typedCommands'>, provider: AuditProvider) =>
  provider === 'codex' || !report.typedCommands || report.typedCommands === 'on';

/** Who started the period's uses: Claude on its own, Codex on its own, or you. A lane
 *  with no uses is left out, except yours while typed commands are not counted, which
 *  says so rather than reading as never. */
export function originShares(report: Pick<SkillReport, 'rows' | 'typedCommands'>, provider: AuditProvider): OriginShare[] {
  const rows = report.rows.filter(row => row.uses > 0);
  const total = rows.reduce((sum, row) => sum + row.uses, 0);
  const uncounted = !typedCounted(report, provider);
  return skillOrigins.flatMap(id => {
    const uses = rows.reduce((sum, row) => sum + row[id], 0);
    if (!uses && !(id === 'typed' && uncounted)) return [];
    const mine = rows.filter(row => row[id] > 0).sort((a, b) => b[id] - a[id] || b.lastAt - a.lastAt);
    const fact = id === 'typed' && uncounted ? t(uses ? 'insights.skills.fact.claudeSlash' : 'insights.skills.fact.slash')
      : t(mine.length === 1 ? 'insights.skills.fact.only' : 'insights.skills.fact.mostly', { name: skillParts(mine[0].name).short });
    return [{ id, label: originLabel(id), uses, share: total ? percent(uses, total) : '0%', fact }];
  });
}

/** How a row's uses came about, in the words under its name: "Picked by Claude",
 *  or with counts once more than one way started it. */
export function originLine(row: SkillRow) {
  const mixed = skillOrigins.filter(id => row[id] > 0).length > 1;
  const pickers = ([['Claude', row.agent], ['Codex', row.detected]] as const).filter(([, n]) => n > 0);
  const picked = !pickers.length ? '' : mixed ? t('insights.skills.line.pickedMixed', { list: pickers.map(([who, n]) => `${who} ${n.toLocaleString(currentLanguage())}`).join(t('insights.split.listSep')) })
    : t(row.agent > 0 ? 'insights.skills.origin.agent' : 'insights.skills.origin.detected');
  const typed = !row.typed ? '' : mixed ? t('insights.skills.line.typedMixed', { n: row.typed.toLocaleString(currentLanguage()) })
    : t(row.providers.codex && !row.providers.claude ? 'insights.skills.line.typedInCodex' : 'insights.skills.origin.typed');
  return [picked, typed].filter(Boolean).join(' · ');
}

export interface SkillHighlight { kind: 'failing' | 'top' | 'typed' | 'quiet' | 'new'; skill: string; title: string; detail: string }

/** What is worth a look in the period's skills, at most three and one each: a skill
 *  that fails, the one you lean on, one you always start yourself (Claude never
 *  matched it), one that stopped running, one that just arrived. */
export function findSkillHighlights(report: Pick<SkillReport, 'rows' | 'total' | 'since' | 'until' | 'countedSince' | 'typedCommands'>, provider: AuditProvider): SkillHighlight[] {
  const used = report.rows.filter(row => row.uses > 0).sort((a, b) => b.uses - a.uses || b.lastAt - a.lastAt);
  const found: SkillHighlight[] = [];
  const add = (row: SkillRow | undefined, kind: SkillHighlight['kind'], title: string, detail: (row: SkillRow) => string) => {
    if (row && !found.some(item => item.skill === row.name)) found.push({ kind, skill: row.name, title, detail: detail(row) });
  };
  // How long the period was watched: the days before counting began say nothing.
  const watched = report.until - Math.max(report.since, report.countedSince);

  add(used.filter(row => row.failed >= 2).sort((a, b) => b.failed - a.failed)[0], 'failing', t('insights.skills.hl.failing'),
    row => t('insights.skills.hl.failing.detail', { failed: row.failed.toLocaleString(currentLanguage()), uses: countOf(row.uses, 'use') }));
  if (used.length >= 2 && used[0].uses >= 3 && used[0].uses >= report.total * 0.2) add(used[0], 'top', t('insights.skills.hl.top'),
    row => t('insights.skills.hl.top.detail', { n: row.uses.toLocaleString(currentLanguage()), total: report.total.toLocaleString(currentLanguage()), share: percent(row.uses, report.total), sessions: countOf(row.sessions, 'session') }));
  if (typedCounted(report, provider)) add(used.filter(row => row.typed >= 3 && !row.agent && !row.detected).sort((a, b) => b.typed - a.typed)[0],
    'typed', t('insights.skills.hl.typed'),
    row => t('insights.skills.hl.typed.detail', { times: countOf(row.typed, 'time'), agent: row.providers.codex && !row.providers.claude ? 'Codex' : 'Claude' }));
  if (watched >= 21 * DAY) add(used.filter(row => row.uses >= 3 && report.until - row.lastAt >= 7 * DAY).sort((a, b) => b.uses - a.uses)[0],
    'quiet', t('insights.skills.hl.quiet'), row => t('insights.skills.hl.quiet.detail', { uses: countOf(row.uses, 'use'), date: auditDay(row.lastAt) }));
  if (watched >= 14 * DAY) add(used.filter(row => report.until - row.firstAt < 7 * DAY).sort((a, b) => b.uses - a.uses)[0],
    'new', t('insights.skills.hl.new'), row => t('insights.skills.hl.new.detail', { date: auditDay(row.firstAt), uses: countOf(row.uses, 'use') }));
  return found.slice(0, 3);
}

/** The report in one sentence, as parts so the numbers can be emphasised. */
export function skillSummary(report: Pick<SkillReport, 'total' | 'rows' | 'failed' | 'repeats'>, provider: AuditProvider, period: string) {
  const used = report.rows.filter(row => row.uses > 0).length;
  return {
    period: periodIn(period),
    who: whoLabel(provider),
    skills: countOf(used, 'skill'),
    uses: t('insights.skills.times', { count: report.total, n: report.total.toLocaleString(currentLanguage()) }),
    failed: report.failed,
    repeats: report.repeats,
  };
}

/** True when counting began inside the period, so its start is not covered. */
export const countingStartedLate = (report: Pick<SkillReport, 'countedSince' | 'since'>) => report.countedSince > report.since;

/** Why the slash commands a person types are not counted, or null when they are or the view is Codex's. */
export function typedCommandsNote(report: Pick<SkillReport, 'typedCommands'>, provider: AuditProvider): string | null {
  if (provider === 'codex' || !report.typedCommands || report.typedCommands === 'on') return null;
  return t(report.typedCommands === 'off' ? 'insights.skills.typedNote.off' : 'insights.skills.typedNote.skipped');
}
