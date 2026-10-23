// Where a turn's time went: Claude, this machine, or you.
//
// Asked for from a Mac: "how long is the request to Claude, and how long the local
// tools, so we know whether the machine is the problem or Claude answers slowly".
// The deck heard every turn's two ends and every call's, and kept only the calls —
// with the approval wait inside their time — so neither question had an answer.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmTempDir } from './rm-temp-dir';
// @ts-expect-error server module
import { createToolAudit } from '../../server/tool-audit.mjs';
// @ts-expect-error server module
import { auditQuery } from '../../server/tool-audit-routes.mjs';
import { laneParts, laneShares, slowDays, stopsLine, STARTING } from '../time-split';
import type { TimeSplit } from '../tool-audit';

const dirs: string[] = []; const audits: any[] = [];
const T0 = Date.parse('2026-10-20T10:00:00Z');
let clock = T0;
afterEach(async () => { for (const a of audits.splice(0)) await a.close(); for (const d of dirs.splice(0)) await rmTempDir(d); clock = T0; });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ccdeck-time-split-')); dirs.push(dir);
  const audit = createToolAudit({ dir, now: () => clock }); audits.push(audit); await audit.start(); return { audit, dir };
}
const SEC = 1000;
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ session_id: 'session-secret', prompt_id: 'prompt-secret', hook_event_name: name, provider: 'claude', ...extra });
/** One hook, heard `s` seconds into the turn. */
const at = (audit: any, s: number, name: string, extra: Record<string, unknown> = {}) => {
  clock = T0 + s * SEC + 1;
  audit.observe(hook(name, extra), 'hook', { receivedAt: T0 + s * SEC });
};
const tool = (id: string, tool_name: string, tool_input: Record<string, unknown> = {}) => ({ tool_use_id: id, tool_name, tool_input });
const query = { provider: 'all', days: 7, timeZone: 'UTC' };

/** The turn worked out by hand in the describe below. */
function playTurn(audit: any) {
  at(audit, 0, 'UserPromptSubmit', { prompt: 'never kept' });
  // npm test: hooks take 5 s to start it, then it runs 25 s.
  at(audit, 10, 'PreToolUse', tool('a', 'Bash', { command: 'npm test' }));
  // A subagent reads beside it for 10 s.
  at(audit, 20, 'PreToolUse', { ...tool('b', 'Read', { file_path: '/x' }), agent_id: 'sub1' });
  at(audit, 30, 'PostToolUse', { ...tool('b', 'Read'), agent_id: 'sub1', duration_ms: 10 * SEC });
  at(audit, 40, 'PostToolUse', { ...tool('a', 'Bash'), duration_ms: 25 * SEC });
  // Claude asks a question; you answer after 20 s.
  at(audit, 50, 'PreToolUse', tool('q', 'AskUserQuestion'));
  at(audit, 70, 'PostToolUse', { ...tool('q', 'AskUserQuestion'), duration_ms: 0 });
  // git push asks for approval: 10 s to approve, 5 s to run.
  at(audit, 75, 'PreToolUse', tool('p', 'Bash', { command: 'git push' }));
  at(audit, 76, 'Notification', { notification_type: 'permission_prompt', message: 'needs approval' });
  at(audit, 90, 'PostToolUse', { ...tool('p', 'Bash'), duration_ms: 5 * SEC });
  at(audit, 100, 'Stop');
}

describe('what the journal keeps of a turn', () => {
  it('files each call under its turn, by a digest, and keeps neither the prompt nor its ids', async () => {
    const { audit, dir } = await setup();
    playTurn(audit);
    await audit.status();
    const text = (await Promise.all((await readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => readFile(join(dir, f), 'utf8')))).join('');
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    const begin = rows.find(r => r.kind === 'turn'), end = rows.find(r => r.kind === 'turn-end');
    expect(begin).toBeTruthy(); expect(end.stop).toBe('done');
    expect(end.id).toBe(begin.id);
    const starts = rows.filter(r => r.kind === 'start');
    expect(starts).toHaveLength(4);
    for (const s of starts) expect(s.turn).toBe(begin.id);
    const ends = rows.filter(r => r.kind === 'end');
    expect(ends.map(r => r.ms).sort((x, y) => x - y)).toEqual([0, 5000, 10000, 25000]);
    expect(ends.filter(r => r.asked)).toHaveLength(1);
    for (const secret of ['session-secret', 'prompt-secret', 'never kept', 'needs approval', 'sub1']) expect(text).not.toContain(secret);
  });
});

describe('the split of a turn', () => {
  it('gives each second to Claude, this machine or you, once', async () => {
    const { audit } = await setup();
    playTurn(audit);
    const { split } = await audit.report(query);
    // Claude: 0-10, 40-50, 70-75 and 90-100. This machine: 10-40 and 85-90. You: 50-70 and 75-85.
    expect(split).toMatchObject({ turns: 1, open: 0, totalMs: 100 * SEC, claudeMs: 35 * SEC, machineMs: 35 * SEC, youMs: 30 * SEC });
    expect(split.claudeMs + split.machineMs + split.youMs).toBe(split.totalMs);
  });

  it('shares the time two calls ran together, so the machine\'s parts add up to it', async () => {
    const { audit } = await setup();
    playTurn(audit);
    const { split } = await audit.report(query);
    expect(split.machine).toEqual([
      { operation: 'npm test', ms: 20 * SEC },
      { operation: '(starting tools)', ms: 5 * SEC },
      { operation: 'git push', ms: 5 * SEC },
      { operation: 'Read', ms: 5 * SEC },
    ]);
    expect(split.machine.reduce((n: number, p: { ms: number }) => n + p.ms, 0)).toBe(split.machineMs);
    expect(split.you).toEqual([{ operation: 'AskUserQuestion', ms: 20 * SEC }, { operation: 'git push', ms: 10 * SEC }]);
  });

  it('measures Claude\'s replies as the stretches with nothing running', async () => {
    const { audit } = await setup();
    playTurn(audit);
    const { split } = await audit.report(query);
    expect(split.replies).toMatchObject({ count: 4, medianMs: 10 * SEC, maxMs: 10 * SEC });
    expect(split.replies.days.find((d: { date: string }) => d.date === '2026-10-20')).toEqual({ date: '2026-10-20', count: 4, medianMs: 10 * SEC });
  });

  it('counts an Agent call by the calls its subagent made, not by its own span', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 1, 'PreToolUse', tool('agent', 'Agent', { prompt: 'x' }));
    at(audit, 11, 'PreToolUse', { ...tool('r', 'Read'), agent_id: 's' });
    at(audit, 12, 'PostToolUse', { ...tool('r', 'Read'), agent_id: 's', duration_ms: 1 * SEC });
    at(audit, 30, 'PostToolUse', { ...tool('agent', 'Agent'), duration_ms: 29 * SEC });
    at(audit, 40, 'Stop');
    const { split } = await audit.report(query);
    expect(split).toMatchObject({ totalMs: 40 * SEC, machineMs: 1 * SEC, youMs: 0, claudeMs: 39 * SEC });
  });

  it('counts the hooks before a call as this machine when nobody was asked', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 1, 'PreToolUse', tool('g', 'Bash', { command: 'git status' }));
    at(audit, 3, 'PostToolUse', { ...tool('g', 'Bash'), duration_ms: 500 });
    at(audit, 4, 'Stop');
    const { split } = await audit.report(query);
    expect(split.machine).toEqual([{ operation: '(starting tools)', ms: 1500 }, { operation: 'git status', ms: 500 }]);
    expect(split.youMs).toBe(0);
  });

  it('gives a pipeline\'s time to the command feeding it, not to tail or cd', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 1, 'PreToolUse', tool('t', 'Bash', { command: 'cd /x && npm test 2>&1 | tail -5' }));
    at(audit, 9, 'PostToolUse', { ...tool('t', 'Bash'), duration_ms: 8 * SEC });
    at(audit, 10, 'Stop');
    const { split, rows } = await audit.report(query);
    expect(split.machine).toEqual([{ operation: 'npm test', ms: 8 * SEC }]);
    // The list still finds the call under each of its commands.
    expect(rows.map((row: { operation: string }) => row.operation).sort()).toEqual(['cd', 'npm test', 'tail']);
  });

  it('falls back to a call\'s whole span from a Claude Code that sends no duration', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 2, 'PreToolUse', tool('g', 'Bash', { command: 'git status' }));
    at(audit, 6, 'PostToolUse', tool('g', 'Bash'));
    at(audit, 10, 'Stop');
    const { split } = await audit.report(query);
    expect(split).toMatchObject({ machineMs: 4 * SEC, claudeMs: 6 * SEC, youMs: 0 });
  });
});

describe('a turn\'s ends', () => {
  it('ends at the last Stop when a Stop hook sent Claude back to work', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 10, 'Stop');
    at(audit, 25, 'Stop', { stop_hook_active: true });
    const { split } = await audit.report(query);
    expect(split).toMatchObject({ turns: 1, totalMs: 25 * SEC, claudeMs: 25 * SEC });
  });

  it('counts how turns that died on an API error died', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 9, 'StopFailure', { error: 'overloaded' });
    at(audit, 20, 'UserPromptSubmit', { prompt_id: 'second' });
    at(audit, 21, 'StopFailure', { prompt_id: 'second', error: 'not a value </b>' });
    const { split } = await audit.report(query);
    expect(split.stops).toEqual({ overloaded: 1, unknown: 1 });
  });

  it('leaves a turn that has not ended out of the split, and says it is open', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 1, 'PreToolUse', tool('g', 'Bash', { command: 'git status' }));
    const { split } = await audit.report(query);
    expect(split).toMatchObject({ turns: 0, open: 1, totalMs: 0 });
  });

  it('has no split for Codex, whose rollouts name no prompt', async () => {
    const { audit } = await setup();
    playTurn(audit);
    expect((await audit.report({ ...query, provider: 'codex' })).split).toBeNull();
    expect((await audit.report({ ...query, provider: 'claude' })).split.turns).toBe(1);
  });

  it('keeps the tool list and its counts as they were', async () => {
    const { audit } = await setup();
    playTurn(audit);
    const r = await audit.report(query);
    expect(r).toMatchObject({ total: 4, measured: 4, orphaned: 0, corrupt: 0 });
  });
});

describe('the report\'s query', () => {
  it('carries the reader\'s time zone, so the days are theirs', () => {
    expect(auditQuery(new URLSearchParams('days=7&timeZone=Europe/Chisinau'))).toMatchObject({ days: 7, timeZone: 'Europe/Chisinau' });
    expect(auditQuery(new URLSearchParams('days=7'))).toMatchObject({ timeZone: 'UTC' });
  });
});

describe('what the bar and its levels read', () => {
  const split = (over: Partial<TimeSplit> = {}): TimeSplit => ({ turns: 3, open: 0, totalMs: 100_000, claudeMs: 50_000, machineMs: 40_000, youMs: 10_000,
    machine: [], you: [], stops: {}, replies: { count: 0, medianMs: null, p90Ms: null, maxMs: null, days: [] }, ...over });

  it('keeps the lanes in one order, and leaves out a "you" nobody waited on', () => {
    expect(laneShares(split()).map(l => [l.id, l.share])).toEqual([['claude', '50%'], ['machine', '40%'], ['you', '10%']]);
    expect(laneShares(split({ claudeMs: 60_000, youMs: 0 })).map(l => l.id)).toEqual(['claude', 'machine']);
  });

  it('shows the longest parts, then opens the rest, then names what the report left out', () => {
    const machine = Array.from({ length: 9 }, (_, i) => ({ operation: `op${i}`, ms: 4000 - i * 100 }));
    const s = split({ machine, machineMs: 40_000 });
    const short = laneParts(s, 'machine');
    expect(short.map(r => r.label)).toEqual(['op0', 'op1', 'op2', 'op3', 'op4', 'op5', '3 more']);
    expect(short.at(-1)).toMatchObject({ more: true, inTable: false, ms: 40_000 - machine.slice(0, 6).reduce((n, p) => n + p.ms, 0) });
    const all = laneParts(s, 'machine', Infinity);
    expect(all.map(r => r.label).slice(-2)).toEqual(['op8', 'Everything else']);
    expect(all.at(-1)).toMatchObject({ ms: 40_000 - machine.reduce((n, p) => n + p.ms, 0) });
    expect(all.at(-1)!.more).toBeUndefined();
    // One more row than the limit is shown rather than folded into "1 more".
    const seven = machine.slice(0, 7);
    expect(laneParts(split({ machine: seven, machineMs: seven.reduce((n, p) => n + p.ms, 0) }), 'machine').map(r => r.label)).toEqual(seven.map(p => p.operation));
  });

  it('names the parts that are not commands, and keeps them out of the list', () => {
    expect(laneParts(split({ machine: [{ operation: STARTING, ms: 2000 }], machineMs: 2000 }), 'machine')).toMatchObject([{ label: 'Starting tools', inTable: false }]);
    const you = laneParts(split({ you: [{ operation: 'AskUserQuestion', ms: 6000 }, { operation: 'git push', ms: 4000 }] }), 'you');
    expect(you).toMatchObject([{ label: 'Answering Claude’s questions', inTable: true, share: '60%' }, { label: 'git push', detail: 'Waiting for your approval', inTable: true }]);
  });

  it('calls a day slow only when enough replies were half as slow again as usual', () => {
    const days = [{ date: '2026-10-20', count: 40, medianMs: 3000 }, { date: '2026-10-21', count: 30, medianMs: 6000 }, { date: '2026-10-22', count: 2, medianMs: 9000 }];
    expect(slowDays(split({ replies: { count: 72, medianMs: 3500, p90Ms: 9000, maxMs: 20_000, days } })).map(d => d.date)).toEqual(['2026-10-21']);
    expect(slowDays(split())).toEqual([]);
  });

  it('says how turns died, most first, and nothing when none did', () => {
    expect(stopsLine({ server_error: 1, overloaded: 2 })).toBe('3 turns ended on an error: Claude overloaded 2, server error 1.');
    expect(stopsLine({ invalid_request: 1 })).toBe('1 turn ended on an error: invalid request 1.');
    expect(stopsLine({})).toBeNull();
  });
});
