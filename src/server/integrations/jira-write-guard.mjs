// Durable per-scope reservations. Only the small allowlisted record is stored.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { deckDataDir } from '../deck-home.mjs';
import { STORE_DIR } from './store.mjs';

const active = new Set();
const keyPattern = /^[A-Z][A-Z0-9_]{0,40}-[1-9]\d{0,11}$/;
const uuidPattern = /^[0-9a-f-]{36}$/;
const scope = record => createHash('sha256').update(JSON.stringify([record.connectionId, record.kind, record.kind === 'move' ? '' : record.issueKey])).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

export function createJiraWriteGuard({ dir = () => join(deckDataDir(), STORE_DIR, 'jira-write-guard') } = {}) {
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
    return names.some(name => name.startsWith(prefix) && alive(Number(name.slice(prefix.length))));
  }
  async function state(root, op) { return { ...op, state: await running(root, op) ? 'pending' : 'uncertain' }; }
  async function lock(root, op, fn) {
    const name = join(root, `ack-${scope(op)}`);
    let h;
    try { h = await open(name, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') return { ok: false }; throw e; }
    try { return await fn(); } finally { await h.close(); await unlink(name); }
  }
  return {
    async begin(input) {
      const { connectionId, kind } = input;
      if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 64 || !['comment', 'status', 'move'].includes(kind)) throw new Error('Invalid guard scope');
      const op = { connectionId, kind, ...(kind === 'move' ? { issueKeys: input.issueKeys } : { issueKey: input.issueKey }), operationId: randomUUID() };
      if (kind === 'move' ? !Array.isArray(op.issueKeys) || op.issueKeys.length < 1 || op.issueKeys.length > 50 || op.issueKeys.some(k => !keyPattern.test(k)) : !keyPattern.test(op.issueKey)) throw new Error('Invalid guard issue keys');
      const root = await prepare();
      const path = join(root, `${scope(op)}.json`);
      const marker = join(root, `running-${op.operationId}-${process.pid}`);
      const temp = join(root, `tmp-${op.operationId}`);
      let returned = false;
      active.add(op.operationId);
      try {
        const markerHandle = await open(marker, 'wx', 0o600); await markerHandle.close();
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
        if (!returned) { active.delete(op.operationId); await unlink(marker).catch(() => {}); }
      }
    },
    async finish(op, clear) {
      const root = await prepare();
      try {
        if (clear) await lock(root, op, async () => {
          const path = join(root, `${scope(op)}.json`);
          const current = await read(path);
          if (current?.operationId === op.operationId) { await unlink(path); await syncDir(root); }
          return { ok: true };
        });
      } finally {
        active.delete(op.operationId);
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
export const jiraWriteGuard = createJiraWriteGuard();
