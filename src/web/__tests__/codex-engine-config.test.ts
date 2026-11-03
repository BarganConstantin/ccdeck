import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error server ES module
import { captureSessionConfig, configHash } from '../../server/codex-engine-config.mjs';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('carries raw layer precedence without feeding effective display values back to Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-engine-config-')); roots.push(root);
  const text = 'model_reasoning_effort="high"\n';
  await writeFile(join(root, 'config.toml'), text);
  const rpc = { request: async () => ({
    config: { shell_environment_policy: { exclude: '' } },
    layers: [
      { config: { model_reasoning_effort: 'low' } },
      { config: { model_reasoning_effort: 'high', shell_environment_policy: { exclude: ['TOKEN'] } } },
      { config: { model_provider: 'other' }, disabledReason: 'untrusted' },
    ],
  }) };
  expect(await captureSessionConfig(rpc, root, root)).toEqual({
    sourceHash: configHash(text), originHash: configHash(text),
    overrides: { model_reasoning_effort: 'low', shell_environment_policy: { exclude: ['TOKEN'] } },
  });
  expect(await captureSessionConfig({ request: async () => ({}) }, root, root)).toBeNull();
});
it('refuses a configuration changed while native settings are being captured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-engine-config-race-')); roots.push(root);
  const rpc = { request: async () => { await writeFile(join(root, 'config.toml'), 'model="changed"'); return { layers: [] }; } };
  await expect(captureSessionConfig(rpc, root, root)).rejects.toThrow('changed during handoff');
});
