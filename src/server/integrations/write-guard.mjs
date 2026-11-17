// Durable per-scope reservations, shared by every provider. Only the small
// allowlisted record the provider's scope builds is stored.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { integrationError } from './errors.mjs';
import { createTemp, renameWithRetry } from '../atomic-write.mjs';

const require = createRequire(import.meta.url);
let binding;
function nativeLock() {
  if (!binding) {
    // The exact dependency version pins this N-API layout and ABI. Loading the
    // shipped binding directly avoids its resolver's Node 20-only Array.with.
    // Keep this lazy so unsupported targets can still run the read-only deck.
    const root = dirname(require.resolve('fs-native-extensions/package.json'));
    binding = require(join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'fs-native-extensions.node'));
  }
  return binding;
}
const nativeLocks = {
  tryLock(fd) {
    try { nativeLock().tryLock(fd, 0, 0, true); return true; }
    catch (err) { if (err.code === 'EAGAIN') return false; throw err; }
  },
  unlock(fd) { nativeLock().unlock(fd, 0, 0); },
};
const active = new Set();
const listeners = new Map();
const uuidPattern = /^[0-9a-f-]{36}$/;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

// Ephemeral sockets identify live writers without trusting reusable PIDs.
// Scope synchronization uses OS file locks below, never a fixed TCP port.
function listen(port, handler = socket => socket.destroy()) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
const close = server => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
async function startMarker(op) {
  const token = randomUUID();
  let server;
  do {
    server = await listen(0, socket => {
      socket.setTimeout(1000, () => socket.destroy());
      socket.end(token);
    });
  } while (!server);
  server.unref();
  listeners.set(op.operationId, server);
  return { port: server.address().port, token };
}
async function stopMarker(op) {
  const server = listeners.get(op.operationId);
  if (server) { listeners.delete(op.operationId); await close(server); }
}
function markerAlive(marker) {
  return new Promise(resolve => {
    let data = '';
    let settled = false;
    const socket = createConnection({ host: '127.0.0.1', port: marker.port });
    const done = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    // Ambiguous failures are treated as live; never acknowledge on a timeout.
    socket.setTimeout(1000, () => done(true));
    socket.on('data', chunk => { data += chunk.toString(); if (data.length >= marker.token.length) done(data === marker.token); });
    socket.on('end', () => done(data === marker.token));
    socket.on('error', err => done(err.code !== 'ECONNREFUSED'));
  });
}

// The four outcomes a write can report. Failed is what a route says when the
// provider refused for certain; it never comes from a reservation.
export const WRITE_OUTCOMES = Object.freeze({ saving: 'saving', saved: 'saved', failed: 'failed', uncertain: 'uncertain' });
const outcomeOfRead = Object.freeze({ pending: WRITE_OUTCOMES.saving, confirmed: WRITE_OUTCOMES.saved, uncertain: WRITE_OUTCOMES.uncertain });
export const writeOutcome = record => outcomeOfRead[record?.state] ?? null;

// provider.record(input) validates the input and returns the stored record, or
// throws; provider.key(record) returns the string the scope hash is made from.
// list() and acknowledge() filter on connectionId, so every record must carry a
// top-level non-empty string connectionId.
export function createWriteGuard({ name, dir, locks = nativeLocks, scope: provider }) {
  const scope = record => createHash('sha256').update(provider.key(record)).digest('hex');
  async function prepare() {
    const root = dir();
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(root, 0o700);
    return root;
  }
  async function syncDir(root) {
    // Windows does not support opening directories for fsync.
    if (process.platform === 'win32') return;
    const h = await open(root, 'r'); try { await h.sync(); } finally { await h.close(); }
  }
  async function read(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function running(root, op) {
    if (active.has(op.operationId)) return true;
    const names = await readdir(root);
    const prefix = `running-${op.operationId}-`;
    for (const name of names.filter(name => name.startsWith(prefix))) {
      const marker = await read(join(root, name)).catch(err => {
        // Older releases used empty PID-only marker files. Preserve their
        // conservative behaviour while those processes may still be running.
        if (err instanceof SyntaxError) return null;
        throw err;
      });
      if (marker && Number.isInteger(marker.port) && marker.port > 0 && marker.port <= 65535 && typeof marker.token === 'string' && uuidPattern.test(marker.token)) {
        if (await markerAlive(marker)) return true;
      } else if (alive(Number(name.slice(prefix.length)))) return true;
    }
    return false;
  }
  async function state(root, op) { return { ...op, state: await running(root, op) ? 'pending' : op.state === 'confirmed' ? 'confirmed' : 'uncertain' }; }
  async function lock(root, op, fn) {
    // Keep the inode forever: unlinking/replacing a locked file would allow
    // two processes to lock different inodes for the same scope. The kernel
    // releases ownership on descriptor close or process death, not file age.
    const handle = await open(join(root, `lock-${scope(op)}`), 'a+', 0o600);
    let acquired = false;
    try {
      while (!(acquired = locks.tryLock(handle.fd))) await delay(10);
      return await fn();
    } finally {
      try { if (acquired) locks.unlock(handle.fd); }
      finally { await handle.close(); }
    }
  }
  return {
    async begin(input) {
      const op = { ...provider.record(input), operationId: randomUUID(), state: 'pending' };
      if (typeof op.connectionId !== 'string' || !op.connectionId) throw new Error('Invalid guard scope');
      const root = await prepare();
      // Check the actual filesystem and native support before any write.
      try { await lock(root, op, async () => {}); }
      catch { throw integrationError('unavailable', `${name} writes are unavailable because this system cannot safely coordinate them.`); }
      const path = join(root, `${scope(op)}.json`);
      const marker = join(root, `running-${op.operationId}-${process.pid}`);
      const temp = join(root, `tmp-${op.operationId}`);
      let returned = false;
      active.add(op.operationId);
      try {
        const identity = await startMarker(op);
        const markerHandle = await open(marker, 'wx', 0o600);
        try { await markerHandle.writeFile(JSON.stringify(identity)); } finally { await markerHandle.close(); }
        const h = await open(temp, 'wx', 0o600);
        try { await h.writeFile(JSON.stringify(op)); await h.sync(); } finally { await h.close(); }
        try { await link(temp, path); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const existing = await read(path);
          if (!existing) return await this.begin(input);
          return { conflict: await state(root, existing) };
        }
        await syncDir(root);
        returned = true;
        return { operation: { ...op, state: 'pending' } };
      } finally {
        await unlink(temp).catch(() => {});
        if (!returned) { active.delete(op.operationId); await stopMarker(op); await unlink(marker).catch(() => {}); }
      }
    },
    async finish(op, outcome) {
      const root = await prepare();
      try {
        if (outcome === true || outcome === 'confirmed') {
          const result = await lock(root, op, async () => {
            const path = join(root, `${scope(op)}.json`);
            const current = await read(path);
            if (current?.operationId !== op.operationId) return { ok: false };
            if (outcome === true) await unlink(path);
            else {
              const { tmp, handle } = await createTemp(path, { mode: 0o600 });
              try {
                try { await handle.writeFile(JSON.stringify({ ...current, state: 'confirmed' })); await handle.sync(); }
                finally { await handle.close(); }
                await renameWithRetry(tmp, path);
              } finally { await unlink(tmp).catch(() => {}); }
            }
            await syncDir(root);
            return { ok: true };
          });
          if (!result.ok) throw new Error(`${name} write guard could not finalize the operation`);
        }
      } finally {
        active.delete(op.operationId);
        await stopMarker(op);
        await unlink(join(root, `running-${op.operationId}-${process.pid}`)).catch(() => {});
      }
    },
    async list(connectionId) {
      const root = await prepare();
      const names = (await readdir(root)).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
      const records = await Promise.all(names.map(n => read(join(root, n))));
      return Promise.all(records.filter(x => x?.connectionId === connectionId).map(x => state(root, x)));
    },
    async acknowledge(connectionId, operationId) {
      if (typeof operationId !== 'string' || !uuidPattern.test(operationId)) return { ok: false };
      const root = await prepare();
      const op = (await this.list(connectionId)).find(x => x.operationId === operationId);
      if (!op) return { ok: false };
      return lock(root, op, async () => {
        const path = join(root, `${scope(op)}.json`);
        const current = await read(path);
        if (!current || current.operationId !== operationId) return { ok: false };
        if (await running(root, current)) return { conflict: await state(root, current) };
        await unlink(path); await syncDir(root);
        return { ok: true };
      });
    },
  };
}
