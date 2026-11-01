import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flush } from './fake-react';
import { openOthers, rowOf, rowText } from './codex-panel-helpers';
vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

describe('Codex default selection controls', () => {
  it('guards duplicate activation and moves the default account to the top row', async () => {
    let switched = false, writes = 0;
    let answer!: () => void;
    const pending = new Promise<void>(resolve => { answer = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/codex-profile-select') {
        writes++; await pending; switched = true;
        return { ok: true, json: async () => ({ ok: true, id: 'b', revision: 1 }) };
      }
      if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ revision: switched ? 1 : 0, profiles: [
        { id: 'a', label: 'Personal', active: !switched, signedInFilePresent: true },
        { id: 'b', label: 'Work', active: switched, signedInFilePresent: true },
      ] }) };
    }));
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
    await flush();
    // The default account is the open row; the others wait behind "Other accounts".
    openOthers(view);
    const row = rowOf(view, 'Work')!;
    expect(rowText(row)).toContain('Switch');
    const press = row.props.onSwitch as (num: number, name: string) => void;
    press(2, 'Work'); press(2, 'Work');
    expect(writes).toBe(1);
    answer(); await flush();
    const selected = rowOf(view, 'Work')!;
    // The selected row is the live one and offers no second Switch to press.
    expect((selected.props.a as { active: boolean }).active).toBe(true);
    expect(rowText(selected)).not.toContain('Switch');
    // And it says what a switch does to the sessions already running, on the row.
    expect(rowText(selected)).toContain('Now active');
    expect(rowText(selected)).toContain('Running ones keep their account');
  });
});
