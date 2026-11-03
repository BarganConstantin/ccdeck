import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, mount, one, textOf, flush } from './fake-react';

vi.mock('react', async () => (await import('./fake-react')).react);
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
vi.mock('../components/use-modal-dismiss', () => ({ useModalDismiss: () => ({ current: null }), useScrimDismiss: () => ({}) }));
vi.mock('../copy-text', () => ({ copyText: vi.fn(async () => true) }));
const { default: CodexShareDialog } = await import('../components/CodexShareDialog');
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
const profiles = [{ id: 'a'.repeat(20), label: 'Fictional account', active: true, signedInFilePresent: true, identityVersion: 'fixture' }];
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
const press = (view: { tree: unknown }, label: string) => (one(view.tree, el => el.type === 'button' && textOf(el) === label)!.props.onClick as () => void)();

function dialog(mode: 'export' | 'import', onImported = vi.fn()) {
  vi.stubGlobal('document', { body: null });
  const view = mount(CodexShareDialog, { mode, profiles, revision: 7, onImported, onClose: vi.fn() });
  cleanup = view.unmount;
  return view;
}
describe('Codex share dialog', () => {
  it('does not read credentials on open; warns clearly and exports exactly the selection after explicit generation', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, blob: 'ccdeck-codex-v1.fictional', count: 1 }) }));
    vi.stubGlobal('fetch', fetch);
    const view = dialog('export');
    expect(fetch).not.toHaveBeenCalled();
    expect(textOf(view.tree)).toContain('live sign-in credentials');
    expect(textOf(view.tree)).toContain('may invalidate the other copy');
    expect(one(view.tree, el => el.type === 'button' && textOf(el) === 'Generate share code')!.props.disabled).toBe(true);
    (one(view.tree, el => el.type === 'input')!.props.onChange as () => void)();
    press(view, 'Generate share code');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject(['/api/codex-accounts-share', { method: 'POST', body: JSON.stringify({ ids: [profiles[0].id] }) }]);
    expect(one(view.tree, el => el.type === 'textarea')!.props.value).toBe('ccdeck-codex-v1.fictional');
    expect(textOf(view.tree)).toContain('no automatic expiry');
  });

  it('keeps the selected export frozen while generation is pending without removing keyboard focus', async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn(() => new Promise(r => { resolve = r; }));
    vi.stubGlobal('fetch', fetch);
    const view = dialog('export');
    (one(view.tree, el => el.type === 'input')!.props.onChange as () => void)();
    press(view, 'Generate share code');
    const input = one(view.tree, el => el.type === 'input')!;
    expect(input.props['aria-disabled']).toBe(true);
    expect(input.props.disabled).toBeUndefined();
    (input.props.onChange as () => void)();
    expect(one(view.tree, el => el.type === 'input')!.props.checked).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    resolve({ ok: false, json: async () => ({ ok: false }) }); await flush();
    (one(view.tree, el => el.type === 'input')!.props.onChange as () => void)();
    expect(one(view.tree, el => el.type === 'input')!.props.checked).toBe(false);
  });

  it('imports only on press, uses CAS, clears credentials on success and reports dedup results', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, revision: 8, results: [{ id: 'b'.repeat(20), status: 'imported' }, { id: 'c'.repeat(20), status: 'already_imported' }] }) }));
    vi.stubGlobal('fetch', fetch);
    const imported = vi.fn(), view = dialog('import', imported);
    (one(view.tree, el => el.type === 'textarea')!.props.onChange as (e: unknown) => void)({ target: { value: ' ccdeck-codex-v1.fictional ' } });
    expect(fetch).not.toHaveBeenCalled();
    press(view, 'Import accounts');
    await flush();
    expect(fetch.mock.calls[0]).toMatchObject(['/api/codex-accounts-import', { method: 'POST', body: JSON.stringify({ blob: 'ccdeck-codex-v1.fictional', expectedRevision: 7 }) }]);
    expect(imported).toHaveBeenCalledOnce();
    expect(textOf(view.tree)).toContain('Added: 1. Already imported: 1.');
    expect(one(view.tree, el => el.type === 'textarea')).toBeNull();
  });

  it('ignores repeated presses while pending, keeps errors credential-free and preserves paste for retry', async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn(() => new Promise(r => { resolve = r; })); vi.stubGlobal('fetch', fetch);
    const view = dialog('import');
    (one(view.tree, el => el.type === 'textarea')!.props.onChange as (e: unknown) => void)({ target: { value: 'ccdeck-codex-v1.fictional' } });
    press(view, 'Import accounts'); press(view, 'Working…');
    expect(fetch).toHaveBeenCalledOnce();
    resolve({ ok: false, json: async () => ({ ok: false, reason: 'fictional-secret-error' }) }); await flush();
    expect(textOf(view.tree)).toContain('The transfer could not finish');
    expect(textOf(view.tree)).not.toContain('fictional-secret-error');
    expect(one(view.tree, el => el.type === 'textarea')!.props.value).toBe('ccdeck-codex-v1.fictional');
    expect(one(view.tree, el => el.props.role === 'alert')).toBeTruthy();
  });

  it('does not echo an unsuccessful server response as a share', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, reason: 'file_auth_required', blob: 'not-a-success' }) })));
    const view = dialog('export');
    (one(view.tree, el => el.type === 'input')!.props.onChange as () => void)(); press(view, 'Generate share code'); await flush();
    expect(textOf(view.tree)).toContain('uses a keyring');
    expect(one(view.tree, el => el.type === 'textarea')).toBeNull();
  });

  it('provides both manual actions in the Codex header without starting auth operations', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ profiles, revision: 7 }) }));
    vi.stubGlobal('fetch', fetch);
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount; await flush();
    for (const [label, mode] of [['Share Codex accounts', 'export'], ['Import Codex accounts', 'import']]) {
      (one(view.tree, el => el.type === 'button' && el.props['aria-label'] === label)!.props.onClick as () => void)();
      const opened = one(view.tree, el => el.type === CodexShareDialog)!;
      expect(opened.props.mode).toBe(mode);
      expect(opened.props.revision).toBe(7);
      (opened.props.onClose as () => void)();
    }
    expect(all(view.tree, el => el.type === CodexShareDialog)).toHaveLength(0);
    expect(fetch.mock.calls.every(call => !String(call[0]).includes('share') && !String(call[0]).includes('import'))).toBe(true);
  });
});
