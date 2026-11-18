// New session suggestions: repository folders, not a filesystem browser.
// Inspect directory entries only, never source files, Git configuration or
// credentials. Worktrees stay available through explicit choices/recents.
import { constants } from 'node:fs';
import { access, lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'bin', 'obj', '__tests__']);
const denied = error => error?.code === 'EACCES' || error?.code === 'EPERM';
export function projectRoots(home = homedir()) {
  return ['Desktop', 'Documents', 'Developer', 'Projects', 'projects', 'repos', 'Code', 'code', 'src', 'workspace']
    .map(name => join(home, name));
}

export async function scanProjectFolders({ roots = projectRoots(), maxDepth = 3, maxDirs = 500,
  maxProjects = 150, maxEntries = 10000, budgetMs = 1500, now = Date.now } = {}) {
  const queue = roots.map(cwd => ({ cwd, depth: 0 })), seen = new Set(), projects = [];
  const deadline = now() + budgetMs;
  let visited = 0, entries = 0, truncated = false;
  for (let at = 0; at < queue.length; at++) {
    if (visited >= maxDirs || projects.length >= maxProjects || entries >= maxEntries || now() >= deadline) { truncated = true; break; }
    const { cwd, depth } = queue[at];
    let canonical;
    try { canonical = await realpath(cwd); } catch (error) { if (denied(error)) truncated = true; continue; }
    if (seen.has(canonical)) continue;
    seen.add(canonical); visited++;
    try {
      const marker = await lstat(join(cwd, '.git')).catch(() => null);
      if (marker) {
        if (marker.isDirectory()) {
          await access(cwd, constants.R_OK | constants.X_OK);
          projects.push({ cwd: canonical, name: basename(canonical) });
        }
        continue;
      }
      if (depth >= maxDepth) continue;
      const directory = await opendir(cwd);
      for await (const entry of directory) {
        if (++entries > maxEntries || now() >= deadline) { truncated = true; break; }
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) {
          queue.push({ cwd: join(cwd, entry.name), depth: depth + 1 });
        }
      }
    } catch (error) {
      // Missing conventional folders are normal. A denied folder means the
      // suggestions may be incomplete, without exposing the failing path.
      if (denied(error)) truncated = true;
    }
  }
  projects.sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
  return { projects, truncated };
}

export function createProjectDiscovery({ scan = scanProjectFolders, now = Date.now, ttlMs = 30000 } = {}) {
  let cached = null, cachedAt = 0, pending = null;
  return () => {
    if (pending) return pending;
    if (cached && now() - cachedAt < ttlMs) return Promise.resolve(cached);
    pending = Promise.resolve().then(scan).then(result => { cached = result; cachedAt = now(); return result; })
      .finally(() => { pending = null; });
    return pending;
  };
}
export const discoverProjects = createProjectDiscovery();
