import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flush } from './fake-react';
import { openOthers, rowOf, rowText } from './codex-panel-helpers';
vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

describe('Codex default selection controls', () => {
  it.each([undefined, 'applied', 'failed'])('guards duplicate activation and reports native switch state %s', async liveState => {
    let switched = false, writes = 0;
    let answer!: () => void;
    const pending = new Promise<void>(resolve => { answer = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/codex-profile-select') {
        writes++; await pending; switched = true;
        return { ok: true, json: async () => ({ ok: true, id: 'b', revision: 1, ...(liveState ? { live: { state: liveState } } : {}) }) };
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
    if (liveState === 'failed') {
      expect(rowText(selected)).toContain('Default saved');
      expect(rowText(selected)).toContain('open Codex app could not switch');
      expect(rowText(selected)).not.toContain('Connected Codex conversations');
    } else if (liveState === 'applied') {
      expect(rowText(selected)).toContain('Connected Codex conversations now use this account');
      expect(rowText(selected)).toContain('If the app stops a task, press Continue');
    } else {
      expect(rowText(selected)).toContain('Default changed');
      expect(rowText(selected)).toContain('Sessions using terminal selection will follow this account');
      expect(rowText(selected)).not.toContain('Connected Codex conversations');
    }
  });
});
