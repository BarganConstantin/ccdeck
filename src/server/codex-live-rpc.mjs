// A control connection to the user's existing daemon. Closing it never stops
// that daemon or takes ownership of its conversations.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { pathLookup, spawnSpec } from './exec-spec.mjs';
import { inspectWindowsPrivateSocket, holdWindowsPrivatePath } from './codex-windows-private.mjs';
import { createCodexWindowsProxy } from './codex-windows-proxy.mjs';

export const liveError = code => Object.assign(new Error(code), { code });
const runFile = promisify(execFile);
const unmaterializedHistory = /^thread [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} is not materialized yet; thread\/turns\/list is unavailable before first user message$/i;
function rejection(method, error) {
  if (method === 'thread/turns/list' && error?.code === -32600 && unmaterializedHistory.test(error.message ?? '')) return liveError('native_thread_not_materialized');
  return liveError(error?.code === -32601 ? 'unsupported_protocol' : 'native_request_rejected');
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
  let result;
  try {
    const spec = spawnSpec(executable, ['app-server', 'daemon', 'version'], platform);
    const output = await (options.execFile ?? runFile)(spec.file, spec.args, { ...spec.opts, env, timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true });
    result = JSON.parse(output.stdout);
  } catch { throw liveError('native_unavailable'); }
  const equalPath = windows ? (a, b) => win32.toNamespacedPath(a).toLowerCase() === win32.toNamespacedPath(b).toLowerCase() : (a, b) => resolve(a) === b;
  if (result.status !== 'running' || !(windows ? win32.isAbsolute : isAbsolute)(result.socketPath ?? '') || !equalPath(result.socketPath, advertised)) throw liveError('native_not_running');
  const version = String(result.appServerVersion ?? result.managedCodexVersion ?? '');
  const v = version.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  if (!v || Number(v[1]) === 0 && Number(v[2]) < 166) throw liveError('unsupported_version');
  let socketPath, info, parent;
  if (windows) {
    try {
      const captured = await inspectWindowsPrivateSocket(advertised, { ...options.windowsPrivate, platform });
      return { home: canonical, socketPath: captured.path, version, generation: captured.generation, executable, transport: 'windows-proxy' };
    } catch { throw liveError('untrusted_native_socket'); }
  }
  try { socketPath = await realpath(advertised); info = await lstat(socketPath); parent = await stat(dirname(socketPath)); }
  catch { throw liveError('native_not_running'); }
  const uid = options.uid ?? process.getuid?.();
  if (!info.isSocket() || uid == null || info.uid !== uid || parent.uid !== uid || parent.mode & 0o022) throw liveError('untrusted_native_socket');
  return { home: canonical, socketPath, version, generation: `${info.dev}:${info.ino}:${info.ctimeMs}`, executable };
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
    const after = windows ? await inspectWindowsPrivateSocket(endpoint.socketPath, options.windowsPrivate) : await lstat(endpoint.socketPath);
    if ((windows ? after.generation : `${after.dev}:${after.ino}:${after.ctimeMs}`) !== endpoint.generation) throw liveError('native_endpoint_changed');
    if (guard && !guard.valid()) throw liveError('untrusted_native_socket');
    await rpc.request('initialize', { clientInfo: { name: 'ccdeck', title: 'ccdeck', version: '3.53.1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    return rpc;
  } catch (error) { rpc.close(); throw error; }
  finally { await guard?.release(); }
}
