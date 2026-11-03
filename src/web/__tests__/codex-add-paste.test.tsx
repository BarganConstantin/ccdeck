// Claude's + offers two ways in, Sign in and Paste a share; Codex's had only the
// first and kept the second behind an Import icon of its own in the header. The
// header now matches Claude's (+, ↗, reload, close), so Add a Codex account
// carries both tabs, and signing an existing row in again still has one way.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, mount, one, textOf } from './fake-react';

vi.mock('react', async () => (await import('./fake-react')).react);
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
const { default: AddCodexAccountDialog } = await import('../components/AddCodexAccountDialog');
const { default: CodexImportPane } = await import('../components/CodexImportPane');

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(over: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('window', { open: () => null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { body: {}, activeElement: null, addEventListener() {}, removeEventListener() {} });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  vi.stubGlobal('fetch', fetch);
  const props = {
    onCreate: vi.fn(async () => 'new-profile'), onCopyCommand: vi.fn(), onClose: vi.fn(),
    onSignedIn: vi.fn(), onReplace: vi.fn(), onDiscard: vi.fn(),
    revision: 7, onImported: vi.fn(), ...over,
  };
  const view = mount(AddCodexAccountDialog as never, props as never); cleanup = view.unmount;
  return { view, props, fetch };
}

const tabs = (view: { tree: unknown }) => all(view.tree, el => el.props?.role === 'tab');
const tab = (view: { tree: unknown }, label: string) => one(view.tree, el => el.props?.role === 'tab' && textOf(el) === label)!;

describe('Add a Codex account: Sign in or Paste a share', () => {
  it('offers both ways in for a new account, starting on Sign in', () => {
    const { view } = setup();
    expect(tabs(view).map(el => textOf(el))).toEqual(['Sign in', 'Paste a share']);
    expect(one(view.tree, el => el.props?.role === 'tablist')!.props['aria-label']).toBe('How to add the account');
    expect(tab(view, 'Sign in').props['aria-selected']).toBe(true);
    expect(one(view.tree, el => el.type === 'button' && textOf(el) === 'Sign in with ChatGPT')).toBeTruthy();
    expect(one(view.tree, el => el.type === CodexImportPane)).toBeNull();
    // The dialog is named by its title, kept out of sight where the strip stands.
    expect(one(view.tree, el => el.props?.role === 'dialog')!.props['aria-labelledby']).toBe('aa-codex-title');
    const title = one(view.tree, el => el.props?.id === 'aa-codex-title')!;
    expect(textOf(title)).toBe('Add a Codex account');
    expect(title.props.className).toBe('vis-hidden');
  });

  it('swaps in the paste, against the roster it was opened on, and starts nothing', () => {
    const { view, props, fetch } = setup();
    (tab(view, 'Paste a share').props.onClick as () => void)();
    const paste = one(view.tree, el => el.type === CodexImportPane)!;
    expect(paste.props).toMatchObject({ revision: 7, onImported: props.onImported });
    expect(one(view.tree, el => el.type === 'button' && textOf(el) === 'Sign in with ChatGPT')).toBeNull();
    expect(tab(view, 'Paste a share').props['aria-selected']).toBe(true);
    expect(one(view.tree, el => el.props?.role === 'tabpanel')!.props['aria-labelledby']).toBe('aa-codex-tab-paste');
    // Done after an import closes the dialog the way × does.
    (paste.props.onDone as () => void)();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('walks the strip with the arrow keys and keeps one tab stop', () => {
    const { view } = setup();
    const strip = () => one(view.tree, el => el.props?.role === 'tablist')!;
    const key = (k: string) => (strip().props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    key('ArrowRight');
    expect(tab(view, 'Paste a share').props['aria-selected']).toBe(true);
    expect(tabs(view).map(el => el.props.tabIndex)).toEqual([-1, 0]);
    key('ArrowRight');
    expect(tab(view, 'Sign in').props['aria-selected']).toBe(true);
  });

  it('signing a row in again has one way in, and no strip', () => {
    const { view } = setup({ profile: { id: 'a'.repeat(20), label: 'Work', account: 'work@example.com' } });
    expect(tabs(view)).toHaveLength(0);
    expect(textOf(view.tree)).toContain('Work');
    expect(one(view.tree, el => el.props?.role === 'dialog')!.props['aria-labelledby']).toBe('aa-codex-title');
  });
});
