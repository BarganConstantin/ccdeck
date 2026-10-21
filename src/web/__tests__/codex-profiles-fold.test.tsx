import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';

vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

const profiles = [
  { id: 'a', label: 'personal@example.com · 917d8b06', identityVersion: 'a', active: true, signedInFilePresent: true },
  { id: 'b', label: 'work@example.com · 176e2d9e', identityVersion: 'b', active: false, signedInFilePresent: true },
];
const used: Record<string, number> = { a: 35, b: 1 };

function stubFetch() {
  const quotaReads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/codex-profiles') return { ok: true, json: async () => ({ revision: 1, profiles }) };
    const id = new URL(url, 'http://deck').searchParams.get('id')!;
    quotaReads.push(id);
    return { ok: true, json: async () => ({ ok: true, identityVersion: id, plan: 'pro', windows: [{ usedPercent: used[id], seconds: 604800, resetAt: 1793209822 }] }) };
  }));
  return quotaReads;
}

const fold = (tree: unknown) => one(tree, el => el.type === 'button' && el.props['aria-expanded'] !== undefined)!;

describe('Codex profiles fold', () => {
  it('reads every profile quota without a click and again each minute', async () => {
    vi.useFakeTimers();
    const quotaReads = stubFetch();
    const view = mount(() => CodexProfilesSection({ initiallyOpen: true })); cleanup = view.unmount;
    await flush(); await flush();
    expect(quotaReads.sort()).toEqual(['a', 'b']);
    expect(textOf(view.tree)).toContain('35% used');
    expect(textOf(view.tree)).toContain('resets');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quotaReads).toHaveLength(4);
  });

  it('keeps the last reading when a background refresh fails', async () => {
    vi.useFakeTimers();
    stubFetch();
    const view = mount(() => CodexProfilesSection({ initiallyOpen: false })); cleanup = view.unmount;
    await flush(); await flush();
    const working = (globalThis.fetch as ReturnType<typeof vi.fn>).getMockImplementation()!;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/codex-profile-quota')) throw new Error('offline');
      return working(url);
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(textOf(fold(view.tree))).toContain('personal 35% · work 1%');
  });

  it('starts closed with a summary of every account and opens on press', async () => {
    vi.useFakeTimers();
    stubFetch();
    const view = mount(() => CodexProfilesSection({ initiallyOpen: false })); cleanup = view.unmount;
    await flush(); await flush();
    expect(fold(view.tree).props['aria-expanded']).toBe(false);
    expect(textOf(fold(view.tree))).toContain('2 accounts · personal 35% · work 1%');
    expect(textOf(view.tree)).not.toContain('Check quota');
    (fold(view.tree).props.onClick as () => void)();
    await flush();
    expect(fold(view.tree).props['aria-expanded']).toBe(true);
    expect(textOf(view.tree)).toContain('Check quota');
  });
});
