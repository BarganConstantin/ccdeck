import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexProfileId, selectCodexProfile, readCodexSelection } from '../../server/codex-selection.mjs';
import { discoverCodexProfiles, readCodexProfileQuota } from '../../server/codex-profiles.mjs';
import { fetchCodexQuota, codexQuotaAccount } from '../../server/codex-quota.mjs';
import { getCodexAuth, usesNativeCodexAccount } from '../../server/codex-auth.mjs';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-native-integration-')); roots.push(root);
  const home = join(root, 'codex'); await mkdir(home);
  const env = { CODEX_HOME: home, CCDECK_HOME: join(root, 'deck') };
  const options = { env, enableNative: true };
  const id = await codexProfileId(home);
  return { root, home, id, env, options };
}
const native = () => ({ ok: true, signedIn: true, label: 'work@example.test', identityVersion: 'native-work',
  plan: 'plus', windows: [{ usedPercent: 130, seconds: 18000, resetAt: 2000000000 }], fetchedAt: Date.now() });

describe('system-store account integration', () => {
  it.each([true, false])('validates selection before routing with enableNative=%s', async enableNative => {
    const f = await fixture();
    const nativeRead = vi.fn(async () => native());
    for (const home of [undefined, '', '   ', 42]) {
      expect(await fetchCodexQuota({ enableNative, nativeRead,
        readSelection: async () => ({ home, selectionEnabled: true }) })).toEqual({ ok: false, reason: 'selection_unavailable' });
    }
    expect(await fetchCodexQuota({ enableNative, nativeRead,
      readSelection: async () => ({ home: f.home, selectionEnabled: true, available: false }) })).toEqual({ ok: false, reason: 'profile_unavailable' });
    expect(nativeRead).not.toHaveBeenCalled();
  });
  it('uses native identity and quota when no auth file exists', async () => {
    const f = await fixture(); const nativeRead = vi.fn(async () => native());
    const options = { ...f.options, nativeRead };
    const profiles = await discoverCodexProfiles(options);
    expect(profiles[0]).toMatchObject({ signedIn: true, signedInFilePresent: false, label: 'work@example.test', identityVersion: 'native-work' });
    const quota = await readCodexProfileQuota(f.id, options);
    expect(quota).toMatchObject({ ok: true, identityVersion: 'native-work', windows: [{ usedPercent: 130 }] });
    expect(nativeRead.mock.calls.every(call => call[0] === f.home)).toBe(true);
  });
  it('keeps file-backed inspection independent of native availability', async () => {
    const f = await fixture(); await writeFile(join(f.home, 'auth.json'), '{}');
    const nativeRead = vi.fn(async () => native());
    expect((await discoverCodexProfiles({ ...f.options, nativeRead }))[0].signedInFilePresent).toBe(true);
    expect(nativeRead).not.toHaveBeenCalled();
  });
  it('rejects a native reading if an auth file appears while it is pending', async () => {
    const f = await fixture();
    const nativeRead = async () => { await writeFile(join(f.home, 'auth.json'), '{}'); return native(); };
    expect(await readCodexProfileQuota(f.id, { ...f.options, nativeRead })).toMatchObject({ ok: false, reason: 'profile_changed' });
  });
  it('preserves the ambient full quota schema and rejects a changed selection', async () => {
    const f = await fixture(); let revision = 1;
    const readSelection = async () => ({ home: f.home, profileId: f.id, revision, selectionEnabled: true });
    const reading = await fetchCodexQuota({ enableNative: true, readSelection, nativeRead: async () => native() });
    expect(reading).toMatchObject({ ok: true, plan: 'plus', windows: [{ pct: 130, key: 'session' }] });
    const rejected = await fetchCodexQuota({ enableNative: true, readSelection, nativeRead: async () => { revision++; return native(); } });
    expect(rejected).toMatchObject({ ok: false, reason: 'profile_changed' });
  });
  it('supports read-only plan metadata without inventing access credentials', async () => {
    const f = await fixture();
    vi.stubEnv('CODEX_HOME', f.home); vi.stubEnv('CCDECK_HOME', f.env.CCDECK_HOME);
    await selectCodexProfile({ id: f.id, expectedRevision: 0, operationId: 'native-select' });
    expect((await readCodexSelection()).profileId).toBe(f.id);
    const auth = await getCodexAuth({ selectedReadOnly: true, enableNative: true, nativeRead: async () => native() });
    expect(auth).toMatchObject({ ok: true, planType: 'plus', accessToken: null, refreshed: false });
  });
  it.each(['keyring', 'auto'])('uses %s storage rather than a stale file', async mode => {
    const f = await fixture();
    await writeFile(join(f.home, 'config.toml'), `cli_auth_credentials_store = "${mode}"\n`);
    await writeFile(join(f.home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-old-key' }));
    const nativeRead = vi.fn(async () => native());
    const profile = (await discoverCodexProfiles({ ...f.options, nativeRead }))[0];
    expect(profile).toMatchObject({ authSource: 'native', signedIn: true, identityVersion: 'native-work' });
    expect(await readCodexProfileQuota(f.id, { ...f.options, nativeRead })).toMatchObject({ ok: true, partial: true });
    expect(nativeRead).toHaveBeenCalledWith(f.home, { includeQuota: true, force: true });
  });
  it('uses native managed reads, retains failures, and scopes same-label notifications', async () => {
    const f = await fixture();
    await writeFile(join(f.home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-old-key' }));
    const selected = { home: f.home, profileId: f.id, revision: 1, selectionEnabled: true };
    const nativeRead = vi.fn(async () => native());
    const a = await fetchCodexQuota({ enableNative: true, readSelection: async () => selected, nativeRead });
    const b = await fetchCodexQuota({ enableNative: true, readSelection: async () => ({ ...selected, profileId: 'another-profile' }), nativeRead });
    expect(a).toMatchObject({ ok: true, partial: true });
    expect(codexQuotaAccount(a)?.accountId).not.toEqual(codexQuotaAccount(b)?.accountId);
    expect(nativeRead).toHaveBeenCalledWith(f.home, { includeQuota: true, force: true });
    const failed = async () => ({ ok: false, signedIn: false, reason: 'rpc_timeout' });
    const profile = (await discoverCodexProfiles({ ...f.options, selection: { ...selected, homes: [f.home] }, nativeRead: failed }))[0];
    expect(profile).toMatchObject({ metadataUnavailable: true, metadataReason: 'rpc_timeout', signedIn: false });
    vi.stubEnv('CODEX_HOME', f.home); vi.stubEnv('CCDECK_HOME', f.env.CCDECK_HOME);
    await selectCodexProfile({ id: f.id, expectedRevision: 0, operationId: 'native-failure' });
    expect(await getCodexAuth({ selectedReadOnly: true, enableNative: true, nativeRead: failed })).toMatchObject({ ok: false, reason: 'rpc_timeout', metadataUnavailable: true });
  });
  it('treats absent storage configuration as legacy file and ignores table-local lookalikes', async () => {
    const f = await fixture();
    expect(await usesNativeCodexAccount(f.home)).toBe(false);
    await writeFile(join(f.home, 'config.toml'), '[profiles.work]\ncli_auth_credentials_store = "keyring"\n');
    expect(await usesNativeCodexAccount(f.home)).toBe(false);
    expect(await usesNativeCodexAccount(f.home, true)).toBe(true);
  });

  it('rejects ambient native fallback when a credential file is replaced during the read', async () => {
    const f = await fixture();
    vi.stubEnv('CODEX_HOME', f.home);
    vi.resetModules();
    const { fetchCodexQuota: freshFetch } = await import('../../server/codex-quota.mjs');
    const selected = { home: f.home, profileId: f.id, revision: 0, selectionEnabled: false };
    const result = await freshFetch({ enableNative: true, readSelection: async () => selected,
      nativeRead: async () => {
        await writeFile(join(f.home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-replacement' } }));
        return native();
      } });
    expect(result).toEqual({ ok: false, reason: 'profile_changed' });
  });

});
