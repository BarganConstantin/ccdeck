import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
// @ts-expect-error server ES module
import { resolveCodexLiveEndpoint, connectCodexLiveRpc } from '../../server/codex-live-rpc.mjs';
// Cross-UID chown needs privileges. Override only ownership for those cases;
// socket type, directory modes, paths and the WebSocket connection stay real.
const foreignOwners = vi.hoisted(() => new Map<string, number>());
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const info = await actual.lstat(...args);
    const owner = foreignOwners.get(String(args[0]));
    if (owner !== undefined) Object.defineProperty(info, 'uid', { value: owner });
    return info;
  } };
});
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { foreignOwners.clear(); for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture({ rejectedMethod = '', rejectedMessage = '', rejectedCode = -32600, sharedTemp = false } = {}) {
  // macOS's per-user tmpdir already has a private ancestor. Use /tmp for
  // exposure tests so chmod on our own fixture can actually remove that barrier.
  const root = await realpath(await mkdtemp(join(sharedTemp ? '/tmp' : tmpdir(), 'ccd-live-'))); roots.push(root);
  const home = join(root, 'h'), socketDirectory = join(root, 'socket'), socket = join(socketDirectory, 's');
  await mkdir(socketDirectory, { mode: 0o755 });
  await chmod(socketDirectory, 0o755); // Do not let the runner's umask add a barrier.
  await mkdir(join(home, 'app-server-control'), { recursive: true, mode: 0o700 });
  const advertised = join(home, 'app-server-control', 'app-server-control.sock');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const requests: any[] = [];
  wss.on('connection', ws => ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); requests.push(m);
    if (m.method === 'never-reply') return;
    if (m.method === rejectedMethod) { ws.send(JSON.stringify({ id: m.id, error: { code: rejectedCode, message: rejectedMessage } })); return; }
    if (m.id !== undefined) ws.send(JSON.stringify({ id: m.id, ...(m.method === 'reject' ? { error: { code: -32000, message: 'PRIVATE_NATIVE_ERROR' } } : { result: { ok: true } }) }));
  }));
  await new Promise<void>(resolve => server.listen(socket, resolve));
  await symlink(socket, advertised);
  cleanup.push(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); });
  const options = { executable: process.execPath, execFile: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: advertised, appServerVersion: '0.166.0' }) }) };
  return { root, home, socketDirectory, socket, advertised, options, requests, server, wss };
}
describe.skipIf(process.platform === 'win32')('existing native daemon connection', () => {
  it.each([0o777, 0o600])('rejects a traversable socket path with socket mode %i', async mode => {
    const f = await fixture({ sharedTemp: true });
    await chmod(f.root, 0o755);
    await chmod(f.socket, mode);
    await expect(resolveCodexLiveEndpoint(f.home, f.options)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
    expect(f.requests).toHaveLength(0);
  });
  it.each([0o710, 0o701])('does not mistake directory mode %i for an owner-only traversal barrier', async mode => {
    const f = await fixture({ sharedTemp: true });
    await chmod(f.root, mode);
    await chmod(f.socket, 0o777);
    await expect(resolveCodexLiveEndpoint(f.home, f.options)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
  });
  it.each(['parent', 'ancestor'])('accepts a permissive socket protected by an owner-private %s', async barrier => {
    const f = await fixture({ sharedTemp: true });
    await chmod(f.root, barrier === 'ancestor' ? 0o700 : 0o755);
    await chmod(f.socketDirectory, barrier === 'parent' ? 0o700 : 0o755);
    await chmod(f.socket, 0o777);
    const rpc = await connectCodexLiveRpc(await resolveCodexLiveEndpoint(f.home, f.options));
    try { expect(await rpc.request('account/read')).toEqual({ ok: true }); }
    finally { rpc.close(); }
  });
  it.each(['socket', 'parent', 'ancestor'])('rejects a %s owned by another non-root user', async entry => {
    const f = await fixture({ sharedTemp: true });
    foreignOwners.set(entry === 'socket' ? f.socket : entry === 'parent' ? f.socketDirectory : f.root, process.getuid!() + 1);
    await expect(resolveCodexLiveEndpoint(f.home, f.options)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
    expect(f.requests).toHaveLength(0);
  });
  it('accepts writable descendants when a trusted private ancestor prevents access', async () => {
    const f = await fixture({ sharedTemp: true });
    await chmod(f.socketDirectory, 0o777);
    await chmod(f.socket, 0o777);
    const rpc = await connectCodexLiveRpc(await resolveCodexLiveEndpoint(f.home, f.options));
    rpc.close();
  });
  it('rejects an ancestor that lets other users replace the private socket directory', async () => {
    const f = await fixture({ sharedTemp: true });
    await chmod(f.root, 0o777);
    await chmod(f.socketDirectory, 0o700);
    await expect(resolveCodexLiveEndpoint(f.home, f.options)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
  });
  it('accepts a private directory below a sticky shared ancestor', async () => {
    const f = await fixture({ sharedTemp: true });
    await chmod(f.root, 0o1777);
    await chmod(f.socketDirectory, 0o700);
    const rpc = await connectCodexLiveRpc(await resolveCodexLiveEndpoint(f.home, f.options));
    rpc.close();
  });
  it('rechecks ancestor permissions before opening a discovered socket', async () => {
    const f = await fixture({ sharedTemp: true });
    const endpoint = await resolveCodexLiveEndpoint(f.home, f.options);
    await chmod(f.root, 0o755);
    await chmod(f.socket, 0o777);
    await expect(connectCodexLiveRpc(endpoint)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
    expect(f.wss.clients.size).toBe(0);
    expect(f.requests).toHaveLength(0);
  });
  it('rechecks ancestor permissions after the handshake before sending RPC', async () => {
    const f = await fixture({ sharedTemp: true });
    const endpoint = await resolveCodexLiveEndpoint(f.home, f.options);
    f.server.prependListener('upgrade', () => chmodSync(f.root, 0o755));
    await expect(connectCodexLiveRpc(endpoint)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
    expect(f.requests).toHaveLength(0);
  });
  it('rejects a canonical ancestor replaced by a symlink after discovery', async () => {
    const f = await fixture({ sharedTemp: true });
    const endpoint = await resolveCodexLiveEndpoint(f.home, f.options);
    const moved = join(f.root, 'moved');
    await rename(f.socketDirectory, moved);
    await symlink(moved, f.socketDirectory);
    await expect(connectCodexLiveRpc(endpoint)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
    expect(f.requests).toHaveLength(0);
  });
  it.each([
    ['thread/turns/list', -32600, true], ['account/login/start', -32600, false], ['thread/turns/list', -32000, false],
  ])('classifies only the known empty-thread read error, method=%s code=%s', async (method, code, recognized) => {
    const rejectedMessage = 'thread 00000000-0000-0000-0000-000000000001 is not materialized yet; thread/turns/list is unavailable before first user message';
    const f = await fixture({ rejectedMethod: method as string, rejectedCode: code as number, rejectedMessage });
    const rpc = await connectCodexLiveRpc(await resolveCodexLiveEndpoint(f.home, f.options));
    try {
      await expect(rpc.request(method)).rejects.toMatchObject({ code: recognized ? 'native_thread_not_materialized' : 'native_request_rejected' });
    } finally { rpc.close(); }
  });
  it('connects only to the advertised owner-controlled Unix endpoint without owning the daemon', async () => {
    const f = await fixture();
    const endpoint = await resolveCodexLiveEndpoint(f.home, f.options);
    expect(endpoint.socketPath).toBe(f.socket);
    const rpc = await connectCodexLiveRpc(endpoint);
    expect(await rpc.request('account/read', { refreshToken: false })).toEqual({ ok: true });
    rpc.close();
    expect(f.server.listening).toBe(true);
    expect(f.requests.map(r => r.method)).toContain('initialized');
  });
  it('rejects untrusted endpoints and unsupported native versions before connecting', async () => {
    const f = await fixture();
    await expect(resolveCodexLiveEndpoint(f.home, { ...f.options, uid: process.getuid!() + 1 })).rejects.toMatchObject({ code: 'untrusted_native_socket' });
    await expect(resolveCodexLiveEndpoint(f.home, { ...f.options, execFile: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: f.advertised, appServerVersion: '0.165.0' }) }) })).rejects.toMatchObject({ code: 'unsupported_version' });
    await expect(resolveCodexLiveEndpoint(f.home, { ...f.options, execFile: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: join(f.root, 'different'), appServerVersion: '0.166.0' }) }) })).rejects.toMatchObject({ code: 'native_not_running' });
    expect(f.requests).toHaveLength(0);
  });
  it('sanitizes native errors and does not replay an ambiguous timed-out request', async () => {
    const f = await fixture(), endpoint = await resolveCodexLiveEndpoint(f.home, f.options);
    const rpc = await connectCodexLiveRpc(endpoint, { deadlineMs: 80 });
    try {
      await expect(rpc.request('reject')).rejects.toThrow('native_request_rejected');
      await expect(rpc.request('never-reply')).rejects.toThrow('native_request_timeout');
      expect(f.requests.filter(r => r.method === 'never-reply')).toHaveLength(1);
    } finally { rpc.close(); }
  });
});
