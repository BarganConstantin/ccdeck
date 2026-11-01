import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';
import { isFold, openOthers, openMenuOf } from './codex-panel-helpers';

vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

const profiles = [
  { id: 'a'.repeat(20), label: 'Default Codex', active: true, signedInFilePresent: true, identityVersion: 'a' },
  { id: 'b'.repeat(20), label: 'Work', managed: true, active: false, signedInFilePresent: false, identityVersion: 'b' },
];

async function setup() {
  vi.useFakeTimers();
  const removes: unknown[] = [];
  let removed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/codex-profile-remove') {
      removes.push(JSON.parse(String(options?.body)));
      removed = true;
      return { ok: true, json: async () => ({ ok: true, revision: 4 }) };
    }
    if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ revision: 3, profiles: removed ? profiles.slice(0, 1) : profiles }) };
  }));
  const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
  await flush();
  openOthers(view);
  return { view, removes };
}

const removeItem = (view: { tree: unknown }) =>
  one(view.tree, el => el.type === 'button' && el.props.role === 'menuitem' && /^(Remove|Confirm)$/.test(textOf(el)));

describe('Remove, in a Codex account\'s menu', () => {
  it('is offered on an account the deck made and not on the one it did not', async () => {
    const { view } = await setup();
    openMenuOf(view, 'Default Codex');
    expect(removeItem(view)).toBeFalsy();
    openMenuOf(view, 'Work');
    expect(removeItem(view)).toBeTruthy();
  });

  it('asks twice, like Claude\'s: the first press arms it, the second removes it', async () => {
    const { view, removes } = await setup();
    openMenuOf(view, 'Work');
    expect(textOf(removeItem(view))).toBe('Remove');
    (removeItem(view)!.props.onClick as () => void)();
    await flush();
    expect(removes).toEqual([]);
    expect(textOf(removeItem(view))).toBe('Confirm');
    expect(String(removeItem(view)!.props.className)).toContain('armed');
    (removeItem(view)!.props.onClick as () => void)();
    await flush();
    expect(removes).toEqual([expect.objectContaining({ id: 'b'.repeat(20), expectedRevision: 3 })]);
    expect(textOf(view.tree)).toContain('Account removed');
    expect(one(view.tree, isFold)).toBeFalsy();
  });

  it('disarms by itself after four seconds, so a later press starts over', async () => {
    const { view, removes } = await setup();
    openMenuOf(view, 'Work');
    (removeItem(view)!.props.onClick as () => void)();
    expect(textOf(removeItem(view))).toBe('Confirm');
    await vi.advanceTimersByTimeAsync(4100);
    expect(textOf(removeItem(view))).toBe('Remove');
    expect(removes).toEqual([]);
  });
});
