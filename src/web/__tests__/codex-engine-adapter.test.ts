import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error server ES module
import { runAccountEngine } from '../../server/account-engine.mjs';
// @ts-expect-error server ES module
import { addCodexProfile, readCodexSelection, selectCodexProfile } from '../../server/codex-selection.mjs';
// @ts-expect-error server ES module
import { applyCodexAuto } from '../../server/codex-auto.mjs';
import { Writable } from 'node:stream';
// @ts-expect-error server ES module
import { codexHandoffOffset } from '../../server/codex-handoff.mjs';
// @ts-expect-error server ES module
import { codexEngineInvocation, runCodexEngineAttempt, transferCodexThread, createCodexEngineAdapter } from '../../server/codex-engine-adapter.mjs';
const id = '12345678-1234-1234-1234-123456789abc';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-engine-')); roots.push(root);
  const source = join(root, 'source'), target = join(root, 'target');
  const day = join(source, 'sessions', '2026', '11', '02');
  await mkdir(day, { recursive: true }); await mkdir(target);
  const rollout = join(day, `rollout-2026-11-02T12-00-00-${id}.jsonl`);
  const text = JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n';
  await writeFile(rollout, text); await writeFile(join(source, 'auth.json'), 'source secret'); await writeFile(join(target, 'auth.json'), 'target secret');
  return { root, source, target, rollout, text };
}
describe('Codex continuation adapter', () => {
  it('preserves understood invocation options and resumes by explicit ID', () => {
    const invocation = codexEngineInvocation(['-c', 'model_reasoning_effort="high"', 'exec', '--json', '-s', 'read-only', '-C', '/a folder', 'original prompt']);
    expect(invocation.resumeArgs(id)).toEqual(['-c', 'model_reasoning_effort="high"', 'exec', '--json', '-s', 'read-only', '-C', '/a folder', 'resume', id, '--', expect.any(String)]);
    expect(codexEngineInvocation(['exec', '--json', 'resume', id, 'continue']).threadId).toBe(id);
  });
  it.each([
    [], ['login'], ['resume', id], ['exec', 'task'], ['exec', '--json', '--last'],
    ['exec', '--json', '--ephemeral', 'task'], ['exec', '--json', '--unknown', 'x'],
    ['exec', '--json', '-i', 'image.png', 'task'], ['exec', '--json', 'resume', '--last'],
    ['-c', 'model_provider="other"', 'exec', '--json', 'task'],
  ])('does not reconstruct unsupported argv %j', (...args) => { expect(codexEngineInvocation(args)).toBeNull(); });
  it('transfers only the exact transcript with private permissions and never overwrites', async () => {
    const f = await fixture();
    const out = await transferCodexThread(f.source, f.target, id);
    expect(await readFile(out, 'utf8')).toBe(f.text);
    expect(await codexHandoffOffset(out, id, Buffer.byteLength(f.text))).toBe(Buffer.byteLength(f.text));
    expect(await codexHandoffOffset(out, 'another-thread', Buffer.byteLength(f.text))).toBe(0);
    expect(await readFile(join(f.source, 'auth.json'), 'utf8')).toBe('source secret');
    expect(await readFile(join(f.target, 'auth.json'), 'utf8')).toBe('target secret');
    if (process.platform !== 'win32') expect((await stat(out)).mode & 0o777).toBe(0o600);
    await expect(transferCodexThread(f.source, f.target, id)).rejects.toThrow();
  });
  it('rejects an incorrect transcript identity', async () => {
    const f = await fixture(); await writeFile(f.rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'other' } }) + '\n');
    await expect(transferCodexThread(f.source, f.target, id)).rejects.toThrow('identity');
  });
  it.skipIf(process.platform === 'win32')('refuses a symlinked destination', async () => {
    const f = await fixture(); await symlink(join(f.source, 'sessions'), join(f.target, 'sessions'));
    await expect(transferCodexThread(f.source, f.target, id)).rejects.toThrow('symbolic');
  });
  it('reads terminal protocol failures, not text inside tool or assistant output', async () => {
    const f = await fixture();
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const run = async (events: unknown[], code = 1) => {
      const script = join(f.root, 'fake.cjs');
      await writeFile(script, `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));process.exit(${code});`);
      return runCodexEngineAttempt(process.execPath, [script], f.source, { stdout: sink, stderr: sink });
    };
    const started = { type: 'thread.started', thread_id: id };
    expect(await run([started, { type: 'turn.failed', error: { message: "You've hit your usage limit" } }])).toMatchObject({ reason: 'usage_limit', threadId: id });
    expect(await run([started, { type: 'item.completed', item: { text: 'usage limit' } }])).toMatchObject({ reason: 'failed' });
    expect(await run([started, { type: 'turn.failed', error: { message: '429 Too Many Requests' } }])).toMatchObject({ reason: 'failed' });
    expect(await run([started, { type: 'error', message: 'usage limit' }, { type: 'turn.completed' }], 0)).toMatchObject({ reason: 'completed' });
    expect(await run([started, { type: 'thread.started', thread_id: '87654321-1234-1234-1234-123456789abc' }, { type: 'turn.failed', error: { message: 'usage limit' } }])).toMatchObject({ reason: 'protocol_error' });
  });
});

describe('Codex account engine integration', () => {
  it('continues across real child processes using the exact rollout without changing the default or tokens', async () => {
    const f = await fixture();
    const store = join(f.root, 'store');
    const options = { store, env: { ...process.env, CODEX_HOME: f.source } };
    const added = await addCodexProfile({ operationId: 'add' }, options);
    const state = await readCodexSelection(options);
    await selectCodexProfile({ id: state.profileId, expectedRevision: state.revision, operationId: 'select' }, options);
    const selected = await readCodexSelection(options);
    const target = selected.profiles.find((p: { id: string }) => p.id === added.id).home;
    await writeFile(join(target, 'auth.json'), 'target secret');
    await applyCodexAuto({ action: 'enable', enabled: true }, { store });
    const script = join(f.root, 'fake-codex.cjs');
    await writeFile(script, `
const fs = require('fs'), path = require('path');
const id = ${JSON.stringify(id)};
console.log(JSON.stringify({type:'thread.started',thread_id:id}));
if (process.argv.includes('resume')) {
  if (!process.argv.includes(id) || process.argv.includes('--last')) process.exit(8);
  const file = path.join(process.env.CODEX_HOME,'sessions','2026','11','02','rollout-2026-11-02T12-00-00-'+id+'.jsonl');
  if (!fs.readFileSync(file,'utf8').includes(id)) process.exit(9);
  console.log(JSON.stringify({type:'turn.completed'}));
} else {
  console.log(JSON.stringify({type:'turn.failed',error:{message:'You have hit your usage limit'}}));
  process.exitCode=1;
}`);
    let output = '';
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const args = ['exec', '--json', '-s', 'read-only', 'task'];
    const adapter = createCodexEngineAdapter(join(store, 'codex-accounts.json'), process.execPath, args, f.source, {
      ...options,
      nativeRead: async (home: string) => ({ ok: true, signedIn: true, label: home, identityVersion: home, plan: 'plus', fetchedAt: Date.now(), windows: [{ usedPercent: 10, seconds: 18000, resetAt: Date.now() / 1000 + 3600 }] }),
    });
    const launches: string[] = [];
    adapter.run = (current: { args: string[]; home: string; resumed?: boolean }, context: unknown) => {
      launches.push(current.home);
      return runCodexEngineAttempt(process.execPath, [script, ...current.args], current.home, { ...context as object, stdout, stderr, resumed: current.resumed });
    };
    try {
      expect(await runAccountEngine(adapter, { id: selected.profileId, home: f.source, args })).toMatchObject({ code: 0, reason: 'completed', threadId: id });
      expect(launches).toEqual([f.source, target]);
      const competitor = createCodexEngineAdapter(join(store, 'codex-accounts.json'), process.execPath, args, f.source, options);
      await expect(competitor.prepare({ from: { id: selected.profileId, home: f.source }, id: added.id, threadId: id })).rejects.toThrow();
      await competitor.close();
      expect(output).toContain('turn.completed');
      expect((await readCodexSelection(options)).profileId).toBe(selected.profileId);
      expect(await readFile(join(f.source, 'auth.json'), 'utf8')).toBe('source secret');
      expect(await readFile(join(target, 'auth.json'), 'utf8')).toBe('target secret');
    } finally { await adapter.close(); }
  });
});

it('cancels an owned running process without rotating it', async () => {
  const f = await fixture();
  const script = join(f.root, 'wait.cjs');
  await writeFile(script, `console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(id)}}));setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const sink = new Writable({ write(_chunk, _encoding, done) { controller.abort(); done(); } });
  const result = await runCodexEngineAttempt(process.execPath, [script], f.source, { signal: controller.signal, stdout: sink, stderr: sink });
  expect(result.reason).toBe('cancelled');
  expect(result.code).not.toBe(0);
});
