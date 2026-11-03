import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
// @ts-expect-error server ES module
import { connectCodexLiveRpc, resolveCodexLiveEndpoint } from '../../server/codex-live-rpc.mjs';
// @ts-expect-error server ES module
import { ensureWindowsPrivateDirectory } from '../../server/codex-windows-private.mjs';

const snapshots = vi.hoisted(() => new Map<string, string>());
vi.mock('../../server/codex-windows-private.mjs', async importOriginal => {
  const actual = await importOriginal<Record<string, any>>();
  return { ...actual,
    inspectWindowsPrivateSocket: async (path: string, options: any) => snapshots.has(path) ? { path, generation: snapshots.get(path) } : actual.inspectWindowsPrivateSocket(path, options),
    holdWindowsPrivatePath: async (path: string, options: any) => snapshots.has(path)
      ? { path, generation: snapshots.get(path), valid: () => true, release: options.guard.kill }
      : actual.holdWindowsPrivatePath(path, options),
  };
});

const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); snapshots.clear(); });
// Only the ACL helper is simulated. HTTP handshake/WebSocket framing, RPC and
// the byte relay run unchanged against an owned synthetic server and child.
function fakeGuard() {
  const guard = { kill: vi.fn() };
  return { guard, options: { guard } };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ccd-proxy-'))); roots.push(root);
  const socketPath = join(root, 'synthetic.sock'); await writeFile(socketPath, 'synthetic endpoint marker');
  const info = await lstat(socketPath);
  const endpoint = { home: root, socketPath, executable: process.execPath, transport: 'windows-proxy', generation: `${info.dev}:${info.ino}:${info.ctimeMs}` };
  snapshots.set(socketPath, endpoint.generation);
  const server = createServer(), wss = new WebSocketServer({ server }), requests: any[] = [];
  wss.on('connection', ws => ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); requests.push(m);
    if (m.method === 'never-reply') return;
    if (m.method === 'slow-reply') {
      const timer = setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, result: { ok: true } })); }, 7500);
      timer.unref(); return;
    }
    if (m.method === 'binary') { ws.send(Buffer.from('invalid')); return; }
    if (m.method === 'bad-json') { ws.send('{'); return; }
    if (m.id !== undefined) ws.send(JSON.stringify({ id: m.id, result: { ok: true } }));
  }));
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const port = (server.address() as { port: number }).port;
  const children: ReturnType<typeof spawn>[] = [];
  const spawnChild = vi.fn((_file: string, _args: string[], options: any) => {
    const script = `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit());s.on('error',()=>process.exit(1));`;
    const child = spawn(process.execPath, ['-e', script], options); children.push(child); return child;
  });
  cleanup.push(async () => {
    for (const child of children) child.kill();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(ready => wss.close(() => ready()));
    await new Promise<void>(ready => server.close(() => ready()));
  });
  return { root, endpoint, server, requests, spawnChild, ...fakeGuard() };
}

describe('Windows raw proxy WebSocket bridge (simulated ACL, real byte relay)', () => {
  it('performs HTTP/WebSocket framing over stdio, releases the setup guard and closes only its proxy', async () => {
    const f = await fixture();
    const rpc = await connectCodexLiveRpc(f.endpoint, { platform: 'linux', windowsPrivate: f.options, spawnChild: f.spawnChild,
      env: { PATH: process.env.PATH, OpenAI_Api_Key: 'fictional-secret', CODEX_API_KEY: 'fictional-secret' } });
    try {
      expect(f.guard.kill).toHaveBeenCalledOnce();
      expect(await rpc.request('account/read', { refreshToken: false })).toEqual({ ok: true });
      const [file, args, options] = f.spawnChild.mock.calls[0];
      expect(file).toBe(process.execPath);
      expect(args).toEqual(['app-server', 'proxy', '--sock', f.endpoint.socketPath]);
      expect(options.env).toEqual({ PATH: process.env.PATH, CODEX_HOME: f.root });
      expect(options).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    } finally { rpc.close(); }
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(f.server.listening).toBe(true);
    expect(f.requests.map(m => m.method)).toEqual(['initialize', 'initialized', 'account/read']);
  });
  it('enforces the same 32-call bound and never retries an ambiguous timeout', async () => {
    const f = await fixture();
    const rpc = await connectCodexLiveRpc(f.endpoint, { platform: 'linux', windowsPrivate: f.options, spawnChild: f.spawnChild, deadlineMs: 300 });
    try {
      const pending = Array.from({ length: 32 }, () => rpc.request('never-reply').catch((error: Error) => error));
      await expect(rpc.request('account/read')).rejects.toMatchObject({ code: 'native_busy' });
      expect((await Promise.all(pending)).every(error => error.code === 'native_request_timeout')).toBe(true);
      expect(f.requests.filter(m => m.method === 'never-reply')).toHaveLength(32);
    } finally { rpc.close(); }
  });
  it('accepts a slow Windows daemon response beyond the POSIX deadline without replaying the request', async () => {
    const f = await fixture();
    const rpc = await connectCodexLiveRpc(f.endpoint, { platform: 'linux', windowsPrivate: f.options, spawnChild: f.spawnChild });
    try {
      expect(await rpc.request('slow-reply')).toEqual({ ok: true });
      expect(f.requests.filter(m => m.method === 'slow-reply')).toHaveLength(1);
    } finally { rpc.close(); }
  }, 15000);
  it.each(['binary', 'bad-json'])('rejects %s frames and pending requests on disconnect', async method => {
    const f = await fixture();
    const rpc = await connectCodexLiveRpc(f.endpoint, { platform: 'linux', windowsPrivate: f.options, spawnChild: f.spawnChild });
    try { await expect(rpc.request(method)).rejects.toMatchObject({ code: 'native_disconnected' }); }
    finally { rpc.close(); }
  });
  it('does not initialize or send secrets after endpoint generation changes', async () => {
    const f = await fixture();
    await expect(connectCodexLiveRpc({ ...f.endpoint, generation: 'replaced' }, { platform: 'linux', windowsPrivate: f.options, spawnChild: f.spawnChild })).rejects.toMatchObject({ code: 'native_endpoint_changed' });
    expect(f.requests).toEqual([]); expect(f.guard.kill).toHaveBeenCalledOnce();
    expect(f.spawnChild).not.toHaveBeenCalled();
  });
  it('rechecks generation after the WebSocket handshake', async () => {
    const f = await fixture();
    f.server.on('upgrade', () => snapshots.set(f.endpoint.socketPath, 'replaced-during-connect'));
    await expect(connectCodexLiveRpc(f.endpoint, { platform: 'linux', windowsPrivate: f.options, spawnChild: f.spawnChild })).rejects.toMatchObject({ code: 'native_endpoint_changed' });
    expect(f.requests).toEqual([]); expect(f.guard.kill).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows native endpoint validation (synthetic endpoint)', () => {
  it('rejects an ordinary file masquerading as a socket and a noncanonical advertised path', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ccd-endpoint-'))); roots.push(root);
    const home = join(root, 'home'); await ensureWindowsPrivateDirectory(home);
    const dir = join(home, 'app-server-control'); await ensureWindowsPrivateDirectory(dir);
    const socketPath = join(dir, 'app-server-control.sock'); await writeFile(socketPath, 'synthetic rendezvous');
    const options = { executable: process.execPath, execFile: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath, appServerVersion: '0.166.0' }) }) };
    await expect(resolveCodexLiveEndpoint(home, options)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
    await expect(resolveCodexLiveEndpoint(home, { ...options, execFile: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: join(root, 'outside'), appServerVersion: '0.166.0' }) }) })).rejects.toMatchObject({ code: 'native_not_running' });
    await rm(dir, { recursive: true }); await mkdir(dir);
    await writeFile(socketPath, 'unprotected rendezvous');
    await expect(resolveCodexLiveEndpoint(home, options)).rejects.toMatchObject({ code: 'untrusted_native_socket' });
  }, 30000);
});
