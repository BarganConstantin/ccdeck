import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexProfileId } from '../../server/codex-selection.mjs';
import { fetchCodexQuota } from '../../server/codex-quota.mjs';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ccd-native-resets-')); roots.push(home);
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fictional-access', account_id: 'fictional-account' } }));
  const id = await codexProfileId(home);
  const selected = { home, profileId: id, revision: 1, selectionEnabled: true };
  const native = { ok: true, signedIn: true, label: 'fictional@example.invalid', identityVersion: 'native-a', plan: 'plus',
    fetchedAt: Date.now(), windows: [{ usedPercent: 100, seconds: 18000, resetAt: Date.now() / 1000 + 3600 }] };
  const credentialRead = vi.fn(async () => ({ profileId: id, email: native.label, accountId: 'fictional-account',
    accessToken: 'fictional-access', expiresAt: Date.now() + 3600000 }));
  const firstExpiry = new Date(Date.now() + 86400000).toISOString();
  const wire = vi.fn(async () => new Response(JSON.stringify({ available_count: 3, credits: [
    { status: 'available', expires_at: new Date(Date.now() + 172800000).toISOString() },
    { status: 'used', expires_at: new Date(Date.now() + 1000).toISOString() },
    { status: 'available', expires_at: firstExpiry },
  ] }), { status: 200 }));
  vi.stubGlobal('fetch', wire);
  const read = () => fetchCodexQuota({ enableNative: true, force: true, readSelection: async () => ({ ...selected }),
    nativeRead: async () => native, credentialRead });
  return { home, id, selected, native, credentialRead, wire, firstExpiry, read };
}

describe('reset inventory alongside native Codex limits', () => {
  it('restores the available count and nearest available expiry with the same profile bearer', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.read(), f.read()]);
    expect(a).toMatchObject({ ok: true, coverage: 'standard_limits', windows: [{ pct: 100 }],
      resetCredits: { availableCount: 3, nextExpiryAt: Date.parse(f.firstExpiry) } });
    expect(b.resetCredits).toEqual(a.resetCredits);
    expect(f.credentialRead).toHaveBeenCalledOnce();
    expect(f.credentialRead).toHaveBeenCalledWith(f.id, { refresh: false });
    expect(f.wire).toHaveBeenCalledOnce();
    const [url, options] = f.wire.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer fictional-access', 'ChatGPT-Account-ID': 'fictional-account' });
    expect(options.method).toBeUndefined(); // GET, never redemption
    expect(JSON.stringify(a)).not.toContain('fictional-access');
    f.native.stale = true;
    expect((await f.read()).resetCredits).toEqual(a.resetCredits);
    expect(f.wire).toHaveBeenCalledOnce();
  });

  it('keeps ordinary native limits when file credentials are unavailable or the optional endpoint fails', async () => {
    const f = await fixture();
    f.credentialRead.mockRejectedValueOnce(new Error('unsupported_credentials_store'));
    expect(await f.read()).toMatchObject({ ok: true, resetCredits: null });
    expect(f.wire).not.toHaveBeenCalled();
    const other = await fixture();
    other.wire.mockResolvedValueOnce(new Response('', { status: 403 }));
    expect(await other.read()).toMatchObject({ ok: true, resetCredits: null });
  });

  it('does not send another identity or reuse credits after a credentials-store change', async () => {
    const f = await fixture();
    await f.read();
    await writeFile(join(f.home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    f.credentialRead.mockRejectedValueOnce(new Error('unsupported_credentials_store'));
    expect((await f.read()).resetCredits).toBeNull();
    expect(f.wire).toHaveBeenCalledOnce();
    const other = await fixture();
    other.credentialRead.mockResolvedValueOnce({ profileId: other.id, email: 'other@example.invalid', accountId: 'another', accessToken: 'fictional-other', expiresAt: Date.now() + 3600000 });
    expect((await other.read()).resetCredits).toBeNull();
    expect(other.wire).not.toHaveBeenCalled();
  });

  it('discards credits when the login or selected revision changes during the request', async () => {
    const f = await fixture();
    f.wire.mockImplementationOnce(async () => {
      await writeFile(join(f.home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fictional-replacement' } }));
      return new Response(JSON.stringify({ available_count: 3 }));
    });
    expect((await f.read()).resetCredits).toBeNull();
    const other = await fixture();
    other.wire.mockImplementationOnce(async () => { other.selected.revision++; return new Response(JSON.stringify({ available_count: 3 })); });
    expect(await other.read()).toMatchObject({ ok: false, reason: 'profile_changed' });
  });
});
