// Explicit Codex homes are separate profiles, not snapshots of auth.json.
// Discovery reads display metadata only; credentials are never copied or refreshed.
import { access, realpath, readFile, stat } from 'node:fs/promises';
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

/** Resolve each explicitly trusted home once before scanning rollout trees.
 * Deduping canonical directories avoids reading a symlink alias twice. */
export async function codexProfileSessionDirs(options = {}) {
  const homes = configuredCodexHomes(options.env, options.home, options.platform);
  const seen = new Set();
  const result = [];
  for (const home of homes) {
    let canonical;
    try { canonical = await realpath(home); } catch { canonical = home; }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(join(home, 'sessions'));
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
    const credentialVersion = await credentialFileVersion(directory);
    let identity = null;
    try {
      const auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
      let claims = {};
      try { claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] ?? '', 'base64url').toString()); } catch { /* Account ID may still be available. */ }
      const email = typeof claims.email === 'string' ? claims.email.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 254) : null;
      const account = auth.tokens?.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id;
      const workspace = typeof account === 'string' ? createHash('sha256').update(account).digest('hex').slice(0, 8) : null;
      identity = email ? `${email}${workspace ? ` · ${workspace}` : ''}` : workspace ? `Account ${workspace}` : null;
    } catch { /* Missing or malformed login metadata uses the profile label. */ }
    if (await credentialFileVersion(directory) !== credentialVersion) identity = null;
    profiles.push({
      id: createHash('sha256').update(canonical).digest('hex').slice(0, 20),
      identityVersion: createHash('sha256').update(credentialVersion).digest('hex'),
      label: identity ?? (profiles.length === 0 ? 'Default Codex' : `Codex profile ${profiles.length + 1}`),
      active: profiles.length === 0,
      signedInFilePresent: installed, // file presence is NOT authentication validity
    });
  }
  return profiles;
}

/** Resolve a browser-supplied opaque ID only against homes explicitly trusted
 * at server startup. Never accept a path from an HTTP request. */
export async function resolveCodexProfile(id, options = {}) {
  if (typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id)) return null;
  const homes = configuredCodexHomes(options.env, options.home, options.platform);
  for (const directory of homes) {
    let canonical;
    try { canonical = await realpath(directory); } catch { canonical = directory; }
    if (createHash('sha256').update(canonical).digest('hex').slice(0, 20) === id) return directory;
  }
  return null;
}

/** Command for a new terminal session. An environment override only applies
 * to the launched process; no existing session or global auth is modified. */
export async function codexProfileLaunchCommand(id, options = {}) {
  const directory = await resolveCodexProfile(id, options);
  if (!directory) return null;
  if ((options.platform ?? process.platform) === 'win32') {
    // PowerShell environment changes persist in the current shell, so restore
    // the previous value even if Codex exits unsuccessfully.
    return `$previousCodexHome = $env:CODEX_HOME; try { $env:CODEX_HOME = '${directory.replaceAll("'", "''")}'; codex } finally { $env:CODEX_HOME = $previousCodexHome }`;
  }
  return `CODEX_HOME='${directory.replaceAll("'", "'\\''")}' codex`;
}

/** Read-only per-profile quota. The main CODEX_HOME keeps its existing quota
 * poller; alternate profiles never trigger single-use OAuth refreshes. */
const profileQuotaCache = new Map();
async function credentialFileVersion(directory) {
  try {
    const info = await stat(join(directory, 'auth.json'));
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch { return 'missing'; }
}

export async function readCodexProfileQuota(id, options = {}) {
  const directory = await resolveCodexProfile(id, options);
  if (!directory) return { ok: false, reason: 'unknown_profile' };
  // Invalidate cached quota after a login / account replacement. The file may
  // contain an entirely different ChatGPT account within the cache lifetime.
  const credentialVersion = await credentialFileVersion(directory);
  const now = Date.now();
  const cached = profileQuotaCache.get(id);
  if (cached?.credentialVersion === credentialVersion && cached.pending) return cached.pending;
  if (cached?.credentialVersion === credentialVersion && now - cached.at < 60_000) return cached.value;
  // Last-good readings may be shown as stale only for the same auth file.
  const lastGood = cached?.credentialVersion === credentialVersion ? cached.lastGood : null;
  const request = (async () => {
    let auth;
    try { auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')); }
    catch { return { ok: false, reason: 'no_token' }; }
    if (auth?.auth_mode === 'apikey' || !auth?.tokens?.access_token) {
      return { ok: false, reason: auth?.auth_mode === 'apikey' ? 'api_key_mode' : 'no_token' };
    }
    // This read-only path must never spend a rotating refresh credential.
    // Report expiry instead of contacting the API with a known-expired token.
    try {
      const payload = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString());
      if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
        return { ok: false, reason: 'expired' };
      }
    } catch { /* Non-JWT tokens may still be accepted by the service. */ }
    const claims = (() => {
      try { return JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString()); }
      catch { return {}; }
    })();
    const accountId = auth.tokens.account_id ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    const headers = { Authorization: `Bearer ${auth.tokens.access_token}`, Accept: 'application/json', 'User-Agent': 'codex-cli' };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    let response;
    try {
      response = await (options.fetch ?? fetch)('https://chatgpt.com/backend-api/wham/usage', {
        headers, cache: 'no-store', signal: AbortSignal.timeout(12_000),
      });
    } catch { return { ok: false, reason: 'fetch_error' }; }
    if (!response.ok) return { ok: false, reason: response.status === 401 ? 'reauth_required' : `http_${response.status}` };
    let body;
    try { body = await response.json(); }
    catch { return { ok: false, reason: 'decode_error' }; }
    const window = (value) => {
      const raw = value?.used_percent;
      if (raw == null || raw === '') return null;
      const pct = Number(raw);
      return Number.isFinite(pct) && pct >= 0 && pct <= 100
        ? { usedPercent: pct, resetAt: value.resets_at ?? null, seconds: value.limit_window_seconds ?? null }
        : null;
    };
    return {
      ok: true, fetchedAt: Date.now(),
      identityVersion: createHash('sha256').update(credentialVersion).digest('hex'),
      plan: body?.plan_type ?? claims?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null,
      windows: [window(body?.rate_limit?.primary_window), window(body?.rate_limit?.secondary_window)].filter(Boolean),
    };
  })();
  const pending = request.then(async (value) => {
    // A login may have changed while the remote service was responding. Never
    // publish (or cache) a quota reading from a superseded auth.json.
    if (await credentialFileVersion(directory) !== credentialVersion) {
      return { ok: false, reason: 'profile_changed' };
    }
    const retryable = value.reason === 'fetch_error' || value.reason === 'http_429'
      || /^http_5\d\d$/.test(value.reason ?? '');
    return !value.ok && retryable && lastGood
      ? { ...value, stale: true, lastGood }
      : value;
  });
  profileQuotaCache.set(id, { at: now, pending, credentialVersion, lastGood });
  const value = await pending;
  if (profileQuotaCache.get(id)?.pending === pending) {
    if (value.reason === 'profile_changed') profileQuotaCache.delete(id);
    else profileQuotaCache.set(id, {
      at: Date.now(), value, credentialVersion,
      lastGood: value.ok ? value : lastGood,
    });
  }
  return value;
}
