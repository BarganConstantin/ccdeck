// Where a turn's time went: Claude, this machine, or you.
//
// Asked for from a Mac: "how long is the request to Claude, and how long the local
// tools, so we know whether the machine is the problem or Claude answers slowly".
// The deck heard every turn's two ends and every call's, and kept only the calls —
// with the approval wait inside their time — so neither question had an answer.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { rmTempDir } from './rm-temp-dir';
// @ts-expect-error server module
import { createToolAudit } from '../../server/tool-audit.mjs';
// @ts-expect-error server module
import { auditQuery, sessionQuery } from '../../server/tool-audit-routes.mjs';
// @ts-expect-error server module
import { buildToolAuditReport } from '../../server/tool-audit-report.mjs';
import { donutArcs, glanceTime, laneFact, laneParts, laneShares, slowDays, stopsLine, STARTING } from '../time-split';
import { auditDuration, type TimeSplit } from '../tool-audit';

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

describe('one session\'s turn', () => {
  const ask = (audit: any, session = 'session-secret') => audit.report({ provider: 'claude', days: 7, timeZone: 'UTC', session });

  it('answers a closed turn with the lanes the split gives it', async () => {
    const { audit } = await setup();
    playTurn(audit);
    const { turn } = await ask(audit);
    expect(turn).toEqual({ open: false, totalMs: 100 * SEC, claudeMs: 35 * SEC, machineMs: 35 * SEC, youMs: 30 * SEC });
    // The same numbers Tool activity reads for the same turn.
    const { split } = await audit.report(query);
    expect(turn).toMatchObject({ totalMs: split.totalMs, claudeMs: split.claudeMs, machineMs: split.machineMs, youMs: split.youMs });
  });

  it('answers the turn that is open, timed to now, and counts a question still waiting as yours', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 10, 'PreToolUse', tool('g', 'Bash', { command: 'git status' }));
    at(audit, 12, 'PostToolUse', { ...tool('g', 'Bash'), duration_ms: 2 * SEC });
    at(audit, 20, 'PreToolUse', tool('q', 'AskUserQuestion'));
    clock = T0 + 50 * SEC;
    const { turn } = await ask(audit);
    expect(turn).toEqual({ open: true, totalMs: 50 * SEC, claudeMs: 18 * SEC, machineMs: 2 * SEC, youMs: 30 * SEC });
  });

  it('answers the last turn when a new prompt has not come, and the new one once it has', async () => {
    const { audit } = await setup();
    playTurn(audit);
    expect((await ask(audit)).turn).toMatchObject({ open: false, totalMs: 100 * SEC });
    at(audit, 200, 'UserPromptSubmit', { prompt_id: 'second' });
    clock = T0 + 230 * SEC;
    expect((await ask(audit)).turn).toEqual({ open: true, totalMs: 30 * SEC, claudeMs: 30 * SEC, machineMs: 0, youMs: 0 });
  });

  it('answers null for a session that has no turn, and ignores the others', async () => {
    const { audit } = await setup();
    playTurn(audit);
    expect((await ask(audit, 'nobody')).turn).toBeNull();
    at(audit, 300, 'UserPromptSubmit', { session_id: 'other', prompt_id: 'o1' });
    at(audit, 310, 'Stop', { session_id: 'other', prompt_id: 'o1' });
    expect((await ask(audit)).turn).toMatchObject({ totalMs: 100 * SEC });
    expect((await ask(audit, 'other')).turn).toEqual({ open: false, totalMs: 10 * SEC, claudeMs: 10 * SEC, machineMs: 0, youMs: 0 });
  });

  it('finds the turn whatever the day, and never carries the id into the answer', async () => {
    const { audit } = await setup();
    playTurn(audit);
    clock = T0 + 30 * 86400000;
    const result = await ask(audit);
    expect(result.turn).toMatchObject({ open: false, totalMs: 100 * SEC });
    expect(JSON.stringify(result.turn)).not.toContain('session-secret');
  });

  it('leaves the unfiltered report exactly as it was', async () => {
    const { audit } = await setup();
    playTurn(audit);
    const before = JSON.stringify(await audit.report(query));
    await ask(audit);
    const after = JSON.stringify(await audit.report(query));
    expect(after).toBe(before);
    expect(JSON.parse(after)).not.toHaveProperty('turn');
  });

  it('ends an interrupted turn at its last event, not at now, once nothing came for half an hour', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 10, 'PreToolUse', tool('g', 'Bash', { command: 'ls' }));
    at(audit, 12, 'PostToolUse', { ...tool('g', 'Bash'), duration_ms: 2 * SEC });
    clock = T0 + 12 * SEC + 29 * 60 * SEC;
    expect((await ask(audit)).turn).toMatchObject({ open: true });
    clock = T0 + 12 * SEC + 31 * 60 * SEC;
    expect((await ask(audit)).turn).toEqual({ open: false, totalMs: 12 * SEC, claudeMs: 10 * SEC, machineMs: 2 * SEC, youMs: 0 });
    // Hours later it still reads the same, instead of 0.0s open.
    clock = T0 + 20 * 3600 * SEC;
    expect((await ask(audit)).turn).toEqual({ open: false, totalMs: 12 * SEC, claudeMs: 10 * SEC, machineMs: 2 * SEC, youMs: 0 });
    // The unfiltered report does not change its rule for open turns.
    expect((await audit.report(query)).split).toMatchObject({ turns: 0, open: 1 });
  });

  it('counts a call still running as this machine\'s time, up to now', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 10, 'PreToolUse', tool('b', 'Bash', { command: 'npm test' }));
    clock = T0 + 40 * SEC;
    expect((await ask(audit)).turn).toEqual({ open: true, totalMs: 40 * SEC, claudeMs: 10 * SEC, machineMs: 30 * SEC, youMs: 0 });
    // An Agent call only holds its subagent's calls, so it adds nothing of its own.
    at(audit, 41, 'PreToolUse', tool('t', 'Task'));
    clock = T0 + 50 * SEC;
    expect((await ask(audit)).turn).toMatchObject({ machineMs: 40 * SEC, claudeMs: 10 * SEC });
  });

  it('does not close a turn at a Stop that Claude worked on past', async () => {
    const { audit } = await setup();
    at(audit, 0, 'UserPromptSubmit');
    at(audit, 10, 'Stop');
    expect((await ask(audit)).turn).toMatchObject({ open: false, totalMs: 10 * SEC });
    // A Stop hook sent Claude back to work: the turn runs on.
    at(audit, 12, 'PreToolUse', tool('g', 'Bash', { command: 'ls' }));
    clock = T0 + 20 * SEC;
    expect((await ask(audit)).turn).toEqual({ open: true, totalMs: 20 * SEC, claudeMs: 12 * SEC, machineMs: 8 * SEC, youMs: 0 });
    at(audit, 22, 'PostToolUse', { ...tool('g', 'Bash'), duration_ms: 10 * SEC });
    at(audit, 25, 'Stop', { stop_hook_active: true });
    expect((await ask(audit)).turn).toMatchObject({ open: false, totalMs: 25 * SEC, machineMs: 10 * SEC, claudeMs: 15 * SEC });
  });

  it('never makes the range report busy, nor waits for it', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise(resolve => { release = resolve; });
    const dir = await mkdtemp(join(tmpdir(), 'ccdeck-time-split-')); dirs.push(dir);
    const real = (input: any) => buildToolAuditReport(input, { createReadStream, createInterface });
    const audit = createToolAudit({ dir, now: () => clock, runReport: async (input: any) => { if (!input.query.turnId) await gate; return real(input); } });
    audits.push(audit); await audit.start();
    at(audit, 0, 'UserPromptSubmit'); at(audit, 5, 'Stop');
    const range = audit.report(query);
    expect(await audit.report(query)).toEqual({ ok: false, reason: 'busy' });
    // The session's read goes through while the range report is in flight.
    expect((await ask(audit)).turn).toMatchObject({ open: false, totalMs: 5 * SEC });
    release(null);
    expect((await range).ok).toBe(true);
    expect((await ask(audit)).ok).toBe(true);
  });

  it('hands the worker only the journal files that can hold the turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccdeck-time-split-')); dirs.push(dir);
    const real = (input: any) => buildToolAuditReport(input, { createReadStream, createInterface });
    const seen: string[][] = [];
    const audit = createToolAudit({ dir, now: () => clock, runReport: async (input: any) => { seen.push(input.files.map((f: any) => basename(f.path))); return real(input); } });
    audits.push(audit); await audit.start();
    for (let day = 0; day < 4; day++) {
      clock = T0 + day * 86400000;
      audit.observe(hook('UserPromptSubmit', { session_id: 'old' + day, prompt_id: 'p' }), 'hook', { receivedAt: clock });
      audit.observe(hook('Stop', { session_id: 'old' + day, prompt_id: 'p' }), 'hook', { receivedAt: clock + 1000 });
      await audit.status();
    }
    clock = T0 + 3 * 86400000 + 60000;
    audit.observe(hook('UserPromptSubmit', { session_id: 'newest', prompt_id: 'n' }), 'hook', { receivedAt: clock });
    await audit.report(query);
    await ask(audit, 'newest');
    expect(seen[0]).toHaveLength(4);
    expect(seen[1]).toEqual(['2026-10-23.jsonl']);
  });

  it('finds the turn again after a restart, from the prompt the boot replay heard', async () => {
    const { audit, dir } = await setup();
    playTurn(audit);
    await audit.close();
    const again = createToolAudit({ dir, now: () => clock }); audits.push(again); await again.start();
    expect((await ask(again)).turn).toBeNull();
    again.observe(hook('UserPromptSubmit'), 'hook', { replay: true, receivedAt: T0 });
    expect((await ask(again)).turn).toMatchObject({ open: false, totalMs: 100 * SEC, youMs: 30 * SEC });
    // Replay writes nothing.
    await again.close();
    const journal = (await readdir(dir)).filter(name => name.endsWith('.jsonl'));
    expect(journal).toHaveLength(1);
    expect((await readFile(join(dir, journal[0]), 'utf8')).split('\n').filter(Boolean)).toHaveLength(10);
  });

  it('takes only a session, shaped like one', () => {
    expect(sessionQuery(new URLSearchParams('session=5b1c1c0e-71d9-4c7e-9a62-0f6ac3c2d111'))).toMatchObject({ provider: 'claude', session: '5b1c1c0e-71d9-4c7e-9a62-0f6ac3c2d111' });
    for (const bad of ['session=', 'session=a%20b', 'session=a<b', `session=${'a'.repeat(257)}`, 'session=a&session=b', 'session=a&days=7', 'session=a&provider=claude'])
      expect(sessionQuery(new URLSearchParams(bad))).toBeNull();
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

  it('draws each lane its share of the ring, less one gap, from the top', () => {
    const arcs = donutArcs(laneShares(split()));
    expect(arcs.map(a => a.id)).toEqual(['claude', 'machine', 'you']);
    expect(arcs.map(a => +a.length.toFixed(2))).toEqual([49.2, 39.2, 9.2]);
    expect(arcs.map(a => +a.from.toFixed(2))).toEqual([0.4, 50.4, 90.4]);
    // Every arc ends a gap before the next begins.
    for (const [a, b] of arcs.slice(0, -1).map((a, i) => [a, arcs[i + 1]])) expect(+(b.from - (a.from + a.length)).toFixed(2)).toBe(0.8);
    // One lane closes the ring; a sliver stays visible.
    expect(donutArcs(laneShares(split({ totalMs: 5000, claudeMs: 5000, machineMs: 0, youMs: 0 })))).toEqual([{ id: 'claude', from: 0, length: 100 }]);
    expect(donutArcs(laneShares(split({ totalMs: 100_000, claudeMs: 99_900, machineMs: 100, youMs: 0 })))[1].length).toBe(0.3);
  });

  it('says in one line what each lane mostly was', () => {
    const s = split({ machine: [{ operation: 'npm test', ms: 30_000 }], you: [{ operation: 'git push', ms: 9000 }],
      replies: { count: 5, medianMs: 2900, p90Ms: null, maxMs: 9000, days: [] } });
    expect(laneFact(s, 'claude')).toBe('Usually answers in 2.9 s');
    expect(laneFact(s, 'machine')).toBe('Mostly npm test');
    expect(laneFact(s, 'you')).toBe('Mostly approving git push');
    expect(laneFact(split({ you: [{ operation: 'AskUserQuestion', ms: 1 }] }), 'you')).toBe('Mostly answering questions');
    expect(laneFact(split({ machine: [{ operation: STARTING, ms: 1 }] }), 'machine')).toBe('Mostly starting tools');
    expect(laneFact(split(), 'machine')).toBe('Tools and the hooks that start them');
  });

  it('rounds the ring\'s times to whole hours from an hour up', () => {
    expect(glanceTime(35.5 * 3600000)).toBe('36 h');
    expect(glanceTime(1250 * 3600000)).toBe('1,250 h');
    expect(glanceTime(42 * 60000)).toBe(auditDuration(42 * 60000));
  });

  it('says how turns died, most first, and nothing when none did', () => {
    expect(stopsLine({ server_error: 1, overloaded: 2 })).toBe('3 turns ended on an error: Claude overloaded 2, server error 1.');
    expect(stopsLine({ invalid_request: 1 })).toBe('1 turn ended on an error: invalid request 1.');
    expect(stopsLine({})).toBeNull();
  });
});
