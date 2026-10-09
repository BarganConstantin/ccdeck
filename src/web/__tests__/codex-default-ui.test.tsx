import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';
vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

describe('Codex default selection controls', () => {
  it('keeps the selected control focusable and guards duplicate activation', async () => {
    let switched = false, writes = 0;
    let answer!: () => void;
    const pending = new Promise<void>(resolve => { answer = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/codex-profile-select') {
        writes++; await pending; switched = true;
        return { ok: true, json: async () => ({ ok: true, id: 'b', revision: 1 }) };
      }
      return { ok: true, json: async () => ({ revision: switched ? 1 : 0, profiles: [
        { id: 'a', label: 'Personal', active: !switched, signedInFilePresent: false },
        { id: 'b', label: 'Work', active: switched, signedInFilePresent: false },
      ] }) };
    }));
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
    await flush();
    const button = one(view.tree, el => el.type === 'button' && textOf(el) === 'Use account')!;
    (button.props.onClick as () => void)(); (button.props.onClick as () => void)();
    expect(writes).toBe(1);
    expect(button.props.disabled).not.toBe(true);
    answer(); await flush();
    const selected = one(view.tree, el => el.type === 'li' && textOf(el).includes('Work'))!;
    const control = one(selected, el => el.type === 'button' && textOf(el) === 'Default account')!;
    expect(control.props.disabled).not.toBe(true);
    expect(control.props['aria-pressed']).toBe(true);
    expect(textOf(view.tree)).toContain('Default saved');
  });
});
