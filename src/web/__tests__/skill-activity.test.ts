import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmTempDir } from './rm-temp-dir';
// @ts-expect-error server module
import { createToolAudit } from '../../server/tool-audit.mjs';
// @ts-expect-error server module
import { auditQuery } from '../../server/tool-audit-routes.mjs';
// @ts-expect-error server module
import { codexSkillState, codexSkillUses, noteCodexSkills, parseSkillCatalog } from '../../server/codex-skills.mjs';

const dirs: string[] = []; const audits: any[] = [];
const START = Date.parse('2026-10-13T10:00:00Z');
let clock = START;
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ccdeck-skill-activity-')); dirs.push(dir);
  const audit = createToolAudit({ dir, now: () => clock }); audits.push(audit); await audit.start(); return { audit, dir };
}
afterEach(async () => { for (const a of audits.splice(0)) await a.close(); for (const d of dirs.splice(0)) await rmTempDir(d); clock = START; });

const skillCall = (id: string, skill: string, extra = {}) => ({ session_id: 'session1', cwd: '/home/me/work/billing', tool_use_id: id,
  hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill, args: 'private brief' }, ...extra });
const ended = (id: string, failed = false) => ({ session_id: 'session1', tool_use_id: id, hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', tool_name: 'Skill' });
const typed = (name: string, args = '', extra = {}) => ({ session_id: 'session1', cwd: '/home/me/work/billing', hook_event_name: 'UserPromptExpansion',
  expansion_type: 'slash_command', command_name: name, command_args: args, command_source: 'userSettings', prompt: `/${name} ${args}`, ...extra });
const skills = (audit: any, extra = {}) => audit.report({ view: 'skills', provider: 'all', days: 90, ...extra });

describe('Skill activity collection', () => {
  it('counts a Skill call by name, keeps its outcome, and leaves the Tools report as it was', async () => {
    const { audit } = await setup();
    audit.observe(skillCall('a', 'matt-pr'), 'hook'); audit.observe(ended('a'), 'hook');
    audit.observe(skillCall('b', 'matt-pr'), 'hook'); audit.observe(ended('b', true), 'hook');
    audit.observe(skillCall('c', '/impeccable'), 'hook');
    audit.observe(typed('impeccable', 'polish'), 'hook', { receivedAt: clock });
    const r = await skills(audit);
    expect(r.rows.map((row: any) => [row.name, row.uses, row.failed])).toEqual([['impeccable', 2, 0], ['matt-pr', 2, 1]]);
    expect(r.total).toBe(4); expect(r.failed).toBe(1); expect(r.corrupt).toBe(0);
    const impeccable = r.rows.find((row: any) => row.name === 'impeccable');
    expect([impeccable.typed, impeccable.agent, impeccable.detected]).toEqual([1, 1, 0]);
    const tools = await audit.report({ provider: 'all', days: 90 });
    expect(tools.rows.map((row: any) => [row.operation, row.calls])).toEqual([['Skill', 3]]);
    expect(tools.corrupt).toBe(0); expect(tools.orphaned).toBe(0);
  });
  it('keeps the skill, session and project folder, never arguments or paths', async () => {
    const { audit, dir } = await setup();
    audit.observe(skillCall('a', 'matt-pr'), 'hook'); audit.observe(typed('loop', 'private brief'), 'hook');
    await audit.status();
    const data = (await Promise.all((await readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => readFile(join(dir, f), 'utf8')))).join('');
    expect(data).toContain('"skill":"matt-pr"'); expect(data).toContain('"session":"session1"'); expect(data).toContain('"project":"billing"');
    expect(data).not.toContain('private brief'); expect(data).not.toContain('/home/me'); expect(data).not.toContain('userSettings');
  });
  it('counts the same command run again with the same arguments as a repeat, not a use', async () => {
    const { audit } = await setup();
    audit.observe(typed('loop', 'check CI'), 'hook', { receivedAt: clock });
    for (let i = 1; i <= 3; i++) { clock += 60000; audit.observe(typed('loop', 'check CI', { prompt_id: `p${i}` }), 'hook', { receivedAt: clock }); }
    clock += 60000; audit.observe(typed('loop', 'something else', { prompt_id: 'p9' }), 'hook', { receivedAt: clock });
    audit.observe(typed('loop', 'check CI', { session_id: 'session2', prompt_id: 'p10' }), 'hook', { receivedAt: clock });
    const r = await skills(audit, { skill: 'loop' });
    expect(r.rows[0]).toMatchObject({ name: 'loop', uses: 3, repeats: 3, sessions: 2 });
    expect(r.repeats).toBe(3); expect(r.details.total).toBe(3); expect(r.details.recent).toHaveLength(3);
  });
  it('ignores MCP prompts, replays, other sources and names that are not a skill', async () => {
    const { audit } = await setup();
    audit.observe(typed('mcp__github__review', '', { expansion_type: 'mcp_prompt' }), 'hook');
    audit.observe(typed('loop'), 'hook', { replay: true });
    audit.observe(typed('loop'), 'peer');
    audit.observe(typed('two words'), 'hook');
    audit.observe(skillCall('x', '<script>'), 'hook');
    audit.observe(skillCall('y', 'loop', { provider: 'codex' }), 'codex');
    expect((await skills(audit)).total).toBe(0);
  });
  it('attributes a subagent’s skill to its session and marks it', async () => {
    const { audit } = await setup();
    audit.observe(skillCall('a', 'dataviz', { agent_id: 'agent-7' }), 'hook');
    const r = await skills(audit, { skill: 'dataviz' });
    expect(r.rows[0]).toMatchObject({ uses: 1, agent: 1, subagent: 1 });
    expect(r.details.recent[0]).toMatchObject({ session: 'session1', project: 'billing', subagent: true, origin: 'agent', provider: 'claude' });
  });
  it('merges one name across agents, filters by agent and period, and lands a forked Codex copy on the same row', async () => {
    const { audit } = await setup();
    audit.observe(skillCall('a', 'impeccable'), 'hook', { receivedAt: clock });
    audit.observeSkill({ key: 'turn1|impeccable', name: 'impeccable', origin: 'detected', session: 'codex1', cwd: '/home/me/site', subagent: false, at: clock });
    audit.observeSkill({ key: 'turn1|impeccable', name: 'impeccable', origin: 'detected', session: 'fork1', cwd: '/home/me/site', subagent: true, at: clock });
    audit.observeSkill({ key: 'turn2|impeccable', name: 'impeccable', origin: 'typed', session: 'codex1', cwd: '/home/me/site', subagent: false, at: clock - 3 * 86400000 });
    const all = await skills(audit);
    expect(all.rows[0]).toMatchObject({ name: 'impeccable', uses: 3, providers: { claude: 1, codex: 2 }, typed: 1, detected: 1, agent: 1 });
    expect(all.duplicates).toBe(1);
    expect((await skills(audit, { provider: 'codex' })).total).toBe(2);
    expect((await skills(audit, { provider: 'claude', days: 1 })).total).toBe(1);
    expect((await skills(audit, { provider: 'codex', days: 1 })).total).toBe(1);
  });
  it('details a skill: its projects, latest uses and days before counting began', async () => {
    const { audit } = await setup();
    for (const [i, cwd] of ['/w/billing', '/w/billing', '/w/site'].entries()) audit.observe(skillCall(`c${i}`, 'matt-pr', { cwd }), 'hook', { receivedAt: clock - 3 + i });
    const r = await skills(audit, { skill: 'matt-pr', history: true, timeZone: 'UTC', days: 7 });
    expect(r.details.projects).toEqual([{ name: 'billing', uses: 2 }, { name: 'site', uses: 1 }]);
    expect(r.details.recent.map((use: any) => use.project)).toEqual(['site', 'billing', 'billing']);
    const days = r.details.history.days;
    expect(days.at(-1)).toMatchObject({ date: '2026-10-13', uses: 3, status: 'used' });
    expect(days[0].status).toBe('outside-history');
    expect(r.countedSince).toBe(START);
  });
  it('starts counting skills when an older journal first meets this build, and again after Clear', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccdeck-skill-activity-')); dirs.push(dir);
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ v: 1, deviceId: '11111111-1111-4111-8111-111111111111', epoch: '22222222-2222-4222-8222-222222222222', retentionDays: 90, startedAt: START - 86400000 }));
    const audit = createToolAudit({ dir, now: () => clock }); audits.push(audit); await audit.start();
    expect((await skills(audit)).countedSince).toBe(START);
    clock += 1000; await audit.clear();
    expect((await skills(audit)).countedSince).toBe(START + 1000);
  });
});

describe('Skill activity query', () => {
  it('takes a skill only with the skills view, and history needs one', () => {
    expect(auditQuery(new URLSearchParams('view=skills&skill=anthropic-skills:docx&history=1&timeZone=UTC'))).toMatchObject({ view: 'skills', skill: 'anthropic-skills:docx', history: true });
    expect(auditQuery(new URLSearchParams('view=skills'))).toMatchObject({ view: 'skills', provider: 'all', days: 7 });
    for (const q of ['view=skills&operation=Read', 'skill=loop', 'view=skills&history=1', 'view=other', 'view=skills&skill=two%20words', `view=skills&skill=${'x'.repeat(151)}`]) {
      expect(auditQuery(new URLSearchParams(q)), q).toBeNull();
    }
    expect(auditQuery(new URLSearchParams('operation=Read'))).toMatchObject({ operation: 'Read' });
  });
});

const catalog = [
  '<skills_instructions>', '## Skills', '### Skill roots',
  '- `r0` = `/home/me/.agents/skills`', '- `r1` = `/home/me/.codex/plugins/cache/openai-bundled`',
  '### Available skills',
  '- impeccable: Design work (polish, audit). (file: r0/impeccable/SKILL.md)',
  '- visualize:visualize: Charts: anything. (file: r1/visualize/1.0.39/skills/visualize/SKILL.md)',
  '</skills_instructions>',
].join('\n');
const developer = { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: catalog }] } };
const turn = (id: string) => ({ type: 'event_msg', timestamp: '2026-10-13T10:00:00.000Z', payload: { type: 'task_started', turn_id: id } });
const injected = (name: string) => ({ type: 'response_item', timestamp: '2026-10-13T10:00:01.000Z', payload: { type: 'message', role: 'user',
  content: [{ type: 'input_text', text: `<skill>\n<name>${name}</name>\n<path>/home/me/.agents/skills/${name}/SKILL.md</path>\nbody\n</skill>` }] } });
const command = (turnId: string, parsed: unknown[], exit = 0) => ({ type: 'event_msg', timestamp: '2026-10-13T10:00:02.000Z', payload: { type: 'item_completed', turn_id: turnId,
  item: { type: 'CommandExecution', command: ['/bin/bash', '-lc', 'x'], cwd: 'file:///home/me/.agents/skills/impeccable', parsed_cmd: parsed, exit_code: exit } } });
const read = (path: string) => ({ type: 'read', cmd: `cat ${path}`, name: 'SKILL.md', path });

describe('Codex skill detection', () => {
  it('reads a catalog: roots, names with a namespace, and descriptions with brackets', () => {
    const parsed = parseSkillCatalog(catalog);
    expect([...parsed.files]).toEqual([['/home/me/.agents/skills/impeccable/SKILL.md', 'impeccable'], ['/home/me/.codex/plugins/cache/openai-bundled/visualize/1.0.39/skills/visualize/SKILL.md', 'visualize:visualize']]);
    expect(parseSkillCatalog('no catalog here')).toBeNull();
  });
  it('counts an injected skill and a read or script run of a catalog skill, once per turn and skill', () => {
    const skills = codexSkillState(); const uses = (obj: unknown) => codexSkillUses(obj, skills);
    expect(uses(developer)).toEqual([]); expect(uses(turn('t1'))).toEqual([]);
    expect(uses(injected('impeccable'))).toMatchObject([{ key: 't1|impeccable', name: 'impeccable', origin: 'typed' }]);
    expect(uses(command('t1', [read('/home/me/.agents/skills/impeccable/SKILL.md')]))).toEqual([]);
    expect(uses(command('t1', [read('SKILL.md')]))).toEqual([]);
    expect(uses(turn('t2'))).toEqual([]);
    expect(uses(command('t2', [read('SKILL.md')]))).toMatchObject([{ key: 't2|impeccable', origin: 'detected' }]);
    expect(uses(command('t3', [{ type: 'unknown', cmd: 'python3 /home/me/.codex/plugins/cache/openai-bundled/visualize/1.0.39/skills/visualize/scripts/chart.py' }])))
      .toMatchObject([{ key: 't3|visualize:visualize', name: 'visualize:visualize', origin: 'detected' }]);
  });
  it('does not count failed reads, searches, or a SKILL.md outside the catalog', () => {
    const skills = codexSkillState(); const uses = (obj: unknown) => codexSkillUses(obj, skills);
    uses(developer);
    expect(uses(command('t1', [read('/home/me/.agents/skills/impeccable/SKILL.md')], 1))).toEqual([]);
    expect(uses(command('t1', [{ type: 'search', cmd: 'rg -g SKILL.md impeccable', query: 'impeccable' }]))).toEqual([]);
    expect(uses(command('t1', [read('/home/me/.claude/skills/impeccable/SKILL.md')]))).toEqual([]);
    expect(uses(command('t1', [{ type: 'list_files', cmd: 'ls /home/me/.agents/skills/impeccable/scripts/' }]))).toEqual([]);
  });
  it('reads the catalog off the rollout’s head for a session it joined late', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccdeck-skill-activity-')); dirs.push(dir);
    const path = join(dir, 'rollout.jsonl');
    await writeFile(path, [{ type: 'session_meta', payload: { id: 'codex1' } }, developer].map(line => JSON.stringify(line)).join('\n') + '\n');
    const noted: any[] = [];
    const state = { sid: 'codex1', cwd: '/home/me/site', link: { parent_session_id: 'parent1' }, path };
    noteCodexSkills(command('t1', [read('/home/me/.agents/skills/impeccable/SKILL.md')]), state, (use: unknown) => noted.push(use));
    expect(noted).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(noted).toMatchObject([{ key: 't1|impeccable', name: 'impeccable', origin: 'detected', session: 'parent1', subagent: true, cwd: '/home/me/site' }]);
  });
});
