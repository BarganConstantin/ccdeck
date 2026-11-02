// Preserve the live session's configuration through native RPC, without
// rewriting either account's config or putting settings/secrets in process argv.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export const configHash = text => createHash('sha256').update(text).digest('hex');
export const configText = home => readFile(join(home, 'config.toml'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
export const isCustomCodexConfig = text => /^\s*(?:model_provider|["']model_provider["'])\s*=\s*["'](?!openai["'])/m.test(text)
  || /^\s*(?:profile|["']profile["'])\s*=/m.test(text);
export function isTrustOnlyConfig(text) {
  let project = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (!/^\[projects\..+\]\s*(?:#.*)?$/.test(line)) return false;
      project = true;
    } else if (!project || !/^trust_level\s*=\s*["'](?:trusted|untrusted)["']\s*(?:#.*)?$/.test(line)) return false;
  }
  return true;
}
function merge(a, b) {
  for (const [key, value] of Object.entries(b ?? {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid config key.');
    a[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(a[key] && typeof a[key] === 'object' && !Array.isArray(a[key]) ? a[key] : {}, value) : value;
  }
  return a;
}
export async function captureSessionConfig(rpc, home, cwd) {
  const before = await configText(home);
  const result = await rpc.request('config/read', { includeLayers: true, ...(cwd ? { cwd } : {}) });
  if (!Array.isArray(result?.layers)) return null;
  const overrides = {};
  // Native ConfigReadResponse lists highest priority first.
  for (const layer of [...result.layers].reverse()) if (!layer.disabledReason && layer.config && typeof layer.config === 'object') merge(overrides, layer.config);
  // Only raw TOML layers round-trip as overrides. The effective config/read
  // view contains display values (for example empty policy arrays as strings)
  // that native thread/resume cannot parse back into configuration.
  if (await configText(home) !== before) throw new Error('Codex configuration changed during handoff.');
  return { overrides, sourceHash: configHash(before), originHash: configHash(before) };
}
