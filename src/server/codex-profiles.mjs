// Explicit Codex homes are separate profiles, not snapshots of auth.json.
// This read-only discovery layer never loads, copies or refreshes credentials.
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32, join } from 'node:path';
import { createHash } from 'node:crypto';
import { codexHome } from './codex-dir.mjs';

/**
 * Parse explicitly configured Codex homes. The active CODEX_HOME always wins;
 * additional directories are opt-in via a JSON array, not a path delimiter
 * (Windows drives and paths containing colons must remain unambiguous).
 * Reject relative paths to avoid interpreting homes against a changing cwd.
 */
export function configuredCodexHomes(env = process.env, home = homedir(), platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const current = codexHome(env, home, platform);
  let extras = [];
  if (env.CCDECK_CODEX_HOMES?.trim()) {
    try {
      const parsed = JSON.parse(env.CCDECK_CODEX_HOMES);
      if (Array.isArray(parsed)) extras = parsed;
    } catch { /* Invalid optional configuration must not break current Codex. */ }
  }
  const result = [current];
  for (const entry of extras) {
    if (typeof entry !== 'string' || !entry.trim() || !path.isAbsolute(entry.trim())) continue;
    const candidate = path.resolve(entry.trim());
    if (!result.includes(candidate)) result.push(candidate);
  }
  return result;
}

/** The ID identifies a home, never an OAuth token or an email address. */
export async function discoverCodexProfiles(options = {}) {
  const homes = configuredCodexHomes(options.env, options.home, options.platform);
  const seen = new Set();
  const profiles = [];
  for (const directory of homes) {
    let canonical;
    try { canonical = await realpath(directory); } catch { canonical = directory; }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    let installed = false;
    try { await access(join(directory, 'auth.json')); installed = true; } catch { /* No login yet. */ }
    profiles.push({
      id: createHash('sha256').update(canonical).digest('hex').slice(0, 20),
      label: profiles.length === 0 ? 'Default Codex' : `Codex profile ${profiles.length + 1}`,
      active: profiles.length === 0,
      signedInFilePresent: installed, // file presence is NOT authentication validity
    });
  }
  return profiles;
}
