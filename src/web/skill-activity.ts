import { auditDay, count, percent, periodLabels } from './tool-audit-report';
import type { AuditProvider, SkillReport, SkillRow, SkillUse } from './tool-audit';

const DAY = 86400000;

/** Skill activity (#2181): which skills ran, how often, and when last. */
export type SkillSort = 'uses' | 'recent' | 'name';
export const skillSorts: { id: SkillSort; label: string }[] = [
  { id: 'uses', label: 'Most used' },
  { id: 'recent', label: 'Latest' },
  { id: 'name', label: 'Name' },
];

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

const agentNames = { claude: 'Claude', codex: 'Codex' } as const;

/** Who ran it, in a few words: "Claude", "Claude and Codex". */
export function skillAgents(row: Pick<SkillRow, 'providers'>) {
  const { claude, codex } = row.providers;
  return claude && codex ? 'Claude and Codex' : codex ? 'Codex' : 'Claude';
}

export const originWord: Record<SkillUse['origin'], string> = { typed: 'Typed', agent: 'By the agent', detected: 'Detected' };

export type SkillOrigin = SkillUse['origin'];
/** The ring's and the bars' fixed order: the agents on their own, then you. */
export const skillOrigins: SkillOrigin[] = ['agent', 'detected', 'typed'];
const originLabel: Record<SkillOrigin, string> = { agent: 'Picked by Claude', detected: 'Picked by Codex', typed: 'Typed by you' };
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
    const fact = id === 'typed' && uncounted ? (uses ? 'Claude’s slash commands are not counted' : 'Slash commands are not counted')
      : `${mine.length === 1 ? 'Only' : 'Mostly'} ${skillParts(mine[0].name).short}`;
    return [{ id, label: originLabel[id], uses, share: total ? percent(uses, total) : '0%', fact }];
  });
}

/** How a row's uses came about, in the words under its name: "Picked by Claude",
 *  or with counts once more than one way started it. */
export function originLine(row: SkillRow) {
  const mixed = skillOrigins.filter(id => row[id] > 0).length > 1;
  const picked = ([['Claude', row.agent], ['Codex', row.detected]] as const).filter(([, n]) => n > 0)
    .map(([who, n]) => mixed ? `${who} ${n.toLocaleString()}` : who).join(', ');
  const typed = !row.typed ? '' : mixed ? `typed by you ${row.typed.toLocaleString()}`
    : `Typed by you${row.providers.codex && !row.providers.claude ? ' in Codex' : ''}`;
  return [picked && `Picked by ${picked}`, typed].filter(Boolean).join(' · ');
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

  add(used.filter(row => row.failed >= 2).sort((a, b) => b.failed - a.failed)[0], 'failing', 'failed to load',
    row => `${row.failed.toLocaleString()} of ${count(row.uses, 'use')} failed.`);
  if (used.length >= 2 && used[0].uses >= 3 && used[0].uses >= report.total * 0.2) add(used[0], 'top', 'is your go-to',
    row => `${row.uses.toLocaleString()} of ${report.total.toLocaleString()} uses (${percent(row.uses, report.total)}), in ${count(row.sessions, 'session')}.`);
  if (typedCounted(report, provider)) add(used.filter(row => row.typed >= 3 && !row.agent && !row.detected).sort((a, b) => b.typed - a.typed)[0],
    'typed', 'is always started by you',
    row => `Typed ${count(row.typed, 'time')}, never picked by ${skillAgents(row) === 'Codex' ? 'Codex' : 'Claude'} on its own. If it should be, its description needs the words you use.`);
  if (watched >= 21 * DAY) add(used.filter(row => row.uses >= 3 && report.until - row.lastAt >= 7 * DAY).sort((a, b) => b.uses - a.uses)[0],
    'quiet', 'has gone quiet', row => `${count(row.uses, 'use')}, none since ${auditDay(row.lastAt)}.`);
  if (watched >= 14 * DAY) add(used.filter(row => report.until - row.firstAt < 7 * DAY).sort((a, b) => b.uses - a.uses)[0],
    'new', 'is new this week', row => `First used ${auditDay(row.firstAt)}, ${count(row.uses, 'use')} so far.`);
  return found.slice(0, 3);
}
export const useAgent = (use: Pick<SkillUse, 'provider'>) => agentNames[use.provider];

const who: Record<AuditProvider, string> = { all: 'your agents', claude: 'Claude', codex: 'Codex' };

/** The report in one sentence, as parts so the numbers can be emphasised. */
export function skillSummary(report: Pick<SkillReport, 'total' | 'rows' | 'failed' | 'repeats'>, provider: AuditProvider, period: string) {
  const used = report.rows.filter(row => row.uses > 0).length;
  return {
    lead: `In the last ${periodLabels[period] ?? `${period} days`}, ${who[provider]} used`,
    skills: count(used, 'skill'),
    uses: report.total === 1 ? 'once' : `${report.total.toLocaleString()} times`,
    failed: report.failed,
    repeats: report.repeats,
  };
}

/** True when counting began inside the period, so its start is not covered. */
export const countingStartedLate = (report: Pick<SkillReport, 'countedSince' | 'since'>) => report.countedSince > report.since;

/** Why the slash commands a person types are not counted, or null when they are or the view is Codex's. */
export function typedCommandsNote(report: Pick<SkillReport, 'typedCommands'>, provider: AuditProvider): string | null {
  if (provider === 'codex' || !report.typedCommands || report.typedCommands === 'on') return null;
  return report.typedCommands === 'off'
    ? 'Slash commands you type are not counted: the deck was started with AGENTS_DECK_SKILL_HOOK turned off.'
    : 'Slash commands you type are not counted yet: that needs Claude Code 2.1.116 or newer everywhere on this device. The deck’s start-up report says what it found.';
}
