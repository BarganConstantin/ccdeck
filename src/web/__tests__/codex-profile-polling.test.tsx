import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';

vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function roster(active = 'a', revision = 0) {
  return { ok: true, json: async () => ({ revision, profiles: ['a', 'b'].map(id => ({
    id, label: id === 'a' ? 'Personal' : 'Work', active: id === active,
    identityVersion: id, signedInFilePresent: false,
  })) }) };
}

describe('Codex roster polling', () => {
  it('lets a roster slower than several poll intervals finish and resumes polling afterward', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof roster>>();
    const fetcher = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(roster());
    vi.stubGlobal('fetch', fetcher);
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve(roster()); await flush();
    expect(textOf(view.tree)).toContain('Personal');
    expect(textOf(view.tree)).not.toContain('Checking profiles');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'])('allows a selection refresh to supersede a pending poll and ignores its late %s', async outcome => {
    vi.useFakeTimers();
    const oldPoll = deferred<ReturnType<typeof roster>>();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/codex-profile-select') return { ok: true, json: async () => ({ ok: true }) };
      reads++;
      return reads === 2 ? oldPoll.promise : roster(reads > 2 ? 'b' : 'a', reads > 2 ? 1 : 0);
    }));
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    (one(view.tree, el => el.type === 'button' && textOf(el) === 'Use account')!.props.onClick as () => void)();
    await flush();
    expect(reads).toBe(3);
    expect(textOf(one(view.tree, el => el.type === 'li' && textOf(el).includes('Work')))).toContain('Default account');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(3); // the older poll is still pending
    if (outcome === 'success') oldPoll.resolve(roster('a'));
    else oldPoll.reject(new Error('old roster failed'));
    await flush();
    expect(textOf(view.tree)).not.toContain('Could not refresh');
    expect(textOf(one(view.tree, el => el.type === 'li' && textOf(el).includes('Work')))).toContain('Default account');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads).toBe(4);
  });

  it('aborts an explicit refresh and stops polling on unmount', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof roster>>();
    let reads = 0;
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/codex-profile-select') return { ok: true, json: async () => ({ ok: true }) };
      reads++;
      signal = options?.signal ?? undefined;
      return reads === 1 ? roster() : pending.promise;
    }));
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
    await flush();
    (one(view.tree, el => el.type === 'button' && textOf(el) === 'Use account')!.props.onClick as () => void)();
    await flush();
    expect(reads).toBe(2);
    expect(signal?.aborted).toBe(false);
    view.unmount(); cleanup = undefined;
    expect(signal?.aborted).toBe(true);
    pending.resolve(roster('b', 1)); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(2);
  });
});
