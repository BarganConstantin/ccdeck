import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error server ES module
import { acquireCodexLiveLease } from '../../server/codex-live-lease.mjs';
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
});
