import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
// @ts-expect-error server ES module
import { readLiveCodexCredential } from '../../server/codex-live-credentials.mjs';
// @ts-expect-error server ES module
import { addCodexProfile, codexProfileId, codexSelectionPath, readCodexSelection, removeCodexProfile, selectCodexProfile } from '../../server/codex-selection.mjs';
// @ts-expect-error server ES module
import { ensureWindowsPrivateDirectory } from '../../server/codex-windows-private.mjs';

// No case can accidentally start an installed CLI, even if it omits startRpc.
vi.mock('../../server/codex-engine-rpc.mjs', () => ({
  startEngineRpc: vi.fn(() => { throw new Error('Real CLI disabled for this suite'); }),
}));
const hooks = vi.hoisted(() => ({
  afterOpen: null as null | (() => Promise<void>),
  afterRead: null as null | (() => Promise<void>),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('auth.json')) {
      const afterOpen = hooks.afterOpen; hooks.afterOpen = null;
      if (afterOpen) await afterOpen();
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const value = await read(...readArgs);
        const afterRead = hooks.afterRead; hooks.afterRead = null;
        if (afterRead) await afterRead();
        return value;
      }) as typeof handle.read;
    }
    return handle;
  } };
});

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  hooks.afterRead = hooks.afterOpen = null;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
// Fictional unsigned metadata only; no copied credentials or authenticated I/O.
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fictional_signature`;
const authClaim = 'https://api.openai.com/auth';
const EMAIL = 'fictional@example.invalid';
const ACCOUNT = 'fictional-workspace';
function auth(exp = Math.floor(Date.now() / 1000) + 3600) {
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
    access_token: jwt({ exp }), account_id: ACCOUNT,
    id_token: jwt({ email: EMAIL, [authClaim]: { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus' } }),
    refresh_token: 'fictional-refresh-never-exported',
  } };
}
type FakeOptions = {
  storeMode?: unknown;
  config?: unknown;
  account?: unknown;
  onAccount?: () => Promise<void>;
  onStop?: () => Promise<void>;
  failAt?: string;
  rawError?: Error;
  stallAt?: string;
};
function fakeRpc(settings: FakeOptions = {}) {
  const messages: { method: string; params?: unknown }[] = [];
  const rpc = {
    request: vi.fn(async (method: string, params: unknown) => {
      messages.push({ method, params });
      if (settings.failAt === method) throw settings.rawError ?? new Error('fictional raw RPC failure');
      if (settings.stallAt === method) return new Promise(() => {});
      if (method === 'initialize') return {};
      if (method === 'config/read') return 'config' in settings ? settings.config : { config: { cli_auth_credentials_store: settings.storeMode } };
      if (method === 'account/read') {
        await settings.onAccount?.();
        return { account: 'account' in settings ? settings.account : { type: 'chatgpt', email: EMAIL, planType: 'plus' } };
      }
      throw new Error('Unexpected fake method');
    }),
    send: vi.fn((message: { method: string; params?: unknown }) => { messages.push(message); }),
    stop: vi.fn(async () => { await settings.onStop?.(); return true; }),
  };
  const startRpc = vi.fn((_executable: string, _args: string[], _home: string, _options: unknown) => rpc);
  return { startRpc, rpc, messages };
}
async function fixture(settings: FakeOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ccdeck-live-credential-'))); roots.push(root);
  const home = join(root, 'home'), other = join(root, 'other'), store = join(root, 'deck');
  if (process.platform === 'win32') {
    await ensureWindowsPrivateDirectory(home); await ensureWindowsPrivateDirectory(other);
  } else { await mkdir(home, { mode: 0o700 }); await mkdir(other, { mode: 0o700 }); }
  const file = join(home, 'auth.json'), config = join(home, 'config.toml');
  const credential = auth();
  await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(config, '# unchanged synthetic configuration\n', { mode: 0o600 });
  const env = { CODEX_HOME: home, CCDECK_CODEX_HOMES: JSON.stringify([other]),
    PATH: '/fictional/bin', OPENAI_API_KEY: 'fictional-ambient-openai', CODEX_API_KEY: 'fictional-ambient-codex' };
  const fake = fakeRpc(settings);
  const options = { store, env, executable: 'fictional-codex', startRpc: fake.startRpc };
  return { root, home, other, file, config, credential, options, profileId: await codexProfileId(home), ...fake };
}
const stableStat = (s: Awaited<ReturnType<typeof lstat>>) => ({ dev: s.dev, ino: s.ino, size: s.size, mode: s.mode, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });

describe('live Codex credential reader (fictional JWTs and owned fake RPC only)', { timeout: process.platform === 'win32' ? 30000 : 5000 }, () => {
  it.each([undefined, null, 'file'])('reads a private unchanged credential with storage %s and strips ambient API keys', async storeMode => {
    const f = await fixture({ storeMode });
    const before = { auth: await readFile(f.file), config: await readFile(f.config), stat: stableStat(await lstat(f.file)) };
    const result = await readLiveCodexCredential(f.profileId, f.options);
    expect(result).toEqual({ profileId: f.profileId, accessToken: f.credential.tokens.access_token, accountId: ACCOUNT,
      email: EMAIL, planType: 'plus', expiresAt: JSON.parse(Buffer.from(f.credential.tokens.access_token.split('.')[1], 'base64url').toString()).exp * 1000 });
    expect(JSON.stringify(result)).not.toContain('refresh');
    expect({ auth: await readFile(f.file), config: await readFile(f.config), stat: stableStat(await lstat(f.file)) }).toEqual(before);
    expect(f.startRpc).toHaveBeenCalledOnce();
    const [executable, args, home, rpcOptions] = f.startRpc.mock.calls[0] as [string, string[], string, { env: Record<string, unknown>; deadlineMs: number }];
    expect([executable, args, home]).toEqual([resolve('fictional-codex'), ['app-server', '--listen', 'stdio://'], f.home]);
    expect(rpcOptions.env).toEqual({ CODEX_HOME: f.home, CCDECK_CODEX_HOMES: f.options.env.CCDECK_CODEX_HOMES, PATH: '/fictional/bin' });
    expect(rpcOptions.deadlineMs).toBeGreaterThan(0);
    expect(rpcOptions.deadlineMs).toBeLessThanOrEqual(process.platform === 'win32' ? 16000 : 7000);
    expect(f.messages).toEqual([
      { method: 'initialize', params: expect.objectContaining({ capabilities: { experimentalApi: true } }) },
      { method: 'initialized', params: {} },
      { method: 'config/read', params: { includeLayers: false, cwd: f.home } },
      { method: 'account/read', params: { refreshToken: false } },
    ]);
    expect(f.rpc.stop).toHaveBeenCalledOnce();
  });

  it('lets native refresh replace the file and propagates only a strict true flag', async () => {
    const f = await fixture();
    const replacement = auth(Math.floor(Date.now() / 1000) + 7200);
    const fake = fakeRpc({ onAccount: async () => {
      const staged = join(f.home, 'native-renewed');
      await writeFile(staged, JSON.stringify(replacement), { mode: 0o600 });
      await rename(staged, f.file);
    } });
    expect((await readLiveCodexCredential(f.profileId, { ...f.options, startRpc: fake.startRpc, refresh: true })).accessToken).toBe(replacement.tokens.access_token);
    expect(fake.messages.find(m => m.method === 'account/read')?.params).toEqual({ refreshToken: true });
    const ordinary = fakeRpc();
    await readLiveCodexCredential(f.profileId, { ...f.options, startRpc: ordinary.startRpc, refresh: 'true' });
    expect(ordinary.messages.find(m => m.method === 'account/read')?.params).toEqual({ refreshToken: false });
    expect(fake.rpc.stop).toHaveBeenCalledOnce(); expect(ordinary.rpc.stop).toHaveBeenCalledOnce();
  });

  it('resolves a nonselected known profile by ID and refuses paths or supplied roster overrides', async () => {
    const f = await fixture();
    await writeFile(join(f.other, 'auth.json'), JSON.stringify(auth()), { mode: 0o600 });
    const otherId = await codexProfileId(f.other);
    expect((await readLiveCodexCredential(otherId, { ...f.options, home: '/untrusted', selection: { profiles: [] } })).profileId).toBe(otherId);
    expect(f.startRpc.mock.calls[0][2]).toBe(f.other);
    expect((await readCodexSelection(f.options)).profileId).toBe(f.profileId);
    const unknown = fakeRpc();
    for (const id of [f.file, 'f'.repeat(20)]) {
      await expect(readLiveCodexCredential(id, { ...f.options, startRpc: unknown.startRpc, selection: { profiles: [{ id, home: f.home, available: true }] } })).rejects.toMatchObject({ code: 'unknown_profile' });
    }
    await rm(f.other, { recursive: true });
    await expect(readLiveCodexCredential(otherId, { ...f.options, startRpc: unknown.startRpc })).rejects.toThrow();
    expect(unknown.startRpc).not.toHaveBeenCalled();
  });

  it.each(['keyring', 'auto', 'ephemeral', 'unrecognized', 7])('refuses effective %s storage before account/read', async storeMode => {
    const f = await fixture({ storeMode });
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'unsupported_credentials_store' });
    expect(f.messages.some(m => m.method === 'account/read')).toBe(false);
    expect(f.rpc.stop).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { config: [] }])('fails closed when config/read has no usable config (%j)', async config => {
    const f = await fixture({ config });
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'unsupported_credentials_store' });
    expect(f.rpc.stop).toHaveBeenCalledOnce();
  });
  it.each([null, { type: 'apiKey' }, { type: 'chatgptAuthTokens', email: EMAIL }])('refuses nonmanaged ChatGPT native auth (%j)', async account => {
    const f = await fixture({ account });
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'unsupported_auth' });
    expect(f.rpc.stop).toHaveBeenCalledOnce();
  });
  it.each(['apiKey', undefined])('requires explicit chatgpt auth_mode, received %s', async mode => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify({ ...f.credential, auth_mode: mode }));
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'unsupported_auth' });
  });
  it('refuses an API key in the file even if its mode says chatgpt', async () => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify({ ...f.credential, OPENAI_API_KEY: 'fictional-file-key' }));
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'unsupported_auth' });
  });

  it('accepts case-compatible email and rejects another native identity', async () => {
    const f = await fixture({ account: { type: 'chatgpt', email: EMAIL.toUpperCase(), planType: 'plus' } });
    expect((await readLiveCodexCredential(f.profileId, f.options)).email).toBe(EMAIL);
    for (const account of [
      { type: 'chatgpt', email: 'other@example.invalid' }, { type: 'chatgpt', email: null },
      { type: 'chatgpt', email: EMAIL, accountId: 'other-workspace' },
    ]) {
      const fake = fakeRpc({ account });
      await expect(readLiveCodexCredential(f.profileId, { ...f.options, startRpc: fake.startRpc })).rejects.toMatchObject({ code: 'identity_mismatch' });
      expect(fake.rpc.stop).toHaveBeenCalledOnce();
    }
  });
  it.each([
    ['missing account', { account_id: null }, 'invalid_credentials'],
    ['different claim account', { id_token: jwt({ email: EMAIL, [authClaim]: { chatgpt_account_id: 'other-workspace' } }) }, 'identity_mismatch'],
    ['missing email', { id_token: jwt({ [authClaim]: { chatgpt_account_id: ACCOUNT } }) }, 'identity_mismatch'],
    ['malformed access JWT', { access_token: 'fictional-malformed-token' }, 'invalid_credentials'],
    ['missing expiry', { access_token: jwt({}) }, 'invalid_credentials'],
    ['string expiry', { access_token: jwt({ exp: '9999999999' }) }, 'invalid_credentials'],
    ['fractional expiry', { access_token: jwt({ exp: 9999999999.5 }) }, 'invalid_credentials'],
    ['expired access JWT', { access_token: jwt({ exp: 1 }) }, 'credential_expired'],
  ])('rejects %s', async (_label, patch, code) => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify({ ...f.credential, tokens: { ...f.credential.tokens, ...patch } }));
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code });
  });

  it.skipIf(process.platform === 'win32')('rejects unsafe POSIX permissions, special files, oversized auth and a foreign UID', async () => {
    const f = await fixture();
    await chmod(f.file, 0o644);
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
    await chmod(f.file, 0o600);
    await writeFile(f.file, ' '.repeat(1024 * 1024 + 1));
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
    await rm(f.file); await mkdir(f.file);
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
    await rm(f.file, { recursive: true });
    await writeFile(f.file, JSON.stringify(f.credential), { mode: 0o600 });
    vi.spyOn(process, 'getuid').mockReturnValue(Number((await lstat(f.file)).uid) + 1);
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
  });
  it.skipIf(process.platform !== 'win32')('rejects oversized or nonregular Windows auth files and a file with public read access', async () => {
    const f = await fixture();
    await writeFile(f.file, ' '.repeat(1024 * 1024 + 1));
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
    await rm(f.file); await mkdir(f.file);
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
    await rm(f.file, { recursive: true }); await writeFile(f.file, JSON.stringify(f.credential));
    await promisify(execFile)(win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [f.file, '/grant', '*S-1-1-0:R'], { timeout: 5000, windowsHide: true });
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
  });
  it.skipIf(process.platform !== 'win32')('refuses a Windows profile junction before starting native credential work', async () => {
    const f = await fixture(), alias = join(f.root, 'junction');
    await symlink(f.home, alias, 'junction');
    await expect(readLiveCodexCredential(f.profileId, { ...f.options, env: { ...f.options.env, CODEX_HOME: alias } })).rejects.toMatchObject({ code: 'credential_file_unsafe' });
    expect(f.startRpc).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')('refuses an auth symlink and a path replaced with a symlink after opening', async () => {
    const f = await fixture();
    const other = join(f.other, 'auth.json');
    await rename(f.file, other); await symlink(other, f.file);
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_unsafe' });
    await rm(f.file); await rename(other, f.file);
    hooks.afterOpen = async () => { await rename(f.file, other); await symlink(other, f.file); };
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_changed' });
  });
  it.skipIf(process.platform === 'win32')('refuses an in-place rewrite or atomic replacement during the read', async () => {
    for (const replace of [false, true]) {
      const f = await fixture();
      hooks.afterRead = async () => {
        const changed = JSON.stringify({ ...f.credential, extra: 'concurrent update' });
        if (replace) {
          const staged = join(f.home, 'replacement');
          await writeFile(staged, changed, { mode: 0o600 }); await rename(staged, f.file);
        } else await writeFile(f.file, changed);
      };
      await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'credential_file_changed' });
      expect(f.rpc.stop).toHaveBeenCalledOnce();
    }
  });

  it('refuses a profile selection changed by native work, including during shutdown', async () => {
    for (const during of ['onAccount', 'onStop']) {
      const f = await fixture();
      const fake = fakeRpc({ [during]: async () => {
        await selectCodexProfile({ id: await codexProfileId(f.other), expectedRevision: 0, operationId: 'concurrent-select' }, f.options);
      } });
      await expect(readLiveCodexCredential(f.profileId, { ...f.options, startRpc: fake.startRpc })).rejects.toMatchObject({ code: 'profile_changed' });
      expect(fake.rpc.stop).toHaveBeenCalledOnce();
    }
  });
  it.skipIf(process.platform === 'win32')('revalidates registry membership after reading the file', async () => {
    const f = await fixture();
    const added = await addCodexProfile({ operationId: 'temporary-profile' }, f.options);
    const state = await readCodexSelection(f.options);
    const home = state.profiles.find((p: { id: string }) => p.id === added.id)!.home;
    await writeFile(join(home, 'auth.json'), JSON.stringify(auth()), { mode: 0o600 });
    hooks.afterRead = async () => { await removeCodexProfile({ id: added.id, expectedRevision: state.revision }, f.options); };
    await expect(readLiveCodexCredential(added.id, f.options)).rejects.toMatchObject({ code: 'profile_changed' });
  });
  it.skipIf(process.platform === 'win32')('refuses a different directory substituted at the same registered path', async () => {
    const f = await fixture();
    hooks.afterRead = async () => {
      await rename(f.home, join(f.root, 'old-home'));
      await mkdir(f.home, { mode: 0o700 });
      await writeFile(f.file, JSON.stringify(f.credential), { mode: 0o600 });
    };
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'profile_changed' });
  });
  it.skipIf(process.platform === 'win32')('refuses a home symlink redirected during native work or after file read', async () => {
    for (const afterRead of [false, true]) {
      const f = await fixture();
      const alias = join(f.root, 'alias');
      await symlink(f.home, alias, 'dir');
      const swap = async () => { await rm(alias); await symlink(f.other, alias, 'dir'); };
      if (afterRead) hooks.afterRead = swap;
      const fake = fakeRpc(afterRead ? {} : { onAccount: swap });
      const options = { ...f.options, env: { ...f.options.env, CODEX_HOME: alias }, startRpc: fake.startRpc };
      await expect(readLiveCodexCredential(f.profileId, options)).rejects.toMatchObject({ code: 'profile_changed' });
      expect(fake.rpc.stop).toHaveBeenCalledOnce();
    }
  });

  it('sanitizes native startup, request, cleanup, registry and JSON failures without raw causes or logs', async () => {
    const f = await fixture();
    const raw = Object.assign(new Error(`fictional raw token ${f.credential.tokens.access_token} ${f.root}`), { code: 'RAW_PRIVATE_ERROR' });
    const logs = ['log', 'warn', 'error', 'debug'].map(key => vi.spyOn(console, key as 'log').mockImplementation(() => {}));
    const cases = [
      { ...f.options, startRpc: () => { throw raw; } },
      { ...f.options, startRpc: fakeRpc({ failAt: 'account/read', rawError: raw }).startRpc },
      { ...f.options, startRpc: fakeRpc({ onStop: async () => { throw raw; } }).startRpc },
    ];
    for (const options of cases) {
      const error = await readLiveCodexCredential(f.profileId, options).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('native_error');
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/fictional|RAW_PRIVATE_ERROR|eyJ|\//);
      expect(error.cause).toBeUndefined();
    }
    await writeFile(f.file, '{fictional-malformed-private-json');
    await expect(readLiveCodexCredential(f.profileId, f.options)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await mkdir(f.options.store); await writeFile(codexSelectionPath(f.options), '{fictional-malformed-registry');
    const error = await readLiveCodexCredential(f.profileId, f.options).catch((e: Error) => e);
    expect(error.code).toBe('profile_unavailable');
    expect(error.stack).toBe('Error: profile_unavailable');
    expect(logs.every(log => log.mock.calls.length === 0)).toBe(true);
  });
  it('stops only each reader’s owned RPC, on failure as well as success', async () => {
    const f = await fixture(), failing = fakeRpc({ failAt: 'initialize' });
    const unrelated = fakeRpc();
    const results = await Promise.allSettled([
      readLiveCodexCredential(f.profileId, f.options),
      readLiveCodexCredential(f.profileId, { ...f.options, startRpc: failing.startRpc }),
    ]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.rpc.stop).toHaveBeenCalledOnce(); expect(failing.rpc.stop).toHaveBeenCalledOnce();
    expect(unrelated.rpc.stop).not.toHaveBeenCalled();
  });
  it('bounds a stalled native request plus shutdown without retrying', async () => {
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture();
    const fake = fakeRpc({ onStop: async () => { await new Promise(resolve => setTimeout(resolve, 4000)); } });
    fake.rpc.request.mockImplementation(async method => {
      entered();
      if (method === 'initialize') return new Promise(() => {});
      throw new Error('Unexpected retry');
    });
    // Real filesystem resolution first; fake only the native wall-clock window.
    const startRpc = (...args: Parameters<typeof fake.startRpc>) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      return fake.startRpc(...args);
    };
    const pending = readLiveCodexCredential(f.profileId, { ...f.options, startRpc });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'native_timeout' });
    await reached;
    await vi.advanceTimersByTimeAsync(process.platform === 'win32' ? 16000 : 7000);
    await rejected;
    expect(fake.rpc.stop).toHaveBeenCalledOnce();
    expect(fake.rpc.request).toHaveBeenCalledOnce();
  });
  it('initiates owned shutdown even when an event-loop stall exhausts the budget', async () => {
    const f = await fixture();
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now');
    const startRpc = (...args: Parameters<typeof f.startRpc>) => {
      clock.mockReturnValue(now + (process.platform === 'win32' ? 17000 : 8000));
      return f.startRpc(...args);
    };
    await expect(readLiveCodexCredential(f.profileId, { ...f.options, startRpc })).rejects.toMatchObject({ code: 'native_timeout' });
    expect(f.rpc.request).not.toHaveBeenCalled();
    expect(f.rpc.stop).toHaveBeenCalledOnce();
  });
});
