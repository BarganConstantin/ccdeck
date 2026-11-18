import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
// @ts-expect-error server module
import { scanProjectFolders, createProjectDiscovery } from '../../server/project-discovery.mjs';
// @ts-expect-error server module
import { handleTerminalProjects } from '../../server/terminal-routes.mjs';
// @ts-expect-error server module
import { isGuardedRead } from '../../server/request-gates.mjs';

const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function lab() { const p = await mkdtemp(join(tmpdir(), 'ccdeck-projects-')); temp.push(p); return p; }
async function repo(p: string) { await mkdir(join(p, '.git'), { recursive: true }); }
describe('local projects offered without an existing session', () => {
  it('keeps paths behind the guarded terminal route and does not scan when the panel or engine is off', async () => {
    let scans = 0, status = 0, body = '';
    const response = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } };
    const scan = async () => { scans++; return { projects: [{ cwd: '/srv/project', name: 'project' }], truncated: false }; };
    expect(isGuardedRead('/api/terminal/projects')).toBe(true);
    await handleTerminalProjects({}, response, { enabled: () => false, discoverProjects: scan });
    expect(status).toBe(404); expect(scans).toBe(0);
    await handleTerminalProjects({}, response, { enabled: () => true, engine: null, discoverProjects: scan });
    expect(status).toBe(409); expect(scans).toBe(0);
    await handleTerminalProjects({}, response, { enabled: () => true, engine: { enabled: true }, discoverProjects: scan });
    expect(status).toBe(200); expect(scans).toBe(1); expect(JSON.parse(body).projects[0].name).toBe('project');
  });
  it('finds repositories in working folders without listing worktrees, dependencies or hidden data', async () => {
    const root = await lab();
    await repo(join(root, 'api')); await repo(join(root, 'work', 'site'));
    await repo(join(root, 'node_modules', 'dependency')); await repo(join(root, '.cache', 'copy'));
    await mkdir(join(root, 'branch')); await writeFile(join(root, 'branch', '.git'), 'gitdir: ../api/.git/worktrees/branch');
    const r = await scanProjectFolders({ roots: [root] });
    expect(r.projects.map((p: { name: string }) => p.name)).toEqual(['api', 'site']);
  });
  it('deduplicates overlapping roots and does not descend beyond the configured depth', async () => {
    const root = await lab(); await repo(join(root, 'a')); await repo(join(root, 'group', 'nested'));
    const r = await scanProjectFolders({ roots: [root, join(root, 'a')], maxDepth: 1 });
    expect(r.projects.map((p: { name: string }) => p.name)).toEqual(['a']);
  });
  it('bounds a scan, tolerates missing roots, and shares cached concurrent requests', async () => {
    const root = await lab(); await repo(join(root, 'one')); await repo(join(root, 'two'));
    expect((await scanProjectFolders({ roots: [join(root, 'missing'), root], maxProjects: 1 })).projects).toHaveLength(1);
    let scans = 0;
    const read = createProjectDiscovery({ scan: async () => { scans++; return { projects: [], truncated: false }; } });
    await Promise.all([read(), read(), read()]); await read(); expect(scans).toBe(1);
  });
  it('does not follow nested symlinks out of the working folders', async () => {
    const root = await lab(), outside = await lab(); await repo(join(outside, 'external'));
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await scanProjectFolders({ roots: [root] })).projects).toEqual([]);
  });
  it('groups real Git worktrees outside the roots, including relative pointers, and skips stale links', async () => {
    const root = await lab(), outside = await lab();
    const main = join(root, 'project'), linked = join(outside, 'fix login'), stale = join(outside, 'stale');
    const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' });
    git('init', main);
    git('-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
    git('-C', main, 'worktree', 'add', '-b', 'fix/login', linked);
    git('-C', main, 'worktree', 'add', '--detach', stale);
    await rm(stale, { recursive: true, force: true });
    const expected = {
      cwd: await realpath(linked), name: 'fix login',
      worktree: { projectCwd: await realpath(main), projectName: 'project', branch: 'fix/login' },
    };
    expect((await scanProjectFolders({ roots: [root] })).projects.slice(1)).toEqual([expected]);
    const pointer = await readFile(join(linked, '.git'), 'utf8');
    const admin = await realpath(pointer.trim().slice('gitdir: '.length));
    await writeFile(join(admin, 'gitdir'), relative(admin, join(expected.cwd, '.git')) + '\r\n');
    // Git for Windows marks this file hidden. Node's default 'w' flag
    // cannot overwrite a hidden file; 'r+' can update it in place.
    const marker = await open(join(linked, '.git'), 'r+');
    try {
      await marker.truncate(0);
      await marker.write('gitdir: ' + relative(expected.cwd, admin) + '\r\n', 0);
      expect((await scanProjectFolders({ roots: [root, outside] })).projects.slice(1)).toEqual([expected]);
      await marker.truncate(0);
      await marker.write('gitdir: ' + join(main, '.git') + '\n', 0);
      expect((await scanProjectFolders({ roots: [root] })).projects).toHaveLength(1);
    } finally {
      await marker.close();
    }
  });
  it('reports partial results when directory, entry or time budgets stop discovery', async () => {
    const root = await lab(); await repo(join(root, 'one')); await repo(join(root, 'two'));
    for (const limits of [{ maxDirs: 1 }, { maxEntries: 1 }, { budgetMs: 0 }]) {
      expect((await scanProjectFolders({ roots: [root], ...limits })).truncated).toBe(true);
    }
  });
  it('refreshes an expired cache and retries a failed scan', async () => {
    let clock = 0, scans = 0;
    const read = createProjectDiscovery({ now: () => clock, ttlMs: 30, scan: async () => {
      if (++scans === 2) throw new Error('unavailable');
      return { projects: [{ cwd: '/srv/project', name: 'project' }], truncated: false };
    } });
    await read(); clock = 29; await read(); expect(scans).toBe(1);
    clock = 30; await expect(read()).rejects.toThrow('unavailable');
    await read(); expect(scans).toBe(3);
  });
});
