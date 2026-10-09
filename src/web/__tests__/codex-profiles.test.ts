import { describe, it, expect } from 'vitest';
import { configuredCodexHomes, discoverCodexProfiles, readCodexProfileQuota, resolveCodexProfile, codexProfileLaunchCommand } from '../../server/codex-profiles.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Codex profile discovery', () => {
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
    expect(await codexProfileLaunchCommand(profile.id, { env, platform: 'win32' })).toBeNull();
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
      expect(JSON.stringify([first, second])).not.toContain('ACCESS_');
      await readCodexProfileQuota(profiles[0].id, { env, fetch: mockFetch });
      expect(seen).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
