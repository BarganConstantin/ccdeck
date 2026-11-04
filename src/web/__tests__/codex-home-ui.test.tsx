import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';
import { openOthers, openMenuOf, rowOf, rowText } from './codex-panel-helpers';

vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });

const A = 'a'.repeat(20), B = 'b'.repeat(20);
const both = [
  { id: A, label: 'Personal', active: true, signedInFilePresent: true, identityVersion: 'a' },
  { id: B, label: 'Work', managed: true, active: false, signedInFilePresent: true, identityVersion: 'b' },
];

async function setup(profiles = both, auto: Record<string, unknown> = {}) {
  const posts: unknown[] = [];
  let status = {
    ok: true, enabled: true, external: false, lastTick: null,
    settings: { 'autoswitch.threshold': { value: '90', isDefault: true } },
    choice: { next: 'room', home: null }, homeId: null, heldOut: [], ...auto,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/codex-auto' && options?.method === 'POST') {
      const body = JSON.parse(String(options.body));
      posts.push(body);
      if (body.action === 'home') status = { ...status, homeId: body.id };
      return { ok: true, json: async () => status };
    }
    if (url === '/api/codex-auto') return { ok: true, json: async () => status };
    if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ revision: 3, profiles }) };
  }));
  const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
  await flush();
  return { view, posts };
}

const homeItem = (view: { tree: unknown }) =>
  one(view.tree, el => el.type === 'button' && el.props.role === 'menuitem' && /home$/i.test(textOf(el)));

// Claude's home account, on the Codex side: a word in the ⋯ and a mark on the row.
describe('a home account, in the Codex column', () => {
  it('is set from an account\'s menu, and its row then carries the mark', async () => {
    const { view, posts } = await setup();
    openOthers(view);
    openMenuOf(view, 'Work');
    expect(textOf(homeItem(view))).toBe('Set as home');
    (homeItem(view)!.props.onClick as () => void)();
    await flush();
    expect(posts).toEqual([{ action: 'home', id: B }]);
    expect(rowOf(view, 'Work')!.props.home).toBe('Home · Auto-switch comes back here once it has room again');
    expect(rowOf(view, 'Personal')!.props.home).toBeNull();
    expect(rowText(rowOf(view, 'Work')!)).toContain('Home · Auto-switch comes back here once it has room again');
  });

  it('is removed from the same item, and says why it is passed over', async () => {
    const { view, posts } = await setup(both, { homeId: B, enabled: false, heldOut: [B] });
    openOthers(view);
    expect(rowOf(view, 'Work')!.props.home).toBe('Home · Auto-switch comes back here while it is on');
    openMenuOf(view, 'Work');
    expect(textOf(homeItem(view))).toBe('Remove home');
    (homeItem(view)!.props.onClick as () => void)();
    await flush();
    expect(posts).toEqual([{ action: 'home', id: null }]);
    expect(rowOf(view, 'Work')!.props.home).toBeNull();
  });
});
