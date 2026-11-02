// A control connection to the user's existing daemon. Closing it never stops
// that daemon or takes ownership of its conversations.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { pathLookup, spawnSpec } from './exec-spec.mjs';

export const liveError = code => Object.assign(new Error(code), { code });
const runFile = promisify(execFile);
const unmaterializedHistory = /^thread [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} is not materialized yet; thread\/turns\/list is unavailable before first user message$/i;
function rejection(method, error) {
  if (method === 'thread/turns/list' && error?.code === -32600 && unmaterializedHistory.test(error.message ?? '')) return liveError('native_thread_not_materialized');
  return liveError(error?.code === -32601 ? 'unsupported_protocol' : 'native_request_rejected');
}
export async function resolveCodexLiveEndpoint(home, options = {}) {
  if ((options.platform ?? process.platform) === 'win32') throw liveError('unsupported_platform');
  let canonical, advertised;
  try { canonical = await realpath(home); advertised = join(canonical, 'app-server-control', 'app-server-control.sock'); await lstat(advertised); }
  catch { throw liveError('native_not_running'); }
  const executable = options.executable ?? pathLookup('codex', process.platform, { pathEnv: (options.env ?? process.env).PATH ?? '' });
  if (!executable) throw liveError('cli_unavailable');
  const env = { ...(options.env ?? process.env), CODEX_HOME: canonical };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  let result;
  try {
    const spec = spawnSpec(executable, ['app-server', 'daemon', 'version']);
    const output = await (options.execFile ?? runFile)(spec.file, spec.args, { ...spec.opts, env, timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true });
    result = JSON.parse(output.stdout);
  } catch { throw liveError('native_unavailable'); }
  if (result.status !== 'running' || !isAbsolute(result.socketPath ?? '') || resolve(result.socketPath) !== advertised) throw liveError('native_not_running');
  const version = String(result.appServerVersion ?? result.managedCodexVersion ?? '');
  const v = version.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  if (!v || Number(v[1]) === 0 && Number(v[2]) < 166) throw liveError('unsupported_version');
  let socketPath, info, parent;
  try { socketPath = await realpath(advertised); info = await lstat(socketPath); parent = await stat(dirname(socketPath)); }
  catch { throw liveError('native_not_running'); }
  const uid = options.uid ?? process.getuid?.();
  if (!info.isSocket() || uid == null || info.uid !== uid || parent.uid !== uid || parent.mode & 0o022) throw liveError('untrusted_native_socket');
  return { home: canonical, socketPath, version, generation: `${info.dev}:${info.ino}:${info.ctimeMs}`, executable };
}

export async function connectCodexLiveRpc(endpoint, options = {}) {
  const ws = new WebSocket(`ws+unix://${endpoint.socketPath}:/`, { handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
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
        const timer = setTimeout(() => { pending.delete(id); reject(liveError('native_request_timeout')); }, options.deadlineMs ?? 7000);
        pending.set(id, { method, resolve: resolveCall, reject, timer });
        try { send({ id, method, ...(params === undefined ? {} : { params }) }); }
        catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
      });
    },
    close() { closing = true; rejectPending(); ws.close(); const timer = setTimeout(() => ws.terminate(), 500); timer.unref(); },
  };
  try {
    await new Promise((ready, reject) => { ws.once('open', ready); ws.once('error', () => reject(liveError('native_connection_failed'))); });
    const after = await lstat(endpoint.socketPath);
    if (`${after.dev}:${after.ino}:${after.ctimeMs}` !== endpoint.generation) throw liveError('native_endpoint_changed');
    await rpc.request('initialize', { clientInfo: { name: 'ccdeck', title: 'ccdeck', version: '3.53.1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}
