import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelCodexLogin, codexLoginState, parseDeviceLogin, resetCodexLogins, startCodexLogin } from '../../server/codex-login.mjs';
import { codexProfileId } from '../../server/codex-selection.mjs';

const roots: string[] = [];
afterEach(async () => {
  resetCodexLogins();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const DEVICE = `\u001b[1mWelcome to Codex\u001b[0m

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code (expires in 15 minutes)
   \u001b[94mRWV2-ZLB7A\u001b[0m
`;

/** A stand-in for the codex process: prints what it is told and ends when asked. */
function fakeCodex() {
  const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
  const children: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> })[] = [];
  const spawn = (command: string, args: string[], options: { env: Record<string, string> }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    calls.push({ command, args, env: options.env });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-login-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home);
  return { home, id: await codexProfileId(home), options: { env: { CODEX_HOME: home }, store: join(root, 'store') } };
}

describe('reading the device sign-in', () => {
  it('finds the link and the code through the colour codes', () => {
    expect(parseDeviceLogin(DEVICE)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'RWV2-ZLB7A' });
  });
  it('returns nothing for text that is not a sign-in, and never a link to another site', () => {
    expect(parseDeviceLogin('Starting…')).toEqual({ url: null, code: null });
    expect(parseDeviceLogin('open https://evil.example/codex/device with ABCD-EFGH1')).toEqual({ url: null, code: 'ABCD-EFGH1' });
  });
});

describe('signing a Codex profile in from the deck', () => {
  it('starts codex for that profile\'s own home and shows the link and code once printed', async () => {
    const { id, home, options } = await profile();
    const fake = fakeCodex();
    const started = await startCodexLogin(id, { ...options, spawn: fake.spawn });
    expect(started).toMatchObject({ ok: true, state: 'starting', url: null, code: null });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ command: 'codex', args: ['login', '--device-auth'] });
    expect(fake.calls[0].env.CODEX_HOME).toBe(home);
    fake.children[0].stdout.emit('data', Buffer.from(DEVICE));
    expect(codexLoginState(id)).toMatchObject({ state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'RWV2-ZLB7A' });
    fake.children[0].emit('close', 0);
    await vi.waitFor(() => expect(codexLoginState(id).state).toBe('done'));
  });

  it('starts one sign-in per profile: asking again while it waits returns the same one', async () => {
    const { id, options } = await profile();
    const fake = fakeCodex();
    await startCodexLogin(id, { ...options, spawn: fake.spawn });
    fake.children[0].stdout.emit('data', Buffer.from(DEVICE));
    expect(await startCodexLogin(id, { ...options, spawn: fake.spawn })).toMatchObject({ state: 'waiting', code: 'RWV2-ZLB7A' });
    expect(fake.calls).toHaveLength(1);
  });

  it('says so when codex is not installed, and when it ends without a code or without success', async () => {
    const { id, options } = await profile();
    const missing = fakeCodex();
    await startCodexLogin(id, { ...options, spawn: missing.spawn });
    missing.children[0].emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    expect(codexLoginState(id)).toMatchObject({ state: 'failed', reason: 'codex_missing' });

    const silent = fakeCodex();
    await startCodexLogin(id, { ...options, spawn: silent.spawn });
    silent.children[0].emit('close', 1);
    expect(codexLoginState(id)).toMatchObject({ state: 'failed', reason: 'no_code' });

    const refused = fakeCodex();
    await startCodexLogin(id, { ...options, spawn: refused.spawn });
    refused.children[0].stdout.emit('data', Buffer.from(DEVICE));
    refused.children[0].emit('close', 1);
    expect(codexLoginState(id)).toMatchObject({ state: 'failed', reason: 'login_failed' });
  });

  it('cancels a waiting sign-in by stopping the process, and a late close does not undo that', async () => {
    const { id, options } = await profile();
    const fake = fakeCodex();
    await startCodexLogin(id, { ...options, spawn: fake.spawn });
    fake.children[0].stdout.emit('data', Buffer.from(DEVICE));
    expect(cancelCodexLogin(id).state).toBe('cancelled');
    expect(fake.children[0].kill).toHaveBeenCalled();
    fake.children[0].emit('close', null);
    expect(codexLoginState(id).state).toBe('cancelled');
  });

  it('stops a sign-in nobody finished once the code has expired', async () => {
    vi.useFakeTimers();
    const { id, options } = await profile();
    const fake = fakeCodex();
    await startCodexLogin(id, { ...options, spawn: fake.spawn, lifetimeMs: 1000 });
    fake.children[0].stdout.emit('data', Buffer.from(DEVICE));
    await vi.advanceTimersByTimeAsync(1500);
    expect(codexLoginState(id)).toMatchObject({ state: 'expired', reason: 'code_expired' });
    expect(fake.children[0].kill).toHaveBeenCalled();
  });

  it('refuses a profile it does not know, and reports nothing for one never started', async () => {
    const { options, id } = await profile();
    expect(await startCodexLogin('f'.repeat(20), { ...options, spawn: fakeCodex().spawn })).toEqual({ ok: false, reason: 'unknown_profile' });
    expect(codexLoginState(id)).toMatchObject({ ok: true, state: 'idle' });
  });
});
