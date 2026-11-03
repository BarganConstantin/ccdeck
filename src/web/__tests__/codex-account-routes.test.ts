import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { ensureWindowsPrivateDirectory } from '../../server/codex-windows-private.mjs';

const root = await mkdtemp(join(tmpdir(), 'ccdeck-account-routes-'));
const original = join(root, 'codex');
if (process.platform === 'win32') await ensureWindowsPrivateDirectory(original);
else await mkdir(original);
await writeFile(join(original, 'auth.json'), '{}', { mode: 0o600 });
vi.stubEnv('CODEX_HOME', original);
vi.stubEnv('CCDECK_HOME', join(root, 'deck'));
vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
vi.stubEnv('AGENTS_DECK_NO_INSTALL', '1');
vi.stubEnv('AGENTS_DECK_NO_REPORTS', '1');
vi.stubEnv('AGENTS_DECK_NO_LAN', '1');
vi.mock('../../server/codex-native-account.mjs', () => ({ readNativeCodexAccount: async () => ({ ok: false, reason: 'no_token' }) }));
const { startServer, hookToken } = await import('../../server/index.mjs');
let server: Server, base: string;
beforeAll(async () => {
  server = await startServer({ port: 0, claude: false, codex: true, persist: null });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const headers = () => ({ 'x-ccdeck-token': hookToken(), 'Content-Type': 'application/json' });

describe('Codex account route boundary', () => {
  it('rejects unauthenticated and cross-site account mutations', async () => {
    const payload = JSON.stringify({ label: 'Work', operationId: 'unauthorized-add' });
    expect((await fetch(`${base}/api/codex-profile-add`, { method: 'POST', body: payload })).status).toBe(401);
    expect((await fetch(`${base}/api/codex-profile-add`, { method: 'POST', headers: { ...headers(), origin: 'https://attacker.example' }, body: payload })).status).toBe(403);
  });
  it('adds a profile, selects it with the roster revision, and refuses stale selections', async () => {
    const roster = await (await fetch(`${base}/api/codex-profiles`, { headers: headers() })).json();
    const created = await (await fetch(`${base}/api/codex-profile-add`, { method: 'POST', headers: headers(), body: JSON.stringify({ label: 'Work', operationId: 'route-add' }) })).json();
    expect(created.ok).toBe(true); expect(created.id).toMatch(/^[a-f0-9]{20}$/);
    expect(JSON.stringify(created)).not.toContain(root);
    const request = { id: created.id, expectedRevision: created.revision, operationId: 'route-select' };
    const switched = await (await fetch(`${base}/api/codex-profile-select`, { method: 'POST', headers: headers(), body: JSON.stringify(request) })).json();
    expect(switched).toMatchObject({ ok: true, status: 'requested_for_managed_sessions' });
    const replay = await (await fetch(`${base}/api/codex-profile-select`, { method: 'POST', headers: headers(), body: JSON.stringify(request) })).json();
    expect(replay.revision).toBe(switched.revision);
    const stale = await fetch(`${base}/api/codex-profile-select`, { method: 'POST', headers: headers(), body: JSON.stringify({ id: roster.profiles[0].id, expectedRevision: 0, operationId: 'route-stale' }) });
    expect(stale.status).toBe(409);
    const fresh = await (await fetch(`${base}/api/codex-profiles`, { headers: headers() })).json();
    expect(fresh.profiles.find((p: { active: boolean }) => p.active).id).toBe(created.id);
    expect(JSON.stringify(fresh)).not.toContain(root);
  });
  it('guards login and setup commands and rejects request-selected paths', async () => {
    expect((await fetch(`${base}/api/codex-terminal-command`)).status).toBe(401);
    expect((await fetch(`${base}/api/codex-profile-login?id=${encodeURIComponent(original)}`, { headers: headers() })).status).toBe(404);
    expect((await fetch(`${base}/api/codex-terminal-command?shell=fish`, { headers: headers() })).status).toBe(400);
    const setup = await (await fetch(`${base}/api/codex-terminal-command?shell=bash`, { headers: headers() })).json();
    expect(setup.command).toContain('install --shell bash');
  });
  it('guards manual sharing, supports script export/import and keeps credentials out of roster and errors', async () => {
    for (const path of ['/api/codex-accounts-share', '/api/codex-accounts-import']) {
      expect((await fetch(base + path, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await fetch(base + path, { method: 'POST', headers: { ...headers(), origin: 'https://attacker.example' }, body: '{}' })).status).toBe(403);
      expect((await fetch(base + path, { headers: headers() })).status).toBe(404);
    }
    const auth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fictional.id.signature', access_token: 'fictional-access', refresh_token: 'fictional-refresh' } };
    await writeFile(join(original, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
    const roster = await (await fetch(`${base}/api/codex-profiles`, { headers: headers() })).json();
    const originalId = roster.profiles[0].id;
    const sharedResponse = await fetch(`${base}/api/codex-accounts-share`, { method: 'POST', headers: headers(), body: JSON.stringify({ ids: [originalId] }) });
    expect(sharedResponse.headers.get('cache-control')).toBe('no-store');
    const shared = await sharedResponse.json();
    expect(shared).toMatchObject({ ok: true, count: 1, blob: expect.stringMatching(/^ccdeck-codex-v1\./) });
    expect(shared).not.toHaveProperty('expiresAt');
    const body = JSON.stringify({ blob: shared.blob, expectedRevision: roster.revision });
    const imported = await (await fetch(`${base}/api/codex-accounts-import`, { method: 'POST', headers: headers(), body })).json();
    expect(imported).toMatchObject({ ok: true, results: [{ status: 'imported' }] });
    expect(JSON.stringify(imported)).not.toContain(root);
    expect(JSON.stringify(imported)).not.toContain('fictional');
    const retry = await (await fetch(`${base}/api/codex-accounts-import`, { method: 'POST', headers: headers(), body })).json();
    expect(retry).toMatchObject({ ok: true, revision: imported.revision, results: [{ id: imported.results[0].id, status: 'already_imported' }] });
    const after = await (await fetch(`${base}/api/codex-profiles`, { headers: headers() })).json();
    expect(after.profiles.find((p: { active: boolean }) => p.active).id).toBe(roster.profiles.find((p: { active: boolean }) => p.active).id);
    expect(JSON.stringify(after)).not.toContain('fictional-refresh');
    expect(JSON.stringify(after)).not.toContain('fictional-access');
    expect(JSON.parse(await readFile(join(original, 'auth.json'), 'utf8'))).toEqual(auth);
    const invalid = await (await fetch(`${base}/api/codex-accounts-import`, { method: 'POST', headers: headers(), body: JSON.stringify({ blob: 'fictional-secret-invalid', expectedRevision: after.revision }) })).json();
    expect(invalid).toEqual({ ok: false, reason: 'invalid_share' });
    const pathInjection = await fetch(`${base}/api/codex-accounts-import`, { method: 'POST', headers: headers(), body: JSON.stringify({ blob: shared.blob, expectedRevision: after.revision, home: original }) });
    expect(await pathInjection.json()).toEqual({ ok: false, reason: 'bad_request' });
    expect((await fetch(`${base}/api/codex-accounts-import`, { method: 'POST', headers: headers(), body: JSON.stringify({ blob: 'x'.repeat(520000), expectedRevision: 0 }) })).status).toBe(413);
  });
});
