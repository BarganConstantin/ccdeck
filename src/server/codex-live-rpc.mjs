// A control connection to the user's existing daemon. Closing it never stops
// that daemon or takes ownership of its conversations.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { pathLookup, spawnSpec } from './exec-spec.mjs';
import { inspectWindowsPrivateSocket, holdWindowsPrivatePath } from './codex-windows-private.mjs';
import { createCodexWindowsProxy } from './codex-windows-proxy.mjs';
import { RUNNING_VERSION } from './running-version.mjs';

export const liveError = code => Object.assign(new Error(code), { code });
const runFile = promisify(execFile);

// Only this read-only probe is safe to replay. In particular, never retry a
// login or an interrupted turn whose outcome may already have committed.
export async function probeCodexLiveDaemon(executable, env, options = {}) {
  const spec = spawnSpec(executable, ['app-server', 'daemon', 'version'], options.platform ?? process.platform);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = await (options.execFile ?? runFile)(spec.file, spec.args,
        { ...spec.opts, env, timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true });
      return JSON.parse(output.stdout);
    } catch (error) {
      // Keep diagnostics fixed and credential-free, including native stderr.
      const failure = liveError('native_unavailable');
      failure.cause = liveError(error instanceof SyntaxError ? 'native_probe_invalid_response'
        : error.killed || error.code === 'ETIMEDOUT' ? 'native_probe_timeout' : 'native_probe_command_failed');
      // A missing executable cannot recover by waiting.
      if (attempt === 2 || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw failure;
      await delay(500);
    }
  }
}
const unmaterializedHistory = /^thread [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} is not materialized yet; thread\/turns\/list is unavailable before first user message$/i;
function rejection(method, error) {
  if (method === 'thread/turns/list' && error?.code === -32600 && unmaterializedHistory.test(error.message ?? '')) return liveError('native_thread_not_materialized');
  return liveError(error?.code === -32601 ? 'unsupported_protocol' : 'native_request_rejected');
}

async function inspectPosixSocket(socketPath, uid = process.getuid?.()) {
  try {
    // Work with the resolved endpoint, never a newly substituted path alias.
    if (uid == null || await realpath(socketPath) !== socketPath) throw liveError('untrusted_native_socket');
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== uid) throw liveError('untrusted_native_socket');
    const ancestors = [];
    for (let path = dirname(socketPath);; path = dirname(path)) {
      const directory = await lstat(path);
      if (!directory.isDirectory() || directory.uid !== uid && directory.uid !== 0) throw liveError('untrusted_native_socket');
      ancestors.push(directory);
      if (dirname(path) === path) break;
    }
    let privateTraversal = false;
    for (const directory of ancestors.reverse()) {
      // A writable ancestor could replace even a private descendant. Sticky
      // shared directories (such as /tmp) protect our owner/root-owned entries.
      if (!privateTraversal && directory.mode & 0o022 && !(directory.mode & 0o1000)) throw liveError('untrusted_native_socket');
      if (directory.uid === uid && !(directory.mode & 0o011)) privateTraversal = true;
    }
    // Socket chmod alone does not prevent connections on all supported Unix
    // systems. Require an owner-private traversal barrier somewhere in the
    // actual path; a permissive socket/parent below that barrier is legitimate.
    if (!privateTraversal) throw liveError('untrusted_native_socket');
    return { generation: `${info.dev}:${info.ino}:${info.ctimeMs}` };
  } catch { throw liveError('untrusted_native_socket'); }
}

export async function resolveCodexLiveEndpoint(home, options = {}) {
  const platform = options.platform ?? process.platform, windows = platform === 'win32';
  let canonical, advertised;
  try { canonical = await realpath(home); advertised = join(canonical, 'app-server-control', 'app-server-control.sock'); if (!windows) await lstat(advertised); }
  catch { throw liveError('native_not_running'); }
  const executable = options.executable ?? pathLookup('codex', platform, { pathEnv: (options.env ?? process.env).PATH ?? (options.env ?? process.env).Path ?? '' });
  if (!executable) throw liveError('cli_unavailable');
  const env = { ...(options.env ?? process.env), CODEX_HOME: canonical };
  for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|CODEX_API_KEY)$/i.test(key)) delete env[key];
  const result = await probeCodexLiveDaemon(executable, env, { ...options, platform });
  const equalPath = windows ? (a, b) => win32.toNamespacedPath(a).toLowerCase() === win32.toNamespacedPath(b).toLowerCase() : (a, b) => resolve(a) === b;
  if (result.status !== 'running' || !(windows ? win32.isAbsolute : isAbsolute)(result.socketPath ?? '') || !equalPath(result.socketPath, advertised)) throw liveError('native_not_running');
  const version = String(result.appServerVersion ?? result.managedCodexVersion ?? '');
  const v = version.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  if (!v || Number(v[1]) === 0 && Number(v[2]) < 166) throw liveError('unsupported_version');
  let socketPath;
  if (windows) {
    try {
      const captured = await inspectWindowsPrivateSocket(advertised, { ...options.windowsPrivate, platform });
      return { home: canonical, socketPath: captured.path, version, generation: captured.generation, executable, transport: 'windows-proxy' };
    } catch { throw liveError('untrusted_native_socket'); }
  }
  try { socketPath = await realpath(advertised); }
  catch { throw liveError('native_not_running'); }
  const captured = await inspectPosixSocket(socketPath, options.uid);
  return { home: canonical, socketPath, version, generation: captured.generation, executable };
}

export async function connectCodexLiveRpc(endpoint, options = {}) {
  const windows = endpoint.transport === 'windows-proxy';
  let guard, proxy;
  if (windows) {
    try {
      guard = await holdWindowsPrivatePath(endpoint.socketPath, { ...options.windowsPrivate, kind: 'socket' });
      if (win32.toNamespacedPath(guard.path).toLowerCase() !== win32.toNamespacedPath(endpoint.socketPath).toLowerCase()) throw liveError('untrusted_native_socket');
      if (guard.generation !== endpoint.generation) throw liveError('native_endpoint_changed');
    } catch (error) { await guard?.release(); throw error.code === 'native_endpoint_changed' ? error : liveError('untrusted_native_socket'); }
  } else {
    const before = await inspectPosixSocket(endpoint.socketPath);
    if (before.generation !== endpoint.generation) throw liveError('native_endpoint_changed');
  }
  let ws;
  try {
    ws = new WebSocket(windows ? 'ws://localhost/' : `ws+unix://${endpoint.socketPath}:/`, {
      handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false,
      ...(windows ? { createConnection: () => { proxy = createCodexWindowsProxy(endpoint, options); return proxy; } } : {}),
    });
  } catch { await guard?.release(); proxy?.destroy(); throw liveError('native_connection_failed'); }
  const pending = new Map(), prefix = `ccdeck-live-${randomUUID()}-`;
  let serial = 0, closing = false;
  const rejectPending = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(liveError('native_disconnected')); }
    pending.clear();
  };
  ws.on('error', () => {});
  ws.on('close', () => { rejectPending(); if (!closing) options.onClose?.(); });
  const send = message => {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024 * 1024) throw liveError('native_disconnected');
    ws.send(JSON.stringify(message));
  };
  ws.on('message', (raw, binary) => {
    if (binary) { ws.close(1003); return; }
    let m;
    try { m = JSON.parse(raw.toString()); } catch { ws.close(1007); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { ws.close(1007); return; }
    const p = !m.method && pending.get(m.id);
    if (p) {
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(rejection(p.method, m.error));
      else p.resolve(m.result);
    } else if (m.method && m.id !== undefined) {
      // Unrelated approval/tool requests must remain with their own client.
      Promise.resolve().then(() => options.onRequest?.(m)).catch(() => {});
    } else if (m.method) options.onNotification?.(m);
  });
  const rpc = {
    send,
    request(method, params) {
      if (pending.size >= 32) return Promise.reject(liveError('native_busy'));
      const id = prefix + (++serial);
      return new Promise((resolveCall, reject) => {
        // The Windows raw proxy and a busy native daemon can exceed seven
        // seconds even for a history read. Keep a bounded wait, without replay.
        const timer = setTimeout(() => { pending.delete(id); reject(liveError('native_request_timeout')); }, options.deadlineMs ?? (windows ? 30000 : 7000));
        pending.set(id, { method, resolve: resolveCall, reject, timer });
        try { send({ id, method, ...(params === undefined ? {} : { params }) }); }
        catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
      });
    },
    close() { closing = true; rejectPending(); ws.close(); const timer = setTimeout(() => { ws.terminate(); proxy?.destroy(); }, 500); timer.unref(); },
  };
  try {
    await new Promise((ready, reject) => { ws.once('open', ready); ws.once('error', () => reject(liveError('native_connection_failed'))); });
    const after = windows ? await inspectWindowsPrivateSocket(endpoint.socketPath, options.windowsPrivate) : await inspectPosixSocket(endpoint.socketPath);
    if (after.generation !== endpoint.generation) throw liveError('native_endpoint_changed');
    if (guard && !guard.valid()) throw liveError('untrusted_native_socket');
    // The version this deck runs, not the one this line was written in: the
    // daemon logs it, and a fixed number told it 3.53.1 long after.
    await rpc.request('initialize', { clientInfo: { name: 'ccdeck', title: 'ccdeck', version: RUNNING_VERSION ?? '0.0.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    return rpc;
  } catch (error) { rpc.close(); throw error; }
  finally { await guard?.release(); }
}
