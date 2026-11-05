import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnedArgv } from './spawned-argv';

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[]; child: EventEmitter }> }));
vi.mock('node:child_process', () => ({
  spawn(file: string, args: string[]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {} });
    calls.push({ file, args, child }); return child;
  },
  execFile() { throw new Error('No process may be executed by this fixture'); },
}));
// @ts-expect-error server module
import { startUpgrade, upgradeStatus } from '../../server/npm-upgrade.mjs';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const put = (dir: string, version: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ccdeck', version })); };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccdeck-update-prefix-')); roots.push(root);
  const active = join(root, 'active user & space'), other = join(root, 'other node');
  const location = (p: string) => process.platform === 'win32' ? join(p, 'node_modules', 'ccdeck') : join(p, 'lib', 'node_modules', 'ccdeck');
  const a = location(active), b = location(other); put(a, '3.53.2'); put(b, '3.53.2');
  vi.stubEnv('AGENTS_DECK_NO_INSTALL', '0'); vi.stubEnv('CCDECK_APP', '0'); vi.stubEnv('npm_config_prefix', other); calls.length = 0;
  return { a, b, active };
}
describe('updating the copy that is actually running', () => {
  it('pins npm to the active global prefix even when another Node prefix is the default', () => {
    const f = fixture(); expect(startUpgrade({ pkgRoot: f.a })).toMatchObject({ ok: true });
    const args = spawnedArgv(calls[0]);
    // Simulate the install reaching the prefix npm was actually asked for.
    put(args.includes('--prefix') && args[args.indexOf('--prefix') + 1] === f.active ? f.a : f.b, '3.81.0');
    calls[0].child.emit('close', 0);
    expect(args).toContain('--prefix'); expect(args[args.indexOf('--prefix') + 1]).toBe(f.active);
    expect(upgradeStatus()).toMatchObject({ state: 'done', error: null });
  });
  it('does not claim installed when npm exits successfully but only another copy changed', () => {
    const f = fixture(); startUpgrade({ pkgRoot: f.a }); put(f.b, '3.81.0'); calls[0].child.emit('close', 0);
    expect(upgradeStatus()).toMatchObject({ state: 'failed', error: expect.stringContaining('running copy') });
  });
  it('recognizes files already installed ahead of the running process', () => {
    const f = fixture(); put(f.a, '3.81.0'); startUpgrade({ pkgRoot: f.a, running: '3.53.2' }); calls[0].child.emit('close', 0);
    expect(upgradeStatus().state).toBe('done');
  });
  it('requires a newer active version, not a downgrade or a missing manifest', () => {
    const f = fixture(); startUpgrade({ pkgRoot: f.a }); put(f.a, '3.40.0'); calls[0].child.emit('close', 0);
    expect(upgradeStatus().state).toBe('failed');
  });
});
