import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readNativeCodexAccount } from '../../server/codex-native-account.mjs';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const HOME = process.platform === 'win32' ? 'C:\\synthetic\\codex-home' : '/synthetic/codex-home';
const account = { type: 'chatgpt', email: 'person@example.com', planType: 'plus' };
const limits = { rateLimits: { limitId: 'codex', primary: { usedPercent: 130, windowDurationMins: 300, resetsAt: 12345 }, secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 23456 } } };
type Message = { id?: number; method?: string; params?: Record<string, unknown> };
type Child = EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
function fake(handler?: (message: Message, child: Child) => void) {
  const messages: Message[] = [], children: Child[] = [];
  const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => {
    const child = new EventEmitter() as Child;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString()); messages.push(message);
      queueMicrotask(() => {
        if (handler) handler(message, child);
        else if (message.id !== undefined) reply(child, message.id, message.method === 'initialize' ? {} : message.method === 'account/read' ? { account } : limits);
      });
      callback();
    } });
    children.push(child); return child;
  });
  const options = { spawn, executable: 'synthetic-codex', stat: async () => { throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); }, killChild: (child: Child) => child.kill(), env: { PATH: '/synthetic/bin' } };
  return { options, spawn, messages, children };
}
function reply(child: Child, id: number, result: unknown) { child.stdout.write(JSON.stringify({ id, result }) + '\n'); }

describe('native Codex account adapter (synthetic children only)', () => {
  it('initializes before account reads, reads quota, rechecks identity, and returns only allowlisted metadata', async () => {
    const f = fake((m, c) => {
      c.stderr.write('SECRET_TOKEN /private/home\n');
      if (m.id === undefined) return;
      reply(c, m.id, m.method === 'initialize' ? { accessToken: 'SECRET_TOKEN' } : m.method === 'account/read'
        ? { account: { ...account, accessToken: 'SECRET_TOKEN', refreshToken: 'SECRET_REFRESH' } } : { ...limits, secret: 'SECRET_TOKEN' });
    });
    const value = await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true });
    expect(value).toMatchObject({ ok: true, signedIn: true, label: 'person@example.com', plan: 'plus', windows: [
      { usedPercent: 130, seconds: 18000, resetAt: 12345 }, { usedPercent: 22, seconds: 604800, resetAt: 23456 },
    ] });
    expect(value.identityVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(f.messages.map(m => m.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read', 'initialize', 'initialized', 'account/read']);
    expect(f.messages[0].params).toEqual({ clientInfo: { name: 'ccdeck', version: '3.39.1' } });
    expect(f.messages.filter(m => m.method === 'account/read').every(m => m.params?.refreshToken === false)).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/SECRET|private\/home|synthetic/);
    expect(f.children).toHaveLength(2);
    expect(f.children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it('captures the exact home and environment once and strips ambient API keys', async () => {
    const f = fake();
    const env = { PATH: '/synthetic/bin', CODEX_HOME: '/wrong', OPENAI_API_KEY: 'SECRET', CODEX_API_KEY: 'SECRET2' };
    const promise = readNativeCodexAccount(HOME, { ...f.options, env });
    env.CODEX_HOME = '/changed'; await promise;
    const args = f.spawn.mock.calls[0][2] as { env: Record<string, string>; cwd: string; shell: boolean };
    expect(args.env.CODEX_HOME).toBe(HOME); expect(args.cwd).toBe(HOME); expect(args.shell).toBe(false);
    expect(args.env).not.toHaveProperty('OPENAI_API_KEY'); expect(args.env).not.toHaveProperty('CODEX_API_KEY');
  });

  it('does not mistake a metadata cache entry for quota; coalesces like requests and expires at 60 seconds', async () => {
    const f = fake(); let clock = 100000; const now = () => clock;
    const options = { ...f.options, now };
    const metadata = await readNativeCodexAccount(HOME, options);
    expect(metadata.windows).toEqual([]);
    const [a, b] = await Promise.all([readNativeCodexAccount(HOME, { ...options, includeQuota: true }), readNativeCodexAccount(HOME, { ...options, includeQuota: true })]);
    expect(a.windows).toHaveLength(2); expect(b).toEqual(a); expect(f.spawn).toHaveBeenCalledTimes(3);
    a.windows[0].usedPercent = 999;
    expect((await readNativeCodexAccount(HOME, { ...options, includeQuota: true })).windows[0].usedPercent).toBe(130);
    clock += 59999; await readNativeCodexAccount(HOME, options); expect(f.spawn).toHaveBeenCalledTimes(3);
    clock++; await readNativeCodexAccount(HOME, options); expect(f.spawn).toHaveBeenCalledTimes(4);
  });

  it('forced reads bypass settled quota and metadata caches while sharing active reads', async () => {
    let email = 'before@example.com';
    const f = fake((m, c) => {
      if (m.id !== undefined) reply(c, m.id, m.method === 'initialize' ? {} : m.method === 'account/read' ? { account: { ...account, email } } : limits);
    });
    await readNativeCodexAccount(HOME, f.options);
    await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true });
    email = 'after@example.com';
    const opts = { ...f.options, includeQuota: true, force: true };
    const [a, b] = await Promise.all([readNativeCodexAccount(HOME, opts), readNativeCodexAccount(HOME, opts)]);
    expect(a.label).toBe(email); expect(b.label).toBe(email);
    expect(f.spawn).toHaveBeenCalledTimes(5);
    expect((await readNativeCodexAccount(HOME, { ...f.options, force: true })).label).toBe(email);
    expect(f.spawn).toHaveBeenCalledTimes(6);
  });

  it('rejects a relogin visible only to the genuinely fresh verification process', async () => {
    const f = fake((m, c) => {
      if (m.id === undefined) return;
      const email = c === f.children[0] ? 'old@example.com' : 'new@example.com';
      reply(c, m.id, m.method === 'initialize' ? {} : m.method === 'account/read' ? { account: { ...account, email } } : limits);
    });
    // A settled metadata read must not satisfy the verification step either.
    await readNativeCodexAccount(HOME, f.options);
    f.children.splice(0); f.spawn.mockClear();
    expect(await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true })).toMatchObject({ ok: false, reason: 'profile_changed', windows: [] });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it('rejects a file replacement even when both native processes report the same email and plan', async () => {
    const { mkdtemp, writeFile, rm, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'ccdeck-native-relogin-'));
    try {
      await writeFile(join(home, 'auth.json'), 'synthetic original');
      const f = fake((m, c) => {
        if (m.id === undefined) return;
        const respond = () => reply(c, m.id!, m.method === 'initialize' ? {} : m.method === 'account/read' ? { account } : limits);
        if (m.method === 'account/rateLimits/read') void writeFile(join(home, 'auth.json'), 'synthetic replacement with different workspace').then(respond);
        else respond();
      });
      expect(await readNativeCodexAccount(home, { ...f.options, stat, includeQuota: true })).toMatchObject({ ok: false, reason: 'profile_changed', windows: [] });
      expect(f.spawn).toHaveBeenCalledTimes(2);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('does not publish quota when fresh-process verification fails', async () => {
    const f = fake((m, c) => {
      if (m.id === undefined) return;
      if (c !== f.children[0]) c.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601 } }) + '\n');
      else reply(c, m.id, m.method === 'initialize' ? {} : m.method === 'account/read' ? { account } : limits);
    });
    expect(await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true })).toMatchObject({ ok: false, reason: 'unsupported', windows: [] });
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps fresh verification inside the original deadline', async () => {
    vi.useFakeTimers();
    const f = fake((m, c) => {
      if (m.id === undefined || c !== f.children[0]) return;
      if (m.method === 'account/rateLimits/read') setTimeout(() => reply(c, m.id!, limits), 20);
      else reply(c, m.id, m.method === 'initialize' ? {} : { account });
    });
    const pending = readNativeCodexAccount(HOME, { ...f.options, includeQuota: true, deadlineMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout', windows: [] });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it('resolves relative PATH executables before changing the child cwd', async () => {
    const f = fake();
    await readNativeCodexAccount(HOME, { ...f.options, executable: undefined, pathLookup: () => './bin/codex' });
    const { resolve } = await import('node:path');
    expect(f.spawn.mock.calls[0][0]).toBe(resolve('./bin/codex'));
    expect(f.spawn.mock.calls[0][2]).toMatchObject({ cwd: HOME });
  });

  it('anchors a bare dot-PATH candidate to the lookup cwd', async () => {
    const f = fake();
    const lookup = vi.fn(() => 'codex');
    await readNativeCodexAccount(HOME, { ...f.options, executable: undefined, pathLookup: lookup, env: { PATH: '.' } });
    const { resolve } = await import('node:path');
    expect(lookup).toHaveBeenCalledWith('codex', process.platform, { pathEnv: '.' });
    expect(f.spawn.mock.calls[0][0]).toBe(resolve('codex'));
    expect(f.spawn.mock.calls[0][2]).toMatchObject({ cwd: HOME });
  });

  it('does not share cache or account state across homes', async () => {
    const f = fake();
    await readNativeCodexAccount(HOME, f.options);
    await readNativeCodexAccount(HOME + '-other', f.options);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects quota when account identity changes during the RPC', async () => {
    let reads = 0;
    const f = fake((m, c) => {
      if (m.id === undefined) return;
      reply(c, m.id, m.method === 'initialize' ? {} : m.method === 'account/read'
        ? { account: { ...account, email: ++reads === 1 ? 'before@example.com' : 'after@example.com' } } : limits);
    });
    expect(await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true })).toMatchObject({ ok: false, reason: 'profile_changed', windows: [] });
  });

  it('hashes a public account ID when returned and detects a same-email ID change', async () => {
    let reads = 0;
    const f = fake((m, c) => {
      if (m.id === undefined) return;
      reply(c, m.id, m.method === 'initialize' ? {} : m.method === 'account/read'
        ? { account: { ...account, id: ++reads === 1 ? 'workspace-a-private' : 'workspace-b-private' } } : limits);
    });
    const value = await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true });
    expect(value.reason).toBe('profile_changed'); expect(JSON.stringify(value)).not.toContain('workspace-');
    expect(value.label).toMatch(/person@example.com · [a-f0-9]{8}$/);
  });

  it('reports unauthenticated and API-key states without requesting quota or login', async () => {
    for (const nativeAccount of [null, { type: 'apiKey', apiKey: 'SECRET' }]) {
      const f = fake((m, c) => { if (m.id !== undefined) reply(c, m.id, m.method === 'initialize' ? {} : { account: nativeAccount }); });
      const value = await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true });
      expect(value.ok).toBe(true); expect(value.signedIn).toBe(nativeAccount !== null); expect(value.windows).toEqual([]);
      expect(f.messages.map(m => m.method)).toEqual(['initialize', 'initialized', 'account/read']);
      expect(JSON.stringify(value)).not.toContain('SECRET');
    }
  });

  it('prefers the Codex quota bucket and rejects negative/nonfinite percentages', async () => {
    const f = fake((m, c) => {
      if (m.id === undefined) return;
      reply(c, m.id, m.method === 'initialize' ? {} : m.method === 'account/read' ? { account } : {
        rateLimits: { limitId: 'other', primary: { usedPercent: 99 } },
        rateLimitsByLimitId: { codex: { primary: { usedPercent: -5 }, secondary: { usedPercent: 150, windowDurationMins: 60, resetsAt: null } } },
      });
    });
    expect((await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true })).windows).toEqual([{ usedPercent: 150, seconds: 3600, resetAt: null }]);
  });

  it('handles fragmented UTF-8 and ignores notifications', async () => {
    const f = fake((m, c) => {
      if (m.id === undefined) return;
      c.stdout.write('{"method":"account/updated","params":{"secret":"SECRET"}}\n');
      const bytes = Buffer.from(JSON.stringify({ id: m.id, result: m.method === 'initialize' ? {} : { account: { ...account, email: 'é@example.com' } } }) + '\n');
      const split = bytes.indexOf(Buffer.from('é')) + 1;
      c.stdout.write(bytes.subarray(0, split)); c.stdout.write(bytes.subarray(split));
    });
    expect((await readNativeCodexAccount(HOME, f.options)).label).toBe('é@example.com');
  });

  it('uses Windows PATH lookup and the shared shim quoting rules', async () => {
    const f = fake();
    const lookup = vi.fn(() => 'C:\\Program Files\\Codex\\codex.cmd');
    await readNativeCodexAccount('C:\\profiles\\work', { ...f.options, executable: undefined, pathLookup: lookup, platform: 'win32', env: { ...f.options.env, SystemRoot: 'C:\\Windows' } });
    expect(lookup).toHaveBeenCalledWith('codex', 'win32', { pathEnv: '/synthetic/bin' });
    expect(f.spawn.mock.calls[0][0]).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(f.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['/d', '/s', '/c']));
    expect(f.spawn.mock.calls[0][1][3]).toContain('C:\\Program Files\\Codex\\codex.cmd');
    expect(f.spawn.mock.calls[0][2]).toMatchObject({ windowsVerbatimArguments: true, shell: false });
  });

  it('returns safe CLI-absent and unsupported-version errors without raw stderr/errors', async () => {
    const missing = fake();
    expect(await readNativeCodexAccount(HOME, { ...missing.options, executable: undefined, pathLookup: () => null })).toMatchObject({ ok: false, reason: 'cli_unavailable' });
    expect(missing.spawn).not.toHaveBeenCalled();
    const unsupported = fake((m, c) => { if (m.id !== undefined) c.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'SECRET /private/path' } }) + '\n'); });
    const value = await readNativeCodexAccount(HOME, unsupported.options);
    expect(value).toMatchObject({ ok: false, reason: 'unsupported' }); expect(JSON.stringify(value)).not.toMatch(/SECRET|private/);
  });

  it('refuses server credential callbacks without supplying credentials', async () => {
    const f = fake((_m, c) => c.stdout.write('{"id":99,"method":"account/chatgptAuthTokens/refresh","params":{"previousAccountId":"SECRET"}}\n'));
    expect(await readNativeCodexAccount(HOME, f.options)).toMatchObject({ ok: false, reason: 'unsupported_auth' });
    expect(f.messages).toHaveLength(1);
  });

  it('kills timed-out children and rejects oversized or malformed output', async () => {
    vi.useFakeTimers();
    const hanging = fake(() => {});
    const waiting = readNativeCodexAccount(HOME, { ...hanging.options, deadlineMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await waiting).toMatchObject({ ok: false, reason: 'timeout' }); expect(hanging.children[0].kill).toHaveBeenCalledOnce();
    const oversized = fake((_m, c) => c.stdout.write('x'.repeat(65 * 1024)));
    expect(await readNativeCodexAccount(HOME, oversized.options)).toMatchObject({ ok: false, reason: 'output_limit' });
    const malformed = fake((_m, c) => c.stdout.write('not JSON SECRET\n'));
    expect(await readNativeCodexAccount(HOME, malformed.options)).toMatchObject({ ok: false, reason: 'protocol_error' });
  });

  it('bounds total notification output even when each individual line is small', async () => {
    const f = fake((_m, c) => {
      const notification = JSON.stringify({ method: 'ignored', params: { value: 'x'.repeat(100) } }) + '\n';
      for (let i = 0; i < 20; i++) c.stdout.write(notification);
    });
    expect(await readNativeCodexAccount(HOME, { ...f.options, maxOutputBytes: 1024 })).toMatchObject({ ok: false, reason: 'output_limit' });
    expect(f.children[0].kill).toHaveBeenCalledOnce();
  });

  it('discards quota when the follow-up account read is unsupported', async () => {
    let reads = 0;
    const f = fake((m, c) => {
      if (m.id === undefined) return;
      if (m.method === 'account/read' && ++reads === 2) {
        c.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'SECRET' } }) + '\n');
      } else reply(c, m.id, m.method === 'initialize' ? {} : m.method === 'account/read' ? { account } : limits);
    });
    expect(await readNativeCodexAccount(HOME, { ...f.options, includeQuota: true })).toMatchObject({ ok: false, reason: 'unsupported', windows: [] });
  });

  it('limits admitted in-flight reads to 64 rather than evicting active children', async () => {
    vi.useFakeTimers();
    const f = fake(() => {});
    const pending = Array.from({ length: 64 }, (_, i) => readNativeCodexAccount(HOME + '-' + i, { ...f.options, deadlineMs: 100 }));
    expect(await readNativeCodexAccount(HOME + '-overflow', { ...f.options, deadlineMs: 100 })).toMatchObject({ ok: false, reason: 'native_busy' });
    await vi.advanceTimersByTimeAsync(0); // allow the stat-only admission snapshot to finish
    expect(f.spawn).toHaveBeenCalledTimes(64);
    await vi.advanceTimersByTimeAsync(100); await Promise.all(pending);
    expect(f.children.every(c => c.kill.mock.calls.length === 1)).toBe(true);
  });
});
