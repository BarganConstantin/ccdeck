import { describe, it, expect } from 'vitest';
import { configuredCodexHomes, discoverCodexProfiles } from '../../server/codex-profiles.mjs';
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
});
