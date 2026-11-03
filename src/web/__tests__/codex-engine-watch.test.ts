import { afterAll, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ccdeck-engine-watch-'));
const source = join(root, 'source'), target = join(root, 'target'), cwd = join(root, 'workspace');
vi.stubEnv('CODEX_HOME', source);
vi.stubEnv('CCDECK_HOME', join(root, 'store'));
vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
vi.stubEnv('CCDECK_CODEX_HOMES', JSON.stringify([target]));
for (const dir of [source, target, cwd]) await mkdir(dir);
// @ts-expect-error server ES module
const { startCodexWatcher, scanCodexNow, eventsSince } = await import('../../server/index.mjs');
// @ts-expect-error server ES module
const { transferCodexThread } = await import('../../server/codex-engine-adapter.mjs');
let timer: ReturnType<typeof setInterval>;
afterAll(async () => { clearInterval(timer); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('observes the continuation without replaying prompts or tools copied from the source account', async () => {
  timer = startCodexWatcher('');
  await scanCodexNow();
  const id = '12345678-1234-1234-1234-123456789abc';
  const now = new Date().toISOString();
  const day = join(source, 'sessions', ...now.slice(0, 10).split('-'));
  await mkdir(day, { recursive: true });
  const file = join(day, `rollout-${now.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  await writeFile(file,
    line({ type: 'session_meta', timestamp: now, payload: { id, cwd } }) +
    line({ type: 'event_msg', timestamp: now, payload: { type: 'user_message', message: 'original task' } }) +
    line({ type: 'response_item', timestamp: now, payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'old-tool' } }));
  await scanCodexNow();
  const copied = await transferCodexThread(source, target, id);
  await appendFile(copied, line({ type: 'event_msg', timestamp: now, payload: { type: 'user_message', message: 'continue task' } }));
  await scanCodexNow();
  const events = eventsSince(0).filter((e: { payload: { session_id: string } }) => e.payload.session_id === id);
  expect(events.filter((e: { payload: { prompt?: string } }) => e.payload.prompt === 'original task')).toHaveLength(1);
  expect(events.filter((e: { payload: { prompt?: string } }) => e.payload.prompt === 'continue task')).toHaveLength(1);
  expect(events.filter((e: { payload: { tool_use_id?: string } }) => e.payload.tool_use_id === 'old-tool')).toHaveLength(1);
  expect(events.filter((e: { payload: { hook_event_name: string } }) => e.payload.hook_event_name === 'SessionStart')).toHaveLength(1);
});
