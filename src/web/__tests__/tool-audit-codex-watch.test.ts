import { afterAll, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmTempDir } from './rm-temp-dir';
const dir = mkdtempSync(join(tmpdir(), 'ccdeck-audit-codex-watch-'));
const keys = ['CCDECK_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
process.env.CCDECK_HOME = join(dir, 'deck');
process.env.CODEX_HOME = join(dir, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
// @ts-expect-error server module
const { startToolAudit, toolAudit } = await import('../../server/tool-audit.mjs');
// @ts-expect-error server module
const { startCodexWatcher, scanCodexNow } = await import('../../server/codex-watch.mjs');
// @ts-expect-error server module
await import('../../server/event-pipeline.mjs');
let timer: ReturnType<typeof setInterval> | null = null;
afterAll(async () => { if (timer) clearInterval(timer); await toolAudit()?.close();
  for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
  await rmTempDir(dir);
});
it('carries rollout timestamps through the real watcher into the audit while preserving receipt time on the canvas', async () => {
  await startToolAudit(); timer = startCodexWatcher(''); await scanCodexNow();
  const now = Date.now(), date = new Date(now).toISOString().slice(0, 10);
  const sid = '4f1a0c3e-0000-4000-8000-abcdef123456';
  const folder = join(process.env.CODEX_HOME!, 'sessions', ...date.split('-')); mkdirSync(folder, { recursive: true });
  const records = [
    { type: 'session_meta', timestamp: new Date(now).toISOString(), payload: { id: sid, cwd: dir } },
    { type: 'response_item', timestamp: new Date(now - 5000).toISOString(), payload: { type: 'function_call', name: 'exec_command', call_id: 'call-a', arguments: JSON.stringify({ cmd: 'git status --short' }) } },
    { type: 'response_item', timestamp: new Date(now - 500).toISOString(), payload: { type: 'function_call_output', call_id: 'call-a', output: 'Process exited with code 0' } },
  ];
  writeFileSync(join(folder, `rollout-${date}T10-00-00-${sid}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await scanCodexNow(); const r = await toolAudit().report({ provider: 'codex', days: 7 });
  expect(r.total).toBe(1); expect(r.rows[0].operation).toBe('git status'); expect(r.rows[0].medianMs).toBe(4500);
}, 15000);
