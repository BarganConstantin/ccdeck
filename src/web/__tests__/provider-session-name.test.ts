import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameProviderSession } from '../../server/provider-session-name.mjs';

const sid = '01234567-1234-4234-8234-123456789abc';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ccdeck-provider-name-')); dirs.push(home);
  const project = join(home, '.claude', 'projects', 'project'); await mkdir(project, { recursive: true });
  return { home, project, path: join(project, sid + '.jsonl') };
}

it('appends a native Claude title while preserving the conversation byte for byte', async () => {
  const f = await fixture();
  const original = JSON.stringify({ type: 'user', sessionId: sid, message: 'fixture' }) + '\n';
  await writeFile(f.path, original);
  await renameProviderSession('claude', sid, 'Planning', { home: f.home, env: {} });
  const content = await readFile(f.path, 'utf8');
  expect(content.startsWith(original)).toBe(true);
  expect(JSON.parse(content.slice(original.length))).toEqual({ type: 'custom-title', customTitle: 'Planning', sessionId: sid });
});

it.each(['partial', 'symlink', 'duplicate'])('refuses ambiguous or unsafe Claude metadata: %s', async mode => {
  const f = await fixture();
  if (mode === 'symlink') { const target = join(f.home, 'outside'); await writeFile(target, '{}\n'); await symlink(target, f.path); }
  else await writeFile(f.path, mode === 'partial' ? '{' : '{}\n');
  if (mode === 'duplicate') { const other = join(f.project, '..', 'other'); await mkdir(other); await writeFile(join(other, sid + '.jsonl'), '{}\n'); }
  await expect(renameProviderSession('claude', sid, 'Planning', { home: f.home, env: {} })).rejects.toThrow();
  expect(await readFile(f.path, 'utf8')).toBe(mode === 'partial' ? '{' : '{}\n');
});

it('renames the exact Codex thread using its native metadata RPC, without starting work', async () => {
  const calls: string[] = [];
  const rpc = { request: vi.fn(async (method: string, params: unknown) => { calls.push(method);
    if (method === 'thread/read') return { thread: { id: sid } };
    expect(params).toEqual({ threadId: sid, name: 'Planning' }); return {};
  }), close: vi.fn() };
  await renameProviderSession('codex', sid, 'Planning', {
    readSelection: async () => ({ originalHome: '/fixture' }), resolveEndpoint: async () => ({}), connectRpc: async () => rpc,
  });
  expect(calls).toEqual(['thread/read', 'thread/name/set']);
  expect(rpc.close).toHaveBeenCalledOnce();
});

it('closes the Codex connection when native rename fails', async () => {
  const rpc = { request: vi.fn(async () => { throw Error('unavailable'); }), close: vi.fn() };
  await expect(renameProviderSession('codex', sid, 'Planning', {
    readSelection: async () => ({ originalHome: '/fixture' }), resolveEndpoint: async () => ({}), connectRpc: async () => rpc,
  })).rejects.toThrow();
  expect(rpc.close).toHaveBeenCalledOnce();
});
