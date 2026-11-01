import { afterEach, expect, it, vi } from 'vitest';
import { mount, flush } from './fake-react';
import { openOthers, rowOf, rowText } from './codex-panel-helpers';


vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });

it('distinguishes a login that cannot be read from one that is signed out', async () => {
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
  // The default account's open row: its bar, read from the window Codex reports.
  expect((rowOf(view, 'Personal')!.props.a as { lanes: unknown[] }).lanes).toEqual([expect.objectContaining({ pct: 25, label: '5h', id: 'five_hour' })]);
  // The others are folded until asked, and say what is wrong with each.
  expect(rowOf(view, 'Work')).toBeFalsy();
  openOthers(view);
  // Nobody can say whether Work is signed in, so it is not told to sign in, and
  // a switch to it is still allowed; Spare is known to be signed out.
  const work = rowOf(view, 'Work')!;
  expect(rowText(work)).toContain('Temporary error');
  expect(rowText(work)).toContain('Switch');
  const spare = rowOf(view, 'Spare')!;
  expect(rowText(spare)).toContain('Not signed in');
  expect(rowText(spare)).toContain('Sign in');
  expect(rowText(spare)).not.toContain('Switch');
});
