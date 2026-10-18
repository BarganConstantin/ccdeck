import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRadarConfig, updateRadarFlag } from '../../server/traffic-radar-config.mjs';
import { OPEN_MUTATIONS } from '../../server/request-gates.mjs';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'radar-flags-')); dirs.push(home);
  const dir = join(home, '.claude'); await mkdir(dir);
  const path = join(dir, 'settings.json');
  const options = { home, env: {}, platform: process.platform, readJson: async (file: string) => JSON.parse(await readFile(file, 'utf8')) };
  return { home, dir, path, options };
}
describe('Radar individual flag settings', () => {
  it('preserves hooks, credentials and other flags across concurrent changes', async () => {
    const { path, options } = await fixture();
    const original = { hooks: { Stop: [] }, env: { OTEL_EXPORTER_OTLP_HEADERS: 'secret', OTEL_LOG_USER_PROMPTS: '1' }, theme: 'dark' };
    await writeFile(path, JSON.stringify(original));
    await Promise.all([updateRadarFlag('OTEL_LOG_USER_PROMPTS', false, options), updateRadarFlag('OTEL_LOG_TOOL_DETAILS', true, options)]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...original, env: { ...original.env, OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_TOOL_DETAILS: '1' } });
    const config = await readRadarConfig(options);
    expect(config.variables.find((v: { key: string }) => v.key === 'OTEL_LOG_USER_PROMPTS')).toMatchObject({ value: 'Disabled', editable: true });
    expect(JSON.stringify(config)).not.toContain('secret');
  });
  it('rejects managed flags without rewriting the cached policy or user file', async () => {
    const { dir, path, options } = await fixture();
    await writeFile(path, '{}');
    const policy = '{"env":{"OTEL_LOG_USER_PROMPTS":"1"}}';
    await writeFile(join(dir, 'remote-settings.json'), policy);
    const config = await readRadarConfig(options);
    expect(config.variables[0]).toMatchObject({ editable: false });
    await expect(updateRadarFlag('OTEL_LOG_USER_PROMPTS', false, options)).rejects.toThrow('controlled');
    expect(await readFile(path, 'utf8')).toBe('{}');
    expect(await readFile(join(dir, 'remote-settings.json'), 'utf8')).toBe(policy);
  });
  it('refuses invalid settings and unsupported keys instead of overwriting them', async () => {
    const { path, options } = await fixture();
    await writeFile(path, '{broken');
    await expect(updateRadarFlag('OTEL_LOG_USER_PROMPTS', false, options)).rejects.toThrow('verified');
    expect(await readFile(path, 'utf8')).toBe('{broken');
    await expect(updateRadarFlag('OTEL_EXPORTER_OTLP_ENDPOINT', true, options)).rejects.toThrow('supported');
    await expect(updateRadarFlag('OTEL_LOG_USER_PROMPTS', '0', options)).rejects.toThrow('supported');
    await writeFile(path, '{"env":[]}');
    await expect(updateRadarFlag('OTEL_LOG_USER_PROMPTS', false, options)).rejects.toThrow('invalid env');
  });
  it('reads BOM-prefixed settings and preserves other fields when saving', async () => {
    const { path, options } = await fixture();
    await writeFile(path, '\uFEFF' + JSON.stringify({ hooks: { Stop: [] }, env: { OTEL_LOG_USER_PROMPTS: '1' } }));
    const boundedReader = { ...options, readJson: undefined };
    expect((await readRadarConfig(boundedReader)).sources[0].status).toBe('read');
    await updateRadarFlag('OTEL_LOG_USER_PROMPTS', false, boundedReader);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ hooks: { Stop: [] }, env: { OTEL_LOG_USER_PROMPTS: '0' } });
  });
  it('lists the flags no settings file names, and saves one into user settings', async () => {
    const { dir, path, options } = await fixture();
    await writeFile(path, JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: '0' } }));
    await writeFile(join(dir, 'remote-settings.json'), '{"env":{"ENABLE_ENHANCED_TELEMETRY_BETA":"1"}}');
    const config = await readRadarConfig(options);
    expect(config.unsetFlags).toEqual(['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_LOG_ASSISTANT_RESPONSES', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES', 'OTEL_LOG_MANAGED_SETTINGS']);
    const saved = await updateRadarFlag('OTEL_LOG_TOOL_CONTENT', true, options);
    expect(JSON.parse(await readFile(path, 'utf8')).env).toEqual({ OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_TOOL_CONTENT: '1' });
    expect(saved.config.unsetFlags).not.toContain('OTEL_LOG_TOOL_CONTENT');
    expect(saved.config.variables.find((v: { key: string }) => v.key === 'OTEL_LOG_TOOL_CONTENT')).toMatchObject({ source: 'User settings', value: 'Enabled', editable: true });
  });
  it('offers enhanced telemetry under one name when neither is set', async () => {
    const { path, options } = await fixture();
    await writeFile(path, '{}');
    const { unsetFlags } = await readRadarConfig(options);
    expect(unsetFlags).toContain('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA');
    expect(unsetFlags).not.toContain('ENABLE_ENHANCED_TELEMETRY_BETA');
  });
  it('uses CLAUDE_CONFIG_DIR and preserves symlinked settings', async () => {
    const { home, path, options } = await fixture();
    const actual = join(home, 'dotfiles.json'); await writeFile(actual, '{}'); await symlink(actual, path);
    await updateRadarFlag('CLAUDE_CODE_ENABLE_TELEMETRY', false, { ...options, env: { CLAUDE_CONFIG_DIR: join(home, '.claude') } });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(actual, 'utf8')).env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('0');
    expect(OPEN_MUTATIONS.has('/api/system/traffic-radar/configuration')).toBe(false);
  });
});
