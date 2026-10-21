// Append-only, local metadata. Never stores raw command arguments or tool outputs.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { deckDataDir } from './deck-home.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { buildToolAuditReport } from './tool-audit-report.mjs';
import { auditOperations } from './tool-audit-operations.mjs';
const DAY = 86400000;
const digest = text => createHash('sha256').update(text).digest('hex');
const date = t => new Date(t).toISOString().slice(0, 10);
const validMeta = m => m?.v === 1 && /^[a-f0-9-]{36}$/.test(m.deviceId ?? '') && /^[a-f0-9-]{36}$/.test(m.epoch ?? '') && [30, 60, 90].includes(m.retentionDays) && Number.isFinite(m.startedAt);

export function createToolAudit({ dir, now = Date.now, runReport = workerReport } = {}) {
  let meta, readyPromise, serial = Promise.resolve(), pending = [], timer, storageOk = true, dropped = 0, reportFlight = null, prunedDay = null;
  const enqueue = fn => { const task = serial.then(fn); serial = task.catch(() => {}); return task; };
  const ready = () => readyPromise ??= (async () => {
    await mkdir(dir, { recursive: true });
    try { meta = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (meta && !validMeta(meta)) throw new Error('Unreadable tool history settings');
    if (!meta) { meta = { v: 1, deviceId: randomUUID(), epoch: randomUUID(), retentionDays: 90, startedAt: now() }; await saveMeta(); }
    await prune();
  })();
  const saveMeta = () => writeFileAtomic(join(dir, 'settings.json'), JSON.stringify(meta));
  const files = async () => (await readdir(dir)).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  const prune = async () => {
    const floor = date(now() - (meta.retentionDays - 1) * DAY);
    for (const file of await files()) if (file.slice(0, 10) < floor) await unlink(join(dir, file));
  };
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    await ready();
    if (prunedDay !== date(now())) { await prune(); prunedDay = date(now()); }
    const batch = pending.splice(0);
    if (!batch.length) return;
    const days = new Map();
    for (const row of batch) { const d = date(row.t); if (!days.has(d)) days.set(d, []); days.get(d).push(row); }
    for (const [d, rows] of days) {
      try {
        await appendFile(join(dir, `${d}.jsonl`), rows.map(row => JSON.stringify({ ...row, id: digest(`${meta.deviceId}|${meta.epoch}|${row.id}`) })).join('\n') + '\n', { mode: 0o600 });
        storageOk = true;
      } catch { storageOk = false; dropped += rows.length; }
    }
  };
  const inventory = async () => {
    await prune();
    const journal = await Promise.all((await files()).map(async name => ({ path: join(dir, name), size: (await stat(join(dir, name))).size })));
    return { journal, bytes: journal.reduce((n, f) => n + f.size, 0) + (await stat(join(dir, 'settings.json'))).size };
  };
  return {
    async start() { await ready(); },
    observe(raw, source, opts = {}) {
      if (opts.replay || !['hook', 'codex'].includes(source)) return;
      const kind = raw?.hook_event_name === 'PreToolUse' ? 'start' : ['PostToolUse', 'PostToolUseFailure'].includes(raw?.hook_event_name) ? 'end' : null;
      if (!kind || typeof raw.session_id !== 'string' || typeof raw.tool_use_id !== 'string' || raw.session_id.length > 256 || raw.tool_use_id.length > 256) return;
      const provider = raw.provider === 'codex' || source === 'codex' ? 'codex' : 'claude';
      const t = now();
      const clock = provider === 'codex' ? 'rollout' : 'hook';
      const at = provider === 'codex' ? opts.toolAuditAt : (opts.receivedAt ?? t);
      const measuredAt = Number.isFinite(at) && at >= t - 7 * DAY && at <= t + 60000 ? at : null;
      const row = { id: `${provider}|${raw.session_id}|${raw.tool_use_id}`, provider, kind, t, at: measuredAt, clock };
      if (kind === 'start') Object.assign(row, auditOperations(raw.tool_name, raw.tool_input));
      else row.failed = kind === 'end' && raw.hook_event_name === 'PostToolUseFailure';
      if (pending.length >= 25000) { dropped++; return; }
      pending.push(row);
      if (!timer) { timer = setTimeout(() => { void enqueue(flush).catch(() => { storageOk = false; }); }, 1000); timer.unref?.(); }
    },
    async status() { return enqueue(async () => { await flush(); const { bytes } = await inventory(); return { ok: true, ...meta, bytes, storageOk, dropped }; }); },
    async configure(retentionDays) {
      if (![30, 60, 90].includes(retentionDays)) throw new Error('Invalid retention');
      return enqueue(async () => { await flush(); const previous = meta.retentionDays; meta.retentionDays = retentionDays;
        try { await saveMeta(); } catch (e) { meta.retentionDays = previous; throw e; }
        await prune(); return { ok: true }; });
    },
    async clear() { return enqueue(async () => {
      await flush();
      for (const name of await files()) await unlink(join(dir, name));
      meta = { ...meta, epoch: randomUUID(), startedAt: now() }; await saveMeta(); dropped = 0; storageOk = true;
      return { ok: true };
    }); },
    async report(query, signal) {
      if (reportFlight) return { ok: false, reason: 'busy' };
      reportFlight = (async () => {
        const snapshot = await enqueue(async () => { await flush(); const inv = await inventory(); return { ...inv, meta: { ...meta }, storageOk, dropped }; });
        const result = await runReport({ files: snapshot.journal, query, now: now(), meta: snapshot.meta }, signal);
        if (meta.epoch !== snapshot.meta.epoch) return { ok: false, reason: 'history_cleared' };
        return { ...result, bytes: snapshot.bytes, storageOk: snapshot.storageOk, dropped: snapshot.dropped, deviceId: snapshot.meta.deviceId, startedAt: snapshot.meta.startedAt, retentionDays: snapshot.meta.retentionDays };
      })();
      try { return await reportFlight; } finally { reportFlight = null; }
    },
    async close() { await enqueue(flush); },
  };
}
function workerReport(input, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Report cancelled'));
    // Serialize the already-loaded function so self-update cannot mix builds.
    const code = `const { parentPort, workerData } = require('node:worker_threads'); (${buildToolAuditReport.toString()})(workerData, { createReadStream: require('node:fs').createReadStream, createInterface: require('node:readline').createInterface }).then(result => parentPort.postMessage(result));`;
    const worker = new Worker(code, { eval: true, workerData: input, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { void worker.terminate(); finish(new Error('Report cancelled')); };
    const timeout = setTimeout(() => { void worker.terminate(); finish(new Error('Report timed out')); }, 60000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', result => finish(null, result));
    worker.once('error', e => finish(e));
    worker.once('exit', () => { if (!done) finish(new Error('Report worker ended without a result')); });
  });
}
let audit;
export async function startToolAudit() { audit ??= createToolAudit({ dir: join(deckDataDir(), 'tool-audit') }); await audit.start().catch(() => {}); }
export function noteToolAudit(raw, source, opts) { audit?.observe(raw, source, opts); }
export const toolAudit = () => audit;

/** Graceful launcher exit drains the batch; a wedged disk cannot hold shutdown. */
export async function drainToolAudit(ms = 3000) {
  if (!audit) return;
  let timer;
  try { await Promise.race([audit.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}
