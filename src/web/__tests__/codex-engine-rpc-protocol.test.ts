import { afterEach, describe, expect, it } from 'vitest';
import { execFile, type ExecFileException } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const moduleUrl = new URL('../../server/codex-engine-rpc.mjs', import.meta.url).href;

async function probe(frame: string, callback = 'record') {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-rpc-envelope-')); roots.push(root);
  const backend = join(root, 'backend.cjs'), owner = join(root, 'owner.mjs');
  // Wait for both requests, then emit the selected frame. EOF also ends the
  // backend when a crashing owner closes its pipe; no descendants are started.
  await writeFile(backend, String.raw`
    const frame = process.argv[2];
    let requests = 0;
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('close', () => process.exit(0));
    lines.on('line', line => {
      const message = JSON.parse(line);
      requests++;
      if (frame === 'valid') {
        if (requests === 1) console.log(JSON.stringify({ method: 'fixture/notification', params: { ready: true } }));
        console.log(JSON.stringify({ id: message.id, result: { method: message.method } }));
      } else if (requests === 2) {
        process.stdout.write(frame + '\n' + JSON.stringify({ method: 'after-invalid' }) + '\n');
      }
    });
  `);
  await writeFile(owner, String.raw`
    const [moduleUrl, backend, home, frame, callback] = process.argv.slice(2);
    const { startEngineRpc } = await import(moduleUrl);
    const states = [], messages = [];
    let closed = 0;
    const rpc = startEngineRpc(process.execPath, [backend, frame], home, {
      deadlineMs: 1500,
      onState: state => states.push(state),
      onClose: () => { closed++; },
      onMessage: message => {
        if (callback === 'throw') throw new Error('synthetic caller callback failure');
        messages.push(message);
      },
    });
    let outcomes, stopped;
    try {
      outcomes = (await Promise.allSettled([rpc.request('fixture/first', {}), rpc.request('fixture/second', {})]))
        .map(result => result.status === 'fulfilled' ? result : { status: result.status, message: result.reason.message });
    } finally { stopped = await rpc.stop(); }
    console.log(JSON.stringify({ states, messages, closed, outcomes, stopped }));
  `);
  // Catch a stream-handler crash outside the test runner. The deadline lives
  // in this parent, rather than in the process under test.
  return new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [owner, moduleUrl, backend, root, frame, callback], {
      timeout: 5_000, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

describe('owned engine RPC envelope failures', () => {
  it.each([
    ['malformed syntax', '{', 'json'],
    ['null', 'null', 'envelope'],
    ['array', '[]', 'envelope'],
    ['string', '"synthetic-private-payload"', 'envelope'],
    ['number', '23', 'envelope'],
    ['true', 'true', 'envelope'],
    ['false', 'false', 'envelope'],
  ])('isolates %s and rejects every pending request when the connection closes', async (_label, frame, reason) => {
    const result = await probe(frame);
    expect(result.error).toBeNull();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      states: [{ state: 'backend-protocol-error', reason }], messages: [], closed: 1,
      outcomes: [
        { status: 'rejected', message: 'Codex connection closed.' },
        { status: 'rejected', message: 'Codex connection closed.' },
      ], stopped: false,
    });
  }, 10_000);

  it('keeps valid responses and notifications working', async () => {
    const result = await probe('valid');
    expect(result.error).toBeNull();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      states: [], messages: [{ method: 'fixture/notification', params: { ready: true } }], closed: 1,
      outcomes: [
        { status: 'fulfilled', value: { method: 'fixture/first' } },
        { status: 'fulfilled', value: { method: 'fixture/second' } },
      ], stopped: true,
    });
  }, 10_000);

  it('does not turn a caller callback exception into a protocol error', async () => {
    const result = await probe('valid', 'throw');
    expect(result.error?.code).toBe(1);
    expect(result.error?.killed).toBe(false);
    expect(result.stderr).toContain('synthetic caller callback failure');
    expect(result.stdout).toBe('');
  }, 10_000);
});
