import { afterAll, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmTempDir } from './rm-temp-dir';

const dir = mkdtempSync(join(tmpdir(), 'ccdeck-audit-codex-startup-'));
const keys = ['HOME', 'USERPROFILE', 'CCDECK_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.env.CCDECK_HOME = join(dir, 'deck');
process.env.CODEX_HOME = join(dir, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');

// @ts-expect-error server module
const { startToolAudit, toolAudit } = await import('../../server/tool-audit.mjs');
// @ts-expect-error server module
const { startCodexStartupDiscovery, stopCodexStartupDiscovery } = await import('../../server/codex-startup.mjs');
// @ts-expect-error server module
const { startCodexWatcher, scanCodexNow } = await import('../../server/codex-watch.mjs');
// @ts-expect-error server module
const { eventsSince } = await import('../../server/event-ring.mjs');
// @ts-expect-error server module
await import('../../server/event-pipeline.mjs');
let timer: ReturnType<typeof setInterval> | null = null;

afterAll(async () => {
  if (timer) clearInterval(timer);
  await stopCodexStartupDiscovery();
  await toolAudit()?.close();
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rmTempDir(dir);
});

it('restores the open thread without importing old tools, then measures each live call once using rollout time', async () => {
  const now = Date.now(), date = new Date(now).toISOString().slice(0, 10);
  const sid = '4f1a0c3e-0000-4000-8000-abcdef123457';
  const folder = join(process.env.CODEX_HOME!, 'sessions', ...date.split('-'));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `rollout-${date}T10-00-00-${sid}.jsonl`);
  const record = (type: string, at: number, payload: unknown) => ({ type, timestamp: new Date(at).toISOString(), payload });
  const call = (id: string, at: number) => record('response_item', at, {
    type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: 'git status --short' }),
  });
  const result = (id: string, at: number) => record('response_item', at, {
    type: 'function_call_output', call_id: id, output: 'Process exited with code 0',
  });
  const lines = (records: unknown[]) => records.map(value => JSON.stringify(value)).join('\n') + '\n';
  writeFileSync(file, lines([
    record('session_meta', now - 20000, { id: sid, cwd: dir }),
    record('event_msg', now - 19000, { type: 'task_started', turn_id: 'open-turn' }),
    call('historical-call', now - 18000), result('historical-call', now - 16000),
  ]));

  await startToolAudit();
  await startCodexStartupDiscovery('', true);
  timer = startCodexWatcher('');
  await scanCodexNow();
  expect(eventsSince(0).some((event: any) => event.payload.session_id === sid && event.payload.startup_discovery)).toBe(true);
  expect((await toolAudit().report({ provider: 'codex', days: 7 })).total).toBe(0);

  const receiptFloor = Date.now();
  appendFileSync(file, lines([call('live-call', now - 5000), result('live-call', now - 500)]));
  await scanCodexNow();
  await scanCodexNow();
  const report = await toolAudit().report({ provider: 'codex', days: 7 });
  expect(report).toMatchObject({ total: 1, completed: 1, duplicates: 0 });
  expect(report.rows[0]).toMatchObject({ operation: 'git status', calls: 1, medianMs: 4500 });
  const liveEvents = eventsSince(0).filter((event: any) => event.payload.tool_use_id === 'live-call');
  expect(liveEvents).toHaveLength(2);
  for (const event of liveEvents) expect(event.receivedAt).toBeGreaterThanOrEqual(receiptFloor);
}, 15000);
