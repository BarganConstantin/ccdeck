// One host controls a daemon's externally managed authentication. The recovery
// mutex follows the same immutable-lock pattern as the account registry.
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { liveError } from './codex-live-rpc.mjs';
import { ensureWindowsPrivateDirectory, holdWindowsPrivatePath } from './codex-windows-private.mjs';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function record(file, options) {
  let guard;
  try {
    const windows = (options.platform ?? process.platform) === 'win32';
    if (windows) guard = await holdWindowsPrivatePath(file, { ...options.windowsPrivate, kind: 'file' });
    const info = await lstat(file);
    if (!info.isFile() || !windows && info.uid !== process.getuid?.() || info.size > 4096) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    const after = await lstat(file);
    if (guard && !guard.valid() || info.ino !== after.ino || info.dev !== after.dev || info.ctimeMs !== after.ctimeMs || info.size !== after.size) return null;
    return Number.isInteger(value.pid) && value.pid > 0 && typeof value.nonce === 'string' ? { ...value, ino: info.ino, dev: info.dev } : null;
  } catch { return null; }
  finally { await guard?.release(); }
}
const same = (a, b) => a && b && a.pid === b.pid && a.nonce === b.nonce && a.ino === b.ino && a.dev === b.dev;
export async function acquireCodexLiveLease(home, options = {}) {
  const key = createHash('sha256').update(home).digest('hex');
  const windows = (options.platform ?? process.platform) === 'win32';
  let dir = options.leaseDirectory ?? join(tmpdir(), `ccdeck-native-auth-${process.getuid?.() ?? 'user'}`), guard;
  if (windows) {
    try {
      dir = await ensureWindowsPrivateDirectory(dir, options.windowsPrivate);
      guard = await holdWindowsPrivatePath(dir, options.windowsPrivate);
    } catch { throw liveError('untrusted_control_directory'); }
  } else {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) throw liveError('untrusted_control_directory');
  }
  const file = join(dir, `${key}.lock`), nonce = randomUUID(), staged = `${file}.${nonce}.tmp`;
  try {
    const handle = await open(staged, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(staged, file); }
    catch (e) {
      if (e.code !== 'EEXIST') throw liveError('native_control_unavailable');
      const observed = await record(file, options);
      if (observed && !alive(observed.pid)) {
        const mutex = createServer(s => s.destroy());
        const locked = await new Promise(resolve => { mutex.once('error', () => resolve(false)); mutex.listen({ host: '127.0.0.1', port: 49152 + parseInt(key.slice(0, 4), 16) % 16384, exclusive: true }, () => resolve(true)); });
        if (locked) {
          try { const current = await record(file, options); if (same(observed, current) && !alive(current.pid)) await unlink(file); }
          finally { await new Promise(resolve => mutex.close(resolve)); }
        }
      }
      try { await link(staged, file); } catch { throw liveError('native_control_busy'); }
    }
    return {
      async valid() { const r = await record(file, options); return r?.pid === process.pid && r.nonce === nonce; },
      async release() { const r = await record(file, options); if (r?.pid === process.pid && r.nonce === nonce) await unlink(file).catch(() => {}); },
    };
  } finally { await unlink(staged).catch(() => {}); await guard?.release(); }
}
