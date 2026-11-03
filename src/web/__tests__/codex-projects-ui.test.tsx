// A Codex row's ⋯ opens Claude's Projects report, read from Codex's own logs.
// These pin the three parts the web side adds: the one-read loader (no
// ccusage, whose prices are Claude's alone), the report's Codex words where
// Claude's speak of ccusage and of a tracking start, and the menu item that
// opens it with focus coming back to the row's ⋯.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, mount, one, textOf, flush } from './fake-react';
import { openMenuOf, openOthers } from './codex-panel-helpers';
import {
  INITIAL_LOAD, codexProjectsUrl, loadCodexProjects, projectsLoad, reportLoading,
  type Get, type ProjectsEvent, type ProjectsLoad,
} from '../account-projects-load';

vi.mock('react', async () => (await import('./fake-react')).react);
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
vi.mock('../components/use-modal-dismiss', () => ({ useModalDismiss: () => ({ current: null }), useScrimDismiss: () => ({}) }));
vi.mock('../copy-text', () => ({ copyText: vi.fn(async () => true) }));
const { default: AccountProjectsModal } = await import('../components/AccountProjectsModal');
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

type Answer = Awaited<ReturnType<Get>>;
const answer = (json: unknown, status = 200): Answer => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const MODEL = 'gpt-5.5';
const tokens = { i: 120_000, o: 8_000, cr: 100_000, cc: 0, c1h: 0, c5m: 0 };
const day = new Date().toISOString().slice(0, 10);
const report = (unattributed: Record<string, typeof tokens> | null = null) => ({
  ok: true, trackedSince: null, days: 7,
  projects: [{ path: '/home/someone/work/api', name: 'api', models: { [MODEL]: tokens } }],
  unattributed,
  daily: [{ day, projects: [{ path: '/home/someone/work/api', models: { [MODEL]: tokens } }], unattributed }],
});

/** Run the loader against a deck that answers `json` and fold what it sends. */
async function loaded(json: unknown, status = 200) {
  const urls: string[] = [];
  const get: Get = async url => { urls.push(url); return answer(json, status); };
  let state: ProjectsLoad<unknown> = INITIAL_LOAD;
  const dispatch = (e: ProjectsEvent<unknown>) => { state = projectsLoad(state, e); };
  dispatch({ type: 'start', gen: 1 });
  loadCodexProjects({ id: 'a'.repeat(20), days: 7, gen: 1, dispatch, get });
  await flush();
  return { urls, state };
}

describe('the Codex report loader', () => {
  it('asks the deck once, for this account and window, and never asks ccusage', async () => {
    const { urls, state } = await loaded(report());
    expect(urls).toEqual([codexProjectsUrl('a'.repeat(20), 7)]);
    expect(urls[0]).toBe(`/api/codex-profile-projects?id=${'a'.repeat(20)}&days=7`);
    expect(reportLoading(state)).toBe(false);
    // Nothing is said to be on its way: the dollars are pricing.ts's from the start.
    expect(state.report?.cost).toEqual({ phase: 'failed' });
    expect(state.report?.data).toMatchObject({ projects: [{ name: 'api' }] });
  });

  it('turns an account the deck no longer knows, or a failed read, into the report\'s error', async () => {
    for (const [json, status] of [[{ ok: false, reason: 'unknown_profile' }, 200], [{}, 500]] as const) {
      const { state } = await loaded(json, status);
      expect(state.report).toBeNull();
      expect(state.error).toBeTruthy();
    }
  });

  it('lets no window\'s late answer land on the window that replaced it', async () => {
    const held: Array<(a: Answer) => void> = [];
    const get: Get = () => new Promise(resolve => { held.push(resolve); });
    let state: ProjectsLoad<unknown> = INITIAL_LOAD;
    const dispatch = (e: ProjectsEvent<unknown>) => { state = projectsLoad(state, e); };
    dispatch({ type: 'start', gen: 1 });
    loadCodexProjects({ id: 'a'.repeat(20), days: 1, gen: 1, dispatch, get });
    dispatch({ type: 'start', gen: 2 });
    loadCodexProjects({ id: 'a'.repeat(20), days: 30, gen: 2, dispatch, get });
    held[1](answer({ ...report(), days: 30 }));
    await flush();
    held[0](answer({ ...report(), days: 1 }));
    await flush();
    expect(state.report?.days).toBe(30);
  });
});

describe('the report, opened for a Codex account', () => {
  function opened(json: unknown) {
    vi.stubGlobal('document', { body: null });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => answer(url.startsWith('/api/codex-profile-projects') ? json : null)));
    const view = mount(AccountProjectsModal, { codexId: 'a'.repeat(20), name: 'work', onClose: vi.fn() });
    cleanup = view.unmount;
    return view;
  }

  it('says its dollars are an API-equivalent estimate from Codex\'s logs, with no ccusage and no tracking start', async () => {
    const view = opened(report());
    await flush();
    const text = textOf(view.tree);
    expect(text).toContain('api');
    expect(text).toContain('API-equivalent estimate · from Codex’s session logs');
    expect(text).not.toContain('ccusage');
    expect(text).not.toContain('Tracking starts');
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call => call[0])).toEqual([codexProjectsUrl('a'.repeat(20), 1)]);
  });

  it('names work by a different sign-in in this folder as the unattributed part', async () => {
    const view = opened(report({ [MODEL]: tokens }));
    await flush();
    const text = textOf(view.tree);
    expect(text).toContain('Unattributed usage');
    expect(text).toContain('by a different sign-in, or with no project folder');
    expect(text).not.toContain('from before tracking');
  });

  it('keeps an empty window free of the tracking note Claude\'s report adds', async () => {
    const view = opened({ ...report(), projects: [], daily: [] });
    await flush();
    expect(textOf(view.tree)).not.toContain('Only work from this version onward');
  });
});

describe('Projects in a Codex row\'s menu', () => {
  it('opens the report for that account, and focus comes back to the row\'s ⋯', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} });
    const rows = [
      { id: 'a'.repeat(20), label: 'Fictional account', active: true, signedInFilePresent: true, identityVersion: 'fixture' },
      { id: 'b'.repeat(20), label: 'Signed out', active: false, signedInFilePresent: false, identityVersion: 'none' },
    ];
    const fetch = vi.fn(async () => answer({ profiles: rows, revision: 7 }));
    vi.stubGlobal('fetch', fetch);
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount; await flush();
    const item = () => one(view.tree, el => el.type === 'button' && el.props.role === 'menuitem' && textOf(el) === 'Projects');
    // A row with no login still has the work its folder holds.
    openOthers(view);
    openMenuOf(view, 'Signed out');
    expect(item()).toBeTruthy();
    openMenuOf(view, 'Fictional account');
    expect(item()!.props.title).toContain('worked in each project');
    expect(item()!.props['aria-haspopup']).toBe('dialog');
    (item()!.props.onClick as () => void)();
    const report = one(view.tree, el => el.type === AccountProjectsModal)!;
    expect(report.props).toMatchObject({ codexId: rows[0].id });
    expect(report.props.num).toBeUndefined();
    // The menu closed as the report opened, so its item is gone from the page.
    expect(item()).toBeNull();
    vi.stubGlobal('document', { getElementById: (id: string) => ({ id }) });
    expect((report.props.returnFocusTo as () => { id: string })().id).toMatch(/^ap-codex-more-/);
    (report.props.onClose as () => void)();
    expect(all(view.tree, el => el.type === AccountProjectsModal)).toHaveLength(0);
  });
});
