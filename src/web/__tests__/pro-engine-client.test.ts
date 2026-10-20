import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, chmod, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// @ts-expect-error plain server module
import { createProEngineClient } from '../../server/pro-engine-client.mjs';
// @ts-expect-error plain server module
import { verifyEngineInstallation } from '../../server/pro-engine-install.mjs';
const roots: string[] = [], clients: any[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function installed(source?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'ccpro-client-')); roots.push(directory); await chmod(directory, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(`#!${process.execPath}\n` + (source ?? await readFile(new URL('./fixtures/pro-engine-peer.cjs', import.meta.url), 'utf8')));
  const executable = join(directory, 'ccdeck-pro-engine'); await writeFile(executable, bytes, { mode: 0o700 });
  const entry = { file: 'ccdeck-pro-engine', protocol: 1, target: `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, version: '0.1.0' };
  const payload = Buffer.from(JSON.stringify(entry));
  const manifest = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  const options = { enabled: true, directory, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), heartbeatMs: 60_000 };
  const client = createProEngineClient(options); clients.push(client);
  return { ...options, client, executable, manifest, entry, privateKey };
}
describe.skipIf(!['darwin', 'linux'].includes(process.platform))('optional native engine boundary', () => {
  it('does no path lookup or process launch while disabled', async () => {
    const client = createProEngineClient({ directory: '/nonexistent', publicKey: 'bogus' }); clients.push(client);
    expect(client.running).toBe(false); expect(client.capabilities).toBeUndefined();
    await expect(client.request('terminal.status')).rejects.toMatchObject({ code: 'disabled' });
  });
  it('rejects unknown methods without launching anything', async () => {
    const client = createProEngineClient({ enabled: true }); clients.push(client);
    await expect(client.request('shell.exec')).rejects.toMatchObject({ code: 'unknown_method' });
  });
  it('verifies signature and bytes before launch', async () => {
    const f = await installed(); expect((await verifyEngineInstallation(f)).digest).toBe(f.entry.sha256);
    await writeFile(f.executable, 'tampered'); await expect(f.client.start()).rejects.toThrow('could not be verified');
    expect(f.client.running).toBe(false);
  });
  it('rejects an untrusted manifest signature', async () => {
    const f = await installed(); const { publicKey } = generateKeyPairSync('ed25519');
    await expect(verifyEngineInstallation({ ...f, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) })).rejects.toThrow('could not be verified');
  });
  it('rejects writable executable or directory', async () => {
    const f = await installed(); await chmod(f.executable, 0o777);
    await expect(f.client.start()).rejects.toThrow('could not be verified');
    await chmod(f.executable, 0o700); await chmod(f.directory, 0o755);
    await expect(f.client.start()).rejects.toThrow('could not be verified');
  });
  it('rejects symbolic executable paths', async () => {
    const f = await installed(); const other = join(f.directory, 'actual'); await writeFile(other, await readFile(f.executable), { mode: 0o700 });
    await rm(f.executable); await symlink(other, f.executable);
    await expect(f.client.start()).rejects.toThrow('could not be verified');
  });
  it('refuses non-regular executable files without waiting for a writer', async () => {
    const f = await installed(); await rm(f.executable); execFileSync('/usr/bin/mkfifo', [f.executable]);
    await expect(f.client.start()).rejects.toThrow('could not be verified');
    expect(f.client.running).toBe(false);
  });
  it('uses one authenticated child for concurrent requests and fragmented replies', async () => {
    const f = await installed(); const result = await Promise.all(Array.from({ length: 24 }, (_, n) => f.client.request('terminal.echo', { n })));
    expect(new Set(result.map(r => r.pid)).size).toBe(1); expect(result.map(r => r.value.n)).toEqual(Array.from({ length: 24 }, (_, n) => n));
    expect(f.client.capabilities.terminal.launch).toBe(false);
  });
  it('bounds concurrent work and cancels active requests without losing the child', async () => {
    const f = await installed(); await f.client.start(); const controller = new AbortController();
    const work = Array.from({ length: 32 }, () => f.client.request('terminal.slow', {}, { signal: controller.signal }));
    const settled = Promise.allSettled(work); await delay(25);
    await expect(f.client.request('terminal.echo')).rejects.toMatchObject({ code: 'busy' });
    controller.abort(); expect((await settled).every(r => r.status === 'rejected')).toBe(true);
    await delay(50); expect((await f.client.request('terminal.echo', 'still here')).value).toBe('still here');
  });
  it('enforces deadlines and keeps request correlation after late replies', async () => {
    const f = await installed(); await expect(f.client.request('terminal.slow', {}, { timeoutMs: 25 })).rejects.toMatchObject({ code: 'timeout' });
    await delay(30); expect((await f.client.request('terminal.echo', { ok: true })).value.ok).toBe(true);
  });
  it('detects a crash, bounds restart frequency, and never replays a mutation', async () => {
    const f = await installed(); const before = await f.client.request('terminal.echo');
    await expect(f.client.request('terminal.crash')).rejects.toMatchObject({ code: 'exited' });
    await expect(f.client.request('terminal.echo')).rejects.toMatchObject({ code: 'backoff' });
    await delay(300); const after = await f.client.request('terminal.echo'); expect(after.pid).not.toBe(before.pid);
  });
  it('rejects oversized frames before allocating their body', async () => {
    const f = await installed(); await expect(f.client.request('terminal.badframe')).rejects.toMatchObject({ code: 'protocol' });
    expect(f.client.running).toBe(false);
  });
  it('rejects an incompatible authenticated handshake', async () => {
    const source = (await readFile(new URL('./fixtures/pro-engine-peer.cjs', import.meta.url), 'utf8')).replace('protocol: 1, target:', 'protocol: 2, target:');
    const f = await installed(source); await expect(f.client.start()).rejects.toMatchObject({ code: 'incompatible' });
    expect(f.client.running).toBe(false);
  });
  it('rejects wrong-target signed manifests and oversized requests', async () => {
    const f = await installed();
    await expect(f.client.request('terminal.echo', 'x'.repeat(2097152))).rejects.toMatchObject({ code: 'busy' });
    await f.client.close();
    const payload = Buffer.from(JSON.stringify({ ...f.entry, target: 'wrong-platform' }));
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, f.privateKey).toString('base64') }));
    await expect(verifyEngineInstallation(f)).rejects.toThrow('could not be verified');
  });
  it('handles child startup failure without leaked pending work', async () => {
    const f = await installed('process.exit(65);'); await expect(f.client.start()).rejects.toMatchObject({ code: 'exited' });
    expect(f.client.running).toBe(false);
  });
  it('refuses work after close and does not start a child for an aborted request', async () => {
    const f = await installed(); const controller = new AbortController(); controller.abort();
    await expect(f.client.request('terminal.echo', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.client.running).toBe(false); await f.client.close();
    await expect(f.client.request('terminal.echo')).rejects.toMatchObject({ code: 'closed' });
  });
});

it.runIf(process.platform === 'win32')('keeps Windows native installation gated until ACL validation', async () => {
  const client = createProEngineClient(); clients.push(client);
  await expect(client.start()).rejects.toMatchObject({ code: 'disabled' });
  await expect(verifyEngineInstallation({ directory: 'C:\\missing', publicKey: 'untrusted' })).rejects.toThrow('could not be verified');
});
