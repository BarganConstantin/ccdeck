import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexShare, importCodexShare, CODEX_SHARE_PREFIX, secureCodexImportHome } from '../../server/codex-share.mjs';
import { readCodexSelection, addCodexProfile, selectCodexProfile } from '../../server/codex-selection.mjs';
import { ensureWindowsPrivateDirectory } from '../../server/codex-windows-private.mjs';

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

// Public-safe, deliberately nonfunctional credentials; no real provider I/O.
const auth = (n = 1) => ({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
  id_token: `fictional.id-token-${n}.unsigned`, access_token: `fictional-access-${n}`, refresh_token: `fictional-refresh-${n}`, account_id: `fictional-account-${n}`,
}, last_refresh: '2026-01-01T00:00:00.000Z' });
const modernAuth = (n = 1) => ({ ...auth(n), tokens: { ...auth(n).tokens,
  oauth_provenance: { issuer: 'https://auth.openai.com', client_id: 'fictional-codex-client' },
  login_owner_id: 'fictional-completed-login-'.padEnd(43, 'x'),
} });
const encode = (accounts: unknown[], extra = {}) => CODEX_SHARE_PREFIX + Buffer.from(JSON.stringify({ version: 1, provider: 'codex', accounts, ...extra })).toString('base64url');
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-codex-share-')); roots.push(root);
  const home = join(root, 'original'), store = join(root, 'deck');
  if (process.platform === 'win32') await ensureWindowsPrivateDirectory(home);
  else await mkdir(home);
  await writeFile(join(home, 'auth.json'), JSON.stringify(auth()), { mode: 0o600 });
  const options = { store, home: root, env: { CODEX_HOME: home }, platform: process.platform };
  const selection = await readCodexSelection(options);
  return { root, home, store, options, selection };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('manual Codex credential sharing', () => {
  it('round trips legacy and Codex 0.166 logins together without dropping OAuth authority or changing login ownership', async () => {
    const source = await fixture(), target = await fixture();
    const modern = await addCodexProfile({ label: 'Fictional modern', operationId: 'modern-profile' }, source.options);
    const modernHome = modern.profiles.find((p: { id: string }) => p.id === modern.id)!.home;
    if (process.platform === 'win32') {
      await rm(modernHome, { recursive: true });
      await ensureWindowsPrivateDirectory(modernHome);
    }
    await writeFile(join(modernHome, 'auth.json'), JSON.stringify(modernAuth(2)), { mode: 0o600 });
    const before = await readFile(join(modernHome, 'auth.json'));
    const shared = await createCodexShare({ ids: [source.selection.profileId, modern.id] }, source.options);
    expect(shared.count).toBe(2);
    const payload = JSON.parse(Buffer.from(shared.blob.slice(CODEX_SHARE_PREFIX.length), 'base64url').toString());
    expect(payload.accounts.map((a: { auth: unknown }) => a.auth)).toEqual([auth(), modernAuth(2)]);
    const imported = await importCodexShare({ blob: shared.blob, expectedRevision: 0 }, target.options);
    const selection = await readCodexSelection(target.options);
    expect(selection.profileId).toBe(target.selection.profileId);
    for (const [index, entry] of imported.results.entries()) {
      const home = selection.profiles.find((p: { id: string }) => p.id === entry.id)!.home;
      expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(index === 0 ? auth() : modernAuth(2));
    }
    expect(await readFile(join(modernHome, 'auth.json'))).toEqual(before);
    const registry = await readFile(join(target.store, 'codex-accounts.json'), 'utf8');
    expect(registry).not.toContain(modernAuth().tokens.login_owner_id);
    expect(registry).not.toContain('fictional-codex-client');
    expect(await importCodexShare({ blob: shared.blob, expectedRevision: 0 }, target.options)).toMatchObject({
      revision: imported.revision, results: [{ status: 'already_imported' }, { status: 'already_imported' }],
    });
  });

  it.each([
    { oauth_provenance: null, login_owner_id: null },
    { oauth_provenance: modernAuth().tokens.oauth_provenance },
    { login_owner_id: modernAuth().tokens.login_owner_id },
  ])('preserves optional metadata as stored without inferring missing fields %#', async metadata => {
    const source = await fixture(), target = await fixture();
    const stored = { ...auth(), tokens: { ...auth().tokens, ...metadata } };
    await writeFile(join(source.home, 'auth.json'), JSON.stringify(stored), { mode: 0o600 });
    const shared = await createCodexShare({ ids: [source.selection.profileId] }, source.options);
    const imported = await importCodexShare({ blob: shared.blob, expectedRevision: 0 }, target.options);
    const selection = await readCodexSelection(target.options);
    const home = selection.profiles.find((p: { id: string }) => p.id === imported.results[0].id)!.home;
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(stored);
  });

  it.each([
    { oauth_provenance: [] },
    { oauth_provenance: { issuer: 'https://auth.openai.com' } },
    { oauth_provenance: { ...modernAuth().tokens.oauth_provenance, home: '../escape' } },
    { oauth_provenance: { issuer: 'http://auth.openai.com', client_id: 'fictional-client' } },
    { oauth_provenance: { issuer: 'https://untrusted.example', client_id: 'fictional-client' } },
    { oauth_provenance: { issuer: 'https://auth.openai.com.evil.example', client_id: 'fictional-client' } },
    { oauth_provenance: { issuer: 'https://fictional:password@auth.openai.com', client_id: 'fictional-client' } },
    { oauth_provenance: { issuer: 'https://auth.openai.com?redirect=fictional', client_id: 'fictional-client' } },
    { oauth_provenance: { issuer: 'https://auth.openai.com:444', client_id: 'fictional-client' } },
    { oauth_provenance: { issuer: 'https://auth.openai.com', client_id: {} } },
    { oauth_provenance: { issuer: 'https://auth.openai.com', client_id: 'x'.repeat(513) } },
    { login_owner_id: {} }, { login_owner_id: '' }, { login_owner_id: '../escape' }, { login_owner_id: 'x'.repeat(513) },
    { unknown_metadata: 'fictional' },
  ])('rejects malformed or unsafe new token metadata on export and import %#', async metadata => {
    const f = await fixture(), stored = { ...auth(), tokens: { ...auth().tokens, ...metadata } };
    await writeFile(join(f.home, 'auth.json'), JSON.stringify(stored), { mode: 0o600 });
    await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'unsupported_auth', message: 'unsupported_auth' });
    await expect(importCodexShare({ blob: encode([{ label: null, auth: stored }]), expectedRevision: 0 }, f.options)).rejects.toMatchObject({ code: 'unsupported_auth', message: 'unsupported_auth' });
    expect((await readCodexSelection(f.options)).revision).toBe(0);
  });

  it('exports only selected registered file auth; no paths, config, history, expiry or network calls', async () => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not contact provider'));
    await writeFile(join(f.home, 'config.toml'), 'model = "fictional-model"');
    await writeFile(join(f.home, 'history.jsonl'), 'private history');
    const extra = await addCodexProfile({ operationId: 'empty-profile' }, f.options);
    const shared = await createCodexShare({ ids: [f.selection.profileId] }, f.options);
    expect(shared).toMatchObject({ ok: true, count: 1 });
    const decoded = JSON.parse(Buffer.from(shared.blob.slice(CODEX_SHARE_PREFIX.length), 'base64url').toString());
    expect(decoded).toEqual({ version: 1, provider: 'codex', accounts: [{ label: null, auth: auth() }] });
    expect(JSON.stringify(decoded)).not.toContain(f.root);
    expect(shared).not.toHaveProperty('expiresAt');
    expect(fetch).not.toHaveBeenCalled();
    await expect(createCodexShare({ ids: [extra.id] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
  });

  it('round trips to fresh managed homes, preserves active/default auth, dedups across concurrent retries and restart', async () => {
    const source = await fixture(), target = await fixture();
    const added = await addCodexProfile({ label: 'Existing', operationId: 'existing' }, target.options);
    const addedHome = added.profiles.find((p: { id: string }) => p.id === added.id)!.home;
    await writeFile(join(addedHome, 'auth.json'), JSON.stringify(auth(3)), { mode: 0o600 });
    await selectCodexProfile({ id: added.id, expectedRevision: 1, operationId: 'choose-existing' }, target.options);
    const before = await readCodexSelection(target.options);
    const originalBytes = await readFile(join(target.home, 'auth.json'));
    const { blob } = await createCodexShare({ ids: [source.selection.profileId] }, source.options);
    const request = { blob, expectedRevision: before.revision };
    const [a, b] = await Promise.all([importCodexShare(request, target.options), importCodexShare(request, target.options)]);
    expect(a.results[0].id).toBe(b.results[0].id);
    expect([a.results[0].status, b.results[0].status].sort()).toEqual(['already_imported', 'imported']);
    const after = await readCodexSelection(target.options);
    expect(after.profileId).toBe(added.id);
    expect(after.originalHome).toBe(target.home);
    expect(after.runningSelection).toEqual(before.runningSelection);
    expect(await readFile(join(target.home, 'auth.json'))).toEqual(originalBytes);
    expect(JSON.parse(await readFile(join(addedHome, 'auth.json'), 'utf8'))).toEqual(auth(3));
    const imported = after.profiles.find((p: { id: string }) => p.id === a.results[0].id)!;
    expect(imported.home).not.toBe(source.home);
    expect(imported.home).not.toBe(target.home);
    expect(await readdir(imported.home)).toEqual(['auth.json']);
    expect(JSON.parse(await readFile(join(imported.home, 'auth.json'), 'utf8'))).toEqual(auth());
    if (process.platform !== 'win32') {
      expect((await lstat(imported.home)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(imported.home, 'auth.json'))).mode & 0o777).toBe(0o600);
    }
    const metadata = await readFile(join(target.store, 'codex-accounts.json'), 'utf8');
    expect(metadata).not.toContain('fictional-refresh');
    expect(metadata).not.toContain('fictional-access');
    expect(await importCodexShare(request, target.options)).toMatchObject({ revision: after.revision, results: [{ status: 'already_imported' }] });
  });

  it('validates whole batches before writing and refuses stale new imports without changing selection', async () => {
    const f = await fixture();
    const valid = { label: null, auth: auth() };
    await expect(importCodexShare({ blob: encode([valid, { label: null, auth: { OPENAI_API_KEY: 'fictional-api-key' } }]), expectedRevision: 0 }, f.options)).rejects.toMatchObject({ code: 'unsupported_auth' });
    expect((await readCodexSelection(f.options)).revision).toBe(0);
    await addCodexProfile({ operationId: 'other-writer' }, f.options);
    await expect(importCodexShare({ blob: encode([valid]), expectedRevision: 0 }, f.options)).rejects.toMatchObject({ code: 'selection_conflict' });
    expect(await readdir(join(f.store, 'codex-profiles'))).toHaveLength(1);
  });

  it('dedups within a batch and refuses to replace existing imported auth even with forged identity claims', async () => {
    const f = await fixture();
    const first = await importCodexShare({ blob: encode([{ label: 'Fictional', auth: auth() }, { label: null, auth: auth() }]), expectedRevision: 0 }, f.options);
    expect(first.results.map((r: { status: string }) => r.status)).toEqual(['imported', 'already_imported']);
    const home = (await readCodexSelection(f.options)).profiles.find((p: { id: string }) => p.id === first.results[0].id)!.home;
    const changed = { ...auth(), tokens: { ...auth().tokens, id_token: 'forged.claims.unsigned', access_token: 'fictional-replacement' } };
    const retry = await importCodexShare({ blob: encode([{ label: 'Other', auth: changed }]), expectedRevision: 0 }, f.options);
    expect(retry.results).toEqual([{ id: first.results[0].id, status: 'already_imported' }]);
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(auth());
  });

  it.each(['keyring', 'auto', 'ephemeral'])('refuses stale file auth when store is %s', async store => {
    const f = await fixture();
    await writeFile(join(f.home, 'config.toml'), `cli_auth_credentials_store = "${store}"\n`);
    await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
  });

  it.each([
    '[profiles.work]\ncli_auth_credentials_store = "keyring"',
    'cli_auth_credentials_store = "file"\n[profiles.work]\ncli_auth_credentials_store = "keyring"',
    'profiles.work.cli_auth_credentials_store = "file"',
    'cli_auth_credentials_store = "file"\ncli_auth_credentials_store = "file"',
    '"cli_auth_credentials_stor\\u0065" = "keyring"',
    'other = """multiline\ncli_auth_credentials_store = "keyring"\n"""',
  ])('fails closed on ambiguous TOML store settings %#', async config => {
    const f = await fixture(); await writeFile(join(f.home, 'config.toml'), config);
    await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
  });

  it('refuses non-private POSIX source files and hard links', async () => {
    const f = await fixture();
    if (process.platform !== 'win32') {
      await chmod(join(f.home, 'auth.json'), 0o644);
      await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
      await chmod(join(f.home, 'auth.json'), 0o600);
    }
    await link(join(f.home, 'auth.json'), join(f.root, 'auth-hardlink'));
    await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
  });

  it('refuses a source changed or replaced during export instead of sharing a mixed/stale login', async () => {
    const f = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
      const handle = await actual.open(...args), read = handle.read.bind(handle);
      handle.read = async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        await writeFile(join(f.home, 'auth.json'), JSON.stringify(auth(2)) + '\n', { mode: 0o600 });
        return result;
      };
      return handle;
    });
    await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
  });

  it('accepts explicitly configured file auth and refuses symlink and oversized files', async () => {
    const f = await fixture();
    await writeFile(join(f.home, 'config.toml'), 'cli_auth_credentials_store = "file" # comment\n[other]\nvalue = true\n');
    expect((await createCodexShare({ ids: [f.selection.profileId] }, f.options)).count).toBe(1);
    await writeFile(join(f.home, 'auth.json'), 'x'.repeat(32001));
    await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
    await rm(join(f.home, 'auth.json'));
    await writeFile(join(f.root, 'elsewhere'), JSON.stringify(auth()));
    await symlink(join(f.root, 'elsewhere'), join(f.home, 'auth.json'));
    await expect(createCodexShare({ ids: [f.selection.profileId] }, f.options)).rejects.toMatchObject({ code: 'file_auth_required' });
  });

  it.each([undefined, '', '{}', 'claude-code', CODEX_SHARE_PREFIX + 'abc=', 'x'.repeat(512001), encode([]), encode(Array(21).fill({ label: null, auth: auth() })),
    encode([{ label: '../../escape', auth: auth() }]), encode([{ label: null, auth: auth(), home: '/tmp/escape' }]),
    encode([{ label: null, auth: { ...auth(), config: 'escape' } }]), encode([{ label: null, auth: { ...auth(), auth_mode: 'apikey' } }]),
    encode([{ label: null, auth: { ...auth(), OPENAI_API_KEY: 'fictional-api' } }]), encode([{ label: null, auth: { ...auth(), tokens: { ...auth().tokens, refresh_token: '' } } }]),
    encode([{ label: null, auth: auth() }], { path: '/tmp/escape' }),
  ])('rejects malformed/hostile payload %# with fixed credential-free errors', async blob => {
    const f = await fixture();
    await expect(importCodexShare({ blob, expectedRevision: 0 }, f.options)).rejects.toSatisfy((error: Error & { code: string }) =>
      ['invalid_share', 'unsupported_auth'].includes(error.code) && error.message === error.code);
    expect((await readCodexSelection(f.options)).revision).toBe(0);
  });

  it('rejects unknown IDs, paths, duplicate IDs and too many export accounts', async () => {
    const f = await fixture();
    for (const ids of [[f.home], [], Array(21).fill(f.selection.profileId), [f.selection.profileId, f.selection.profileId]]) {
      await expect(createCodexShare({ ids }, f.options)).rejects.toMatchObject({ code: 'invalid_profiles' });
    }
    await expect(createCodexShare({ ids: ['f'.repeat(20)] }, f.options)).rejects.toMatchObject({ code: 'unknown_profile' });
  });

  it('rolls back every new home if the atomic registry write fails', async () => {
    const f = await fixture();
    await expect(importCodexShare({ blob: encode([{ label: null, auth: auth() }, { label: null, auth: auth(2) }]), expectedRevision: 0 }, {
      ...f.options, writeFileAtomic: async () => { throw new Error('fictional credential must never escape'); },
    })).rejects.toMatchObject({ code: 'registry_write_failed' });
    expect(await readdir(join(f.store, 'codex-profiles'))).toEqual([]);
    expect((await readCodexSelection(f.options)).revision).toBe(0);
  });

  it('rejects a substituted managed root, leaving external folders empty', async () => {
    const f = await fixture(), outside = join(f.root, 'outside');
    await mkdir(f.store); await mkdir(outside); await symlink(outside, join(f.store, 'codex-profiles'));
    await expect(importCodexShare({ blob: encode([{ label: null, auth: auth() }]), expectedRevision: 0 }, f.options)).rejects.toMatchObject({ code: 'registry_corrupt' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('installs Windows ACL before auth staging, and fails closed with sanitized errors', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ path: 'C:\\fictional\\new-profile' }) });
    await secureCodexImportHome('C:\\fictional\\new-profile', { platform: 'win32', execFile });
    expect(execFile).toHaveBeenCalledWith(expect.stringMatching(/powershell\.exe$/), expect.arrayContaining(['-NoProfile', '-NonInteractive', '-File', '-Operation', 'ensure']), expect.objectContaining({
      shell: false, timeout: 30000,
    }));
    execFile.mockRejectedValue(new Error('fictional secret stderr'));
    await expect(secureCodexImportHome('C:\\fictional\\new-profile', { platform: 'win32', execFile })).rejects.toMatchObject({ code: 'windows_permissions_failed', message: 'windows_permissions_failed' });
    const f = await fixture();
    await expect(importCodexShare({ blob: encode([{ label: null, auth: auth() }]), expectedRevision: 0 }, {
      ...f.options, platform: 'win32', execFile,
      // POSIX fixture homes cannot model Windows registry path semantics, but
      // initial registry creation does not read a previously persisted state.
    })).rejects.toMatchObject({ code: 'windows_permissions_failed' });
    expect(await readdir(join(f.store, 'codex-profiles'))).toEqual([]);
  });
});
