// Owned app-server process. JSON-RPC stays in memory; no auth or conversation
// messages are written to logs. Internal calls cannot collide with TUI ids.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawnSpec } from './exec-spec.mjs';
import { killTree } from './exec-children.mjs';

export function startEngineRpc(executable, args, home, { env = process.env, onMessage = () => {}, onClose = () => {}, onState = () => {}, spawnChild = spawn, deadlineMs = 12_000 } = {}) {
  const spec = spawnSpec(executable, args);
  const child = spawnChild(spec.file, spec.args, { ...spec.opts, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, CODEX_HOME: home } });
  const kill = signal => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* already exited */ }
    }
    killTree(child, signal);
  };
  const pending = new Map();
  const prefix = `ccdeck-${randomUUID()}-`;
  let serial = 0, chunks = [], buffered = 0, invalid = false, closed = false, stopping, exitCode = null, forced = false;
  const ended = new Promise(resolve => {
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Codex connection closed.')); }
      pending.clear(); onClose(); resolve();
    };
    child.once('close', code => { exitCode = code; finish(); });
    child.once('error', finish);
  });
  child.stdin.on('error', () => {});
  function protocolError(reason) {
    invalid = true; chunks = []; buffered = 0;
    onState({ state: 'backend-protocol-error', reason }); kill('SIGTERM');
  }
  child.stdout.on('data', chunk => {
    if (invalid) return;
    // Plugin catalogs can contain large inline icons. Scan each incoming byte
    // once, instead of rescanning/copying an ever-growing partial JSON string.
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), stop = end < 0 ? chunk.length : end;
      const part = chunk.subarray(offset, stop);
      buffered += part.length;
      if (buffered > 64 * 1024 * 1024) { protocolError('size'); return; }
      chunks.push(part);
      if (end < 0) return;
      const line = Buffer.concat(chunks, buffered).toString('utf8');
      chunks = []; buffered = 0; offset = end + 1;
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { protocolError('json'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { protocolError('envelope'); return; }
      const call = pending.get(message.id);
      if (call && !message.method) {
        clearTimeout(call.timer); pending.delete(message.id);
        if (message.error) call.reject(new Error('Codex rejected an engine request.'));
        else call.resolve(message.result);
      } else if (!(typeof message.id === 'string' && message.id.startsWith(prefix) && !message.method)) onMessage(message);
    }
  });
  function send(message) {
    if (closed || child.stdin.destroyed) throw new Error('Codex connection is unavailable.');
    // Bound both RPC requests and writes from a misbehaving local client.
    if (child.stdin.writableLength > 64 * 1024 * 1024) throw new Error('Codex request queue is full.');
    child.stdin.write(JSON.stringify(message) + '\n');
  }
  return {
    send,
    request(method, params) {
      if (pending.size >= 64) return Promise.reject(new Error('Codex request queue is full.'));
      const id = prefix + (++serial);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex request timed out; it was not retried.')); }, deadlineMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        child.stdin.end(); // EOF lets app-server flush the rollout before exit.
        const term = setTimeout(() => { forced = true; kill('SIGTERM'); }, 2000);
        const force = setTimeout(() => kill('SIGKILL'), 4000);
        try { await ended; return !forced && exitCode === 0; } finally { clearTimeout(term); clearTimeout(force); }
      })();
      return stopping;
    },
  };
}
