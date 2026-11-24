import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error server ES module
import { acquireCodexLiveLease, codexLiveLeaseRecoveryPort } from '../../server/codex-live-lease.mjs';
const roots: string[] = [], leases: { release(): Promise<void> }[] = [];
afterEach(async () => { for (const lease of leases.splice(0)) await lease.release(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('shared native authentication ownership', () => {
  it('allows only one controller and never releases a replacement owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccd-lease-')); roots.push(root);
    const options = { leaseDirectory: process.platform === 'win32' ? join(root, 'private') : root };
    const first = await acquireCodexLiveLease(root, options); leases.push(first);
    await expect(acquireCodexLiveLease(root, options)).rejects.toThrow('native_control_busy');
    await first.release();
    const second = await acquireCodexLiveLease(root, options); leases.push(second);
    await first.release();
    expect(await second.valid()).toBe(true);
  }, 30000);
  it('recovers a controller lease after its owning process has exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccd-lease-crash-')); roots.push(root);
    const leaseDirectory = process.platform === 'win32' ? join(root, 'private') : root;
    const module = new URL('../../server/codex-live-lease.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import {acquireCodexLiveLease} from ${JSON.stringify(module)};await acquireCodexLiveLease(${JSON.stringify(root)},{leaseDirectory:${JSON.stringify(leaseDirectory)}});`], { stdio: 'pipe', timeout: 15000 });
    const recovered = await acquireCodexLiveLease(root, { leaseDirectory }); leases.push(recovered);
    expect(await recovered.valid()).toBe(true);
  }, 30000);
  it('takes its recovery port below every default ephemeral port range', () => {
    // Linux hands out client ports from 32768, macOS and Windows from 49152; a closed
    // client connection keeps its port in TIME-WAIT for a minute.
    for (let i = 0; i < 2000; i++) {
      const port = codexLiveLeaseRecoveryPort(join(tmpdir(), `codex-home-${i}`));
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(32768);
    }
  });
  it('waits for a recovery port that another socket holds for a moment', async () => {
    const { root, leaseDirectory } = await abandonedLease('ccd-lease-wait-');
    const holder = await occupy();
    const port = (holder.address() as { port: number }).port;
    setTimeout(() => holder.close(), 150);
    const recovered = await acquireCodexLiveLease(root, { leaseDirectory, recoveryPort: port }); leases.push(recovered);
    expect(await recovered.valid()).toBe(true);
  }, 30000);
  it('stays busy while another socket keeps the recovery port', async () => {
    const { root, leaseDirectory } = await abandonedLease('ccd-lease-held-');
    const holder = await occupy();
    try {
      const port = (holder.address() as { port: number }).port;
      await expect(acquireCodexLiveLease(root, { leaseDirectory, recoveryPort: port })).rejects.toThrow('native_control_busy');
    } finally { await new Promise(resolve => holder.close(resolve)); }
  }, 30000);
});
async function abandonedLease(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root);
  const leaseDirectory = process.platform === 'win32' ? join(root, 'private') : root;
  const module = new URL('../../server/codex-live-lease.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `import {acquireCodexLiveLease} from ${JSON.stringify(module)};await acquireCodexLiveLease(${JSON.stringify(root)},{leaseDirectory:${JSON.stringify(leaseDirectory)}});`], { stdio: 'pipe', timeout: 15000 });
  return { root, leaseDirectory };
}
function occupy(): Promise<Server> {
  return new Promise((resolve, reject) => { const server = createServer(s => s.destroy()); server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve(server)); });
}
