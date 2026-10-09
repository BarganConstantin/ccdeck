import { afterEach, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';
vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

it('distinguishes unavailable native inspection from signed out and marks limited quota', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/codex-profiles'
    ? { profiles: [
      { id: 'a', label: 'Work', available: true, authSource: 'native', signedInFilePresent: true, metadataUnavailable: true, metadataReason: 'rpc_timeout', identityVersion: 'a' },
      { id: 'b', label: 'Personal', available: true, authSource: 'native', signedIn: false, signedInFilePresent: true, identityVersion: 'b' },
    ] }
    : { ok: true, partial: true, identityVersion: 'a', windows: [{ usedPercent: 25, seconds: 18000 }] } })));
  const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
  await flush();
  expect(textOf(view.tree)).toContain('Login inspection unavailable: rpc timeout');
  expect(textOf(view.tree)).toContain('Not signed in to Codex');
  expect(textOf(view.tree)).not.toContain('Login file found');
  const row = one(view.tree, el => el.type === 'li' && textOf(el).includes('Work'))!;
  const button = one(row, el => el.type === 'button' && textOf(el) === 'Check quota')!;
  (button.props.onClick as () => void)(); await flush();
  expect(textOf(view.tree)).toContain('Ordinary Codex limits only');
});
