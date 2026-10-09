import { describe, it, expect, vi } from 'vitest';
import { configuredCodexHomes, codexProfileSessionDirs, discoverCodexProfiles, readCodexProfileQuota, resolveCodexProfile, codexProfileLaunchCommand } from '../../server/codex-profiles.mjs';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Codex profile discovery', () => {
  it('enumerates independent session roots once even when a home is an alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-session-homes-'));
    try {
      const a = join(root, 'a'); const b = join(root, 'b'); const alias = join(root, 'alias');
      await mkdir(a); await mkdir(b); await symlink(a, alias);
      expect(await codexProfileSessionDirs({ env: { CODEX_HOME: a, CCDECK_CODEX_HOMES: JSON.stringify([alias, b, a]) } }))
        .toEqual([join(a, 'sessions'), join(b, 'sessions')]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('detects Codex when only an explicitly configured alternate home exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-installed-profiles-'));
    const previousDefault = process.env.CODEX_HOME;
    const previousExtras = process.env.CCDECK_CODEX_HOMES;
    try {
      process.env.CODEX_HOME = join(root, 'missing-default');
      process.env.CCDECK_CODEX_HOMES = JSON.stringify([root]);
      const { hasCodexInstalled } = await import('../../server/installer.mjs');
      expect(hasCodexInstalled()).toBe(true);
      process.env.CCDECK_CODEX_HOMES = '[]';
      expect(hasCodexInstalled()).toBe(false);
    } finally {
      if (previousDefault === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousDefault;
      if (previousExtras === undefined) delete process.env.CCDECK_CODEX_HOMES; else process.env.CCDECK_CODEX_HOMES = previousExtras;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps existing CODEX_HOME behavior with no configuration', () => {
    expect(configuredCodexHomes({ CODEX_HOME: '/tmp/current' }, '/tmp')).toEqual(['/tmp/current']);
  });

  it('accepts explicit distinct absolute profiles and ignores invalid entries', () => {
    const env = { CODEX_HOME: '/tmp/a', CCDECK_CODEX_HOMES: JSON.stringify(['/tmp/a', '/tmp/b', './relative', 5, '']) };
    expect(configuredCodexHomes(env, '/tmp')).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('handles Windows paths without treating drive letters as separators', () => {
    const env = { CODEX_HOME: 'C:\\Users\\dev\\.codex', CCDECK_CODEX_HOMES: JSON.stringify(['D:\\Codex Work', 'relative', 'C:\\Users\\dev\\.codex']) };
    expect(configuredCodexHomes(env, 'C:\\Users\\dev', 'win32')).toEqual(['C:\\Users\\dev\\.codex', 'D:\\Codex Work']);
  });

  it('does not expose credentials, paths, or conflate symlinked homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-profiles-'));
    try {
      const a = join(root, 'a');
      const b = join(root, 'b');
      await mkdir(a); await mkdir(b);
      await writeFile(join(a, 'auth.json'), JSON.stringify({ tokens: { access_token: 'PRIVATE_TOKEN' } }));
      const profiles = await discoverCodexProfiles({ env: { CODEX_HOME: a, CCDECK_CODEX_HOMES: JSON.stringify([b]) } });
      expect(profiles).toHaveLength(2);
      expect(profiles[0].signedInFilePresent).toBe(true);
      expect(profiles[1].signedInFilePresent).toBe(false);
      expect(profiles[0].id).not.toBe(profiles[1].id);
      expect(JSON.stringify(profiles)).not.toContain('PRIVATE_TOKEN');
      expect(JSON.stringify(profiles)).not.toContain(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('distinguishes identical emails in different workspaces even with expired credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-identity-'));
    try {
      const homes = [join(root, 'a'), join(root, 'b')];
      for (const [index, directory] of homes.entries()) {
        await mkdir(directory);
        const claims = { email: 'same@example.com', exp: 1, 'https://api.openai.com/auth': { chatgpt_account_id: `workspace-${index}` } };
        await writeFile(join(directory, 'auth.json'), JSON.stringify({ tokens: { id_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, access_token: 'SECRET' } }));
      }
      const profiles = await discoverCodexProfiles({ env: { CODEX_HOME: homes[0], CCDECK_CODEX_HOMES: JSON.stringify([homes[1]]) } });
      expect(profiles[0].label).toContain('same@example.com');
      expect(profiles[1].label).toContain('same@example.com');
      expect(profiles[0].label).not.toBe(profiles[1].label);
      expect(JSON.stringify(profiles)).not.toContain('SECRET');
      expect(JSON.stringify(profiles)).not.toContain('workspace-');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects unknown profile IDs without reading a caller-specified path', async () => {
    expect(await resolveCodexProfile('../../auth.json', { env: { CODEX_HOME: '/tmp/current' } })).toBeNull();
    expect(await readCodexProfileQuota('f'.repeat(20), { env: { CODEX_HOME: '/tmp/current' } })).toEqual({ ok: false, reason: 'unknown_profile' });
  });

  it('quotes shell paths and scopes launch environment to a new process', async () => {
    const path = "/tmp/profile's private";
    const env = { CODEX_HOME: path };
    const [profile] = await discoverCodexProfiles({ env });
    expect(await codexProfileLaunchCommand(profile.id, { env, platform: 'darwin' }))
      .toBe("CODEX_HOME='/tmp/profile'\\''s private' codex");
    const windowsEnv = { CODEX_HOME: "C:\\Users\\dev's home\\.codex" };
    const [windowsProfile] = await discoverCodexProfiles({ env: windowsEnv, platform: 'win32' });
    expect(await codexProfileLaunchCommand(windowsProfile.id, { env: windowsEnv, platform: 'win32' }))
      .toBe("$previousCodexHome = $env:CODEX_HOME; try { $env:CODEX_HOME = 'C:\\Users\\dev''s home\\.codex'; codex } finally { $env:CODEX_HOME = $previousCodexHome }");
  });

  it('reads each profile quota with its own token, without refreshing or leaking credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-quota-'));
    try {
      const a = join(root, 'a'); const b = join(root, 'b');
      await mkdir(a); await mkdir(b);
      await writeFile(join(a, 'auth.json'), JSON.stringify({ tokens: { access_token: 'ACCESS_A' } }));
      await writeFile(join(b, 'auth.json'), JSON.stringify({ tokens: { access_token: 'ACCESS_B' } }));
      const env = { CODEX_HOME: a, CCDECK_CODEX_HOMES: JSON.stringify([b]) };
      const profiles = await discoverCodexProfiles({ env });
      const seen: string[] = [];
      const mockFetch = async (url: string, opts: { headers: Record<string, string> }) => {
        expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
        seen.push(opts.headers.Authorization);
        return { ok: true, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 35, limit_window_seconds: 18000 } } }) };
      };
      const first = await readCodexProfileQuota(profiles[0].id, { env, fetch: mockFetch });
      const second = await readCodexProfileQuota(profiles[1].id, { env, fetch: mockFetch });
      expect(seen).toEqual(['Bearer ACCESS_A', 'Bearer ACCESS_B']);
      expect(first.windows).toEqual([{ usedPercent: 35, resetAt: null, seconds: 18000 }]);
      expect(first.plan).toBe('plus');
      expect(first.identityVersion).toBe(profiles[0].identityVersion);
      expect(JSON.stringify([first, second])).not.toContain('ACCESS_');
      await readCodexProfileQuota(profiles[0].id, { env, fetch: mockFetch });
      expect(seen).toHaveLength(2);
      // Re-login can replace auth.json while the previous account's quota is cached.
      await writeFile(join(a, 'auth.json'), JSON.stringify({ tokens: { access_token: 'REPLACED_ACCOUNT_TOKEN' } }));
      const replaced = await readCodexProfileQuota(profiles[0].id, { env, fetch: mockFetch });
      const refreshed = await discoverCodexProfiles({ env });
      expect(replaced.identityVersion).toBe(refreshed[0].identityVersion);
      expect(replaced.identityVersion).not.toBe(first.identityVersion);
      expect(seen).toEqual(['Bearer ACCESS_A', 'Bearer ACCESS_B', 'Bearer REPLACED_ACCOUNT_TOKEN']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports revoked authentication and quota throttling without publishing secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-quota-fail-'));
    try {
      const a = join(root, 'a');
      await mkdir(a);
      await writeFile(join(a, 'auth.json'), JSON.stringify({ tokens: { access_token: 'SECRET_ACCESS_TOKEN' } }));
      const env = { CODEX_HOME: a };
      const [profile] = await discoverCodexProfiles({ env });
      const unauthorized = await readCodexProfileQuota(profile.id, {
        env, fetch: async () => ({ ok: false, status: 401 }),
      });
      expect(unauthorized).toEqual({ ok: false, reason: 'reauth_required' });
      expect(JSON.stringify(unauthorized)).not.toContain('SECRET_ACCESS_TOKEN');
      // Changing auth.json invalidates the cache and permits another read.
      await writeFile(join(a, 'auth.json'), JSON.stringify({ tokens: { access_token: 'NEW_ACCESS_TOKEN' } }));
      const throttled = await readCodexProfileQuota(profile.id, {
        env, fetch: async () => ({ ok: false, status: 429 }),
      });
      expect(throttled).toEqual({ ok: false, reason: 'http_429' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an in-flight quota response after auth.json is replaced without evicting the newer account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-quota-race-'));
    try {
      await writeFile(join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'OLD_LOGIN' } }));
      const env = { CODEX_HOME: root };
      const [profile] = await discoverCodexProfiles({ env });
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      let finishOld!: (value: unknown) => void;
      const old = readCodexProfileQuota(profile.id, {
        env,
        fetch: (_url: string, opts: { headers: Record<string, string> }) => {
          expect(opts.headers.Authorization).toBe('Bearer OLD_LOGIN');
          signalStarted();
          return new Promise((resolve) => { finishOld = resolve; });
        },
      });
      await started;
      await writeFile(join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'NEW_LOGIN_DIFFERENT_LENGTH' } }));
      const newer = await readCodexProfileQuota(profile.id, {
        env,
        fetch: async (_url: string, opts: { headers: Record<string, string> }) => {
          expect(opts.headers.Authorization).toBe('Bearer NEW_LOGIN_DIFFERENT_LENGTH');
          return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 71 } } }) };
        },
      });
      finishOld({ ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 19 } } }) });
      expect(await old).toEqual({ ok: false, reason: 'profile_changed' });
      expect(newer.windows[0].usedPercent).toBe(71);
      expect((await readCodexProfileQuota(profile.id, { env })).windows[0].usedPercent).toBe(71);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('omits missing and invalid quota percentages instead of reporting invented zero usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-quota-window-'));
    try {
      await writeFile(join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'TOKEN_WINDOW' } }));
      const env = { CODEX_HOME: root };
      const [profile] = await discoverCodexProfiles({ env });
      const result = await readCodexProfileQuota(profile.id, { env, fetch: async () => ({
        ok: true,
        json: async () => ({ rate_limit: {
          primary_window: { used_percent: null },
          secondary_window: { used_percent: -5 },
        } }),
      }) });
      expect(result.windows).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('shows a stale confirmed reading on 429/offline only while credentials are unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccdeck-quota-stale-'));
    let currentTime = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      await writeFile(join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'TOKEN_FIRST' } }));
      const env = { CODEX_HOME: root };
      const [profile] = await discoverCodexProfiles({ env });
      const original = await readCodexProfileQuota(profile.id, { env, fetch: async () => ({
        ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 42 } } }),
      }) });
      currentTime += 61_000;
      const throttled = await readCodexProfileQuota(profile.id, { env, fetch: async () => ({ ok: false, status: 429 }) });
      expect(throttled).toEqual({ ok: false, reason: 'http_429', stale: true, lastGood: original });
      currentTime += 61_000;
      const offline = await readCodexProfileQuota(profile.id, { env, fetch: async () => { throw Error('network down'); } });
      expect(offline).toEqual({ ok: false, reason: 'fetch_error', stale: true, lastGood: original });
      await writeFile(join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'TOKEN_REPLACED_DIFFERENT' } }));
      const next = await readCodexProfileQuota(profile.id, { env, fetch: async () => ({ ok: false, status: 429 }) });
      expect(next).toEqual({ ok: false, reason: 'http_429' });
    } finally { now.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});
