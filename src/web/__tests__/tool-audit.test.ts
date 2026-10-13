import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmTempDir } from './rm-temp-dir';
// @ts-expect-error server module
import { createToolAudit } from '../../server/tool-audit.mjs';
// @ts-expect-error server module
import { auditOperations, shellOperations, scriptOperations } from '../../server/tool-audit-operations.mjs';
// @ts-expect-error server module
import { auditQuery } from '../../server/tool-audit-routes.mjs';
import { auditDuration, sortAuditRows, type AuditRow } from '../tool-audit';
const dirs: string[] = []; const audits: any[] = [];
let clock = Date.parse('2026-10-13T10:00:00Z');
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ccdeck-tool-audit-')); dirs.push(dir);
  const audit = createToolAudit({ dir, now: () => clock }); audits.push(audit); await audit.start(); return { audit, dir };
}
const event = (name: string, id = 'call1', extra = {}) => ({ session_id: 'session1', tool_use_id: id,
  hook_event_name: name, tool_name: 'Bash', tool_input: { command: 'git commit -m "private message"' }, ...extra });
const query = { provider: 'all', days: 90 };
afterEach(async () => { for (const a of audits.splice(0)) await a.close(); for (const d of dirs.splice(0)) await rmTempDir(d); clock = Date.parse('2026-10-13T10:00:00Z'); });

describe('concrete operation classification', () => {
  it('groups variable arguments but distinguishes concrete operations', () => {
    expect(shellOperations('git -C /private/repo -c user.name=private commit -m "secret"')).toEqual(['git commit']);
    expect(shellOperations('git status --short && git commit -m "another"; git push')).toEqual(['git status', 'git commit', 'git push']);
    expect(shellOperations('npm run build -- --watch')).toEqual(['npm run build']);
    expect(shellOperations('dotnet test /private/file.csproj')).toEqual(['dotnet test']);
    expect(auditOperations('Read', { file_path: '/private/file' }).operations).toEqual(['Read']);
  });
  it('handles wrappers and quotes without interpreting dynamic shell expressions', () => {
    expect(shellOperations('env TOKEN=secret bash -lc \'git status && git commit -m "a;b"\'')).toEqual(['git status', 'git commit']);
    expect(shellOperations('git status; git status')).toEqual(['git status']);
    expect(shellOperations('$(cat /private/file) --arg')).toEqual(['shell (unclassified)']);
    expect(shellOperations('for x in *; do git status; done')).toEqual(['shell (unclassified)']);
    expect(shellOperations('bash -lc "unterminated')).toEqual(['shell (unclassified)']);
  });
});
describe('Codex orchestration wrappers', () => {
  it('extracts literal concrete commands and other tools without executing code', () => {
    expect(scriptOperations('text(await tools.exec_command({cmd:"git status && git commit -m \\"private\\"",workdir:"/repo"}));')).toEqual(['git status', 'git commit']);
    expect(scriptOperations('await tools.exec_command({cmd:dynamic}); await tools.web__run({});')).toEqual(['shell (unclassified)', 'web__run']);
    expect(scriptOperations('const example="tools.exec_command({cmd:fake})"; // tools.bad({})\n await tools.exec_command({cmd:"git push"});')).toEqual(['git push']);
    expect(auditOperations('exec', { script: 'text(await tools.exec_command({cmd:"git status"}));' }).operations).toEqual(['git status']);
  });
});
describe('persistent device-wide tool audit' , () => {
  it('pairs and deduplicates observed calls, including failures and measured zero', async () => {
    const { audit, dir } = await setup();
    for (let i = 0; i < 20; i++) {
      const t = clock; audit.observe(event('PreToolUse', `c${i}`), 'hook', { receivedAt: t });
      audit.observe(event('PreToolUse', `c${i}`), 'hook', { receivedAt: t });
      audit.observe(event(i === 0 ? 'PostToolUseFailure' : 'PostToolUse', `c${i}`), 'hook', { receivedAt: t + i * 1000 });
      clock += 60000;
    }
    const r = await audit.report(query), g = r.rows[0];
    expect(r.total).toBe(20); expect(r.measured).toBe(20); expect(g.operation).toBe('git commit');
    expect(g.medianMs).toBe(9500); expect(g.maxMs).toBe(19000); expect(g.p95Ms).toBe(18000); expect(g.failed).toBe(1);
    expect(g.totalMs).toBe(190000); expect(r.duplicates).toBe(20);
    const data = (await Promise.all((await readdir(dir)).map(f => readFile(join(dir, f), 'utf8')))).join('');
    expect(data).not.toContain('private message'); expect(data).not.toContain('session1'); expect(data).not.toContain('tool_input');
  });
  it('uses Codex source timing even when receipt times are identical; keeps missing timing distinct', async () => {
    const { audit } = await setup(); const extra = { provider: 'codex' };
    audit.observe(event('PreToolUse', 'a', extra), 'codex', { toolAuditAt: clock - 5000 });
    audit.observe(event('PostToolUse', 'a', extra), 'codex', { toolAuditAt: clock - 1000 });
    audit.observe(event('PreToolUse', 'b', extra), 'codex', {});
    audit.observe(event('PostToolUse', 'b', extra), 'codex', {});
    audit.observe(event('PreToolUse', 'c', extra), 'codex', { toolAuditAt: clock });
    audit.observe(event('PostToolUse', 'c', extra), 'codex', { toolAuditAt: clock - 1000 });
    const r = await audit.report(query); expect(r.total).toBe(3); expect(r.measured).toBe(1);
    expect(r.rows[0].medianMs).toBe(4000); expect(r.rows[0].missingTiming).toBe(2); expect(r.rows[0].p95Ms).toBeNull();
  });
  it('survives restart and reports unmatched starts without inferred timing', async () => {
    const { audit, dir } = await setup(); audit.observe(event('PreToolUse'), 'hook'); await audit.close();
    const next = createToolAudit({ dir, now: () => clock }); audits.push(next); await next.start(); clock += 5000;
    let r = await next.report(query); expect(r.unmatched).toBe(1); expect(r.measured).toBe(0);
    next.observe(event('PostToolUse'), 'hook'); r = await next.report({ ...query, operation: 'git commit' });
    expect(r.measured).toBe(1); expect(r.details.slowest[0].durationMs).toBe(5000);
  });
  it('excludes replay/enrichment and does not confuse event-log ownership with audit collection', async () => {
    const { audit } = await setup();
    audit.observe(event('PreToolUse', 'replay'), 'hook', { replay: true });
    audit.observe(event('PreToolUse', 'remote'), 'peer');
    audit.observe(event('PreToolUse', 'local'), 'hook', { persist: false });
    expect((await audit.report(query)).total).toBe(1);
  });
  it('discloses shared shell timing and separates providers under the same operation', async () => {
    const { audit } = await setup(); const input = { tool_input: { command: 'git status && git commit -m secret' } };
    audit.observe(event('PreToolUse', 'a', input), 'hook'); clock += 5000; audit.observe(event('PostToolUse', 'a'), 'hook');
    audit.observe(event('PreToolUse', 'b', { provider: 'codex', ...input }), 'codex', { toolAuditAt: clock });
    const r = await audit.report(query); expect(r.total).toBe(2); expect(r.rows).toHaveLength(2);
    expect(r.rows[0].shared).toBe(2); expect(r.rows[0].providers).toEqual({ claude: 1, codex: 1 });
    expect((await audit.report({ provider: 'codex', days: 90 })).total).toBe(1);
  });
  it('physically prunes retention, shows actual bytes and clears without resurrecting pending calls', async () => {
    const { audit, dir } = await setup(); audit.observe(event('PreToolUse'), 'hook'); await audit.status();
    clock += 40 * 86400000; await audit.configure(30);
    expect((await readdir(dir)).filter(f => f.endsWith('.jsonl'))).toEqual([]);
    audit.observe(event('PreToolUse', 'new'), 'hook'); const before = await audit.status();
    await audit.clear(); const after = await audit.status(); expect(after.bytes).toBeLessThan(before.bytes); expect(after.deviceId).toBe(before.deviceId);
    expect(after.epoch).not.toBe(before.epoch); expect(after.retentionDays).toBe(30);
    audit.observe(event('PostToolUse', 'new'), 'hook'); const r = await audit.report(query); expect(r.total).toBe(0); expect(r.orphaned).toBe(1);
  });
  it('cancels a closed report and allows another snapshot afterward', async () => {
    const { audit } = await setup(); audit.observe(event('PreToolUse'), 'hook');
    const controller = new AbortController(); const report = audit.report(query, controller.signal); controller.abort();
    await expect(report).rejects.toThrow('cancelled');
    expect((await audit.report(query)).total).toBe(1);
  });
  it('reports corrupt journal records without fabricating calls', async () => {
    const { audit, dir } = await setup();
    await writeFile(join(dir, '2026-10-13.jsonl'), '{bad}\n{"kind":"start"}\n');
    const r = await audit.report(query); expect(r.total).toBe(0); expect(r.corrupt).toBe(2);
  });
  it('does not overwrite corrupt configuration or claim an empty successful report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccdeck-tool-audit-')); dirs.push(dir);
    await writeFile(join(dir, 'settings.json'), '{bad}'); const a = createToolAudit({ dir });
    await expect(a.start()).rejects.toThrow(); expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('{bad}');
  });
});
describe('report boundary and display', () => {
  it('rejects invalid calendar dates, providers and oversized ranges', () => {
    for (const q of ['provider=other', 'days=999', 'since=2026-02-30&until=2026-03-01', 'since=2026-99-99&until=2026-99-99', 'since=2026-01-01', 'since=2026-01-01&until=2026-10-01']) expect(auditQuery(new URLSearchParams(q))).toBeNull();
    expect(auditQuery(new URLSearchParams('provider=claude&days=30'))).toMatchObject({ provider: 'claude', days: 30 });
  });
  it('sorts unavailable timings last and distinguishes zero from missing', () => {
    expect(auditDuration(null)).toBe('—'); expect(auditDuration(0)).toBe('0 ms');
    const rows = [{ operation: 'git commit', calls: 10, totalMs: null }, { operation: 'git status', calls: 2, totalMs: 0 }, { operation: 'Read', calls: 9, totalMs: 500 }] as AuditRow[];
    expect(sortAuditRows(rows, 'totalMs', '').map(r => r.operation)).toEqual(['Read', 'git status', 'git commit']);
    expect(sortAuditRows(rows, 'calls', 'GIT').map(r => r.operation)).toEqual(['git commit', 'git status']);
  });
});
