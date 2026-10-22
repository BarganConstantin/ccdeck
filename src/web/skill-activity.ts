import { count, periodLabels } from './tool-audit-report';
import type { AuditProvider, SkillReport, SkillRow, SkillUse } from './tool-audit';

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

/** How the uses came about, each part only when there is one. */
export function originParts(row: SkillRow): string[] {
  return [
    row.typed ? `${row.typed.toLocaleString()} typed by you` : '',
    row.agent ? `${row.agent.toLocaleString()} called by the agent` : '',
    row.detected ? `${row.detected.toLocaleString()} detected in Codex` : '',
    row.subagent ? `${row.subagent.toLocaleString()} in a subagent` : '',
  ].filter(Boolean);
}

export const originWord: Record<SkillUse['origin'], string> = { typed: 'Typed', agent: 'By the agent', detected: 'Detected' };
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
