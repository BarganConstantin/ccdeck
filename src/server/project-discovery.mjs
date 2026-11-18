// New session suggestions: repository folders, not a filesystem browser.
// Inspect directory entries and Git worktree pointers, never source files,
// Git configuration or credentials.
import { constants } from 'node:fs';
import { access, lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'bin', 'obj', '__tests__']);
const denied = error => error?.code === 'EACCES' || error?.code === 'EPERM';

// Git metadata here is a single short line. A stale link, symlink, or ordinary
// file posing as a .git pointer should not turn discovery into a file reader.
async function metadataLine(path) {
  if (!(await lstat(path)).isFile()) return '';
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const limit = 8192;
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) return '';
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) return '';
    const line = buffer.toString('utf8', 0, bytesRead).replace(/\r?\n$/, '');
    return /[\r\n\0]/.test(line) ? '' : line;
  } finally {
    await file.close();
  }
}

async function linkedWorktree(admin, project) {
  const common = await metadataLine(join(admin, 'commondir'));
  if (!common || await realpath(resolve(admin, common)) !== await realpath(join(project.cwd, '.git'))) return null;
  const gitdir = await metadataLine(join(admin, 'gitdir'));
  if (!gitdir) return null;
  // Relative pointers are resolved from the directory containing the pointer,
  // just as Git does for worktrees created with --relative-paths.
  const marker = isAbsolute(gitdir) ? gitdir : resolve(admin, gitdir);
  if (basename(marker) !== '.git') return null;
  const cwd = await realpath(dirname(marker));
  if (cwd === project.cwd) return null;
  const pointer = await metadataLine(join(cwd, '.git'));
  if (!pointer.startsWith('gitdir: ')) return null;
  if (await realpath(resolve(cwd, pointer.slice(8))) !== await realpath(admin)) return null;
  await access(cwd, constants.R_OK | constants.X_OK);
  const head = await metadataLine(join(admin, 'HEAD')).catch(() => '');
  const branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : '';
  return {
    cwd,
    name: basename(cwd),
    worktree: { projectCwd: project.cwd, projectName: project.name, ...(branch ? { branch } : {}) },
  };
}
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
  const byName = (a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd);
  projects.sort(byName);
  const worktrees = [];
  const offered = new Set(projects.map(p => p.cwd));
  for (const project of projects) {
    if (projects.length + worktrees.length >= maxProjects || now() >= deadline || entries >= maxEntries) {
      truncated = true;
      break;
    }
    const registrations = join(project.cwd, '.git', 'worktrees');
    try {
      if (!(await lstat(registrations)).isDirectory()) continue;
      for await (const entry of await opendir(registrations)) {
        if (++entries > maxEntries || now() >= deadline || projects.length + worktrees.length >= maxProjects) {
          truncated = true;
          break;
        }
        if (!entry.isDirectory()) continue;
        try {
          const worktree = await linkedWorktree(join(registrations, entry.name), project);
          if (!worktree || offered.has(worktree.cwd)) continue;
          offered.add(worktree.cwd);
          worktrees.push(worktree);
        } catch (error) {
          if (denied(error)) truncated = true;
        }
      }
    } catch (error) {
      if (denied(error)) truncated = true;
    }
  }
  projects.push(...worktrees.sort(byName));
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
