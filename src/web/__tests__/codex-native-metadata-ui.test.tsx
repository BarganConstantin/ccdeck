import { afterEach, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';


vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });

it('distinguishes unavailable native inspection from signed out and marks limited quota', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => {
    if (url === '/api/codex-profiles') {
      return { profiles: [
        { id: 'p', label: 'Personal', active: true, available: true, authSource: 'native', signedIn: true, signedInFilePresent: true, identityVersion: 'p' },
        { id: 'w', label: 'Work', available: true, authSource: 'native', signedInFilePresent: true, metadataUnavailable: true, metadataReason: 'rpc_timeout', identityVersion: 'w' },
        { id: 's', label: 'Spare', available: true, authSource: 'native', signedIn: false, signedInFilePresent: true, identityVersion: 's' },
      ] };
    }
    // Only the default account has numbers, and only the ordinary limits.
    return url.includes('id=p')
      ? { ok: true, partial: true, identityVersion: 'p', fetchedAt: Date.now(), plan: 'plus', windows: [{ usedPercent: 25, seconds: 18000, resetAt: null }] }
      : { ok: false, reason: 'no_token' };
  } })));
  const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
  await flush();
  // The default account's open row: its bar and the limit it could not read.
  const bar = one(view.tree, el => typeof el.type === 'function' && 'lane' in el.props)!;
  expect((bar.props.lane as { pct: number; label: string })).toMatchObject({ pct: 25, label: '5h' });
  expect(textOf(view.tree)).toContain('ordinary limits only');
  // The others are folded until asked, and say what is wrong with each.
  expect(textOf(view.tree)).not.toContain('Login inspection unavailable');
  (one(view.tree, el => el.type === 'button' && textOf(el).startsWith('Other accounts'))!.props.onClick as () => void)();
  expect(textOf(view.tree)).toContain('Login inspection unavailable: rpc timeout');
  expect(textOf(view.tree)).toContain('Not signed in to Codex');
  expect(textOf(view.tree)).not.toContain('Login file found');
});
