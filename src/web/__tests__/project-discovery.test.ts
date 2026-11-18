import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
