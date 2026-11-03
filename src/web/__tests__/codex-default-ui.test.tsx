import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flush, one } from './fake-react';
import { openOthers, rowOf, rowText } from './codex-panel-helpers';
vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

describe('Codex default selection controls', () => {
  it('clears a failed native-switch warning when the server later confirms that same account', async () => {
    let selected = false, recovered = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const live = { state: recovered ? 'applied' : 'failed', profileId: recovered ? 'b' : 'a', requestedProfileId: 'b' };
      if (url === '/api/codex-profile-select') { selected = true; return { ok: true, json: async () => ({ ok: true, live }) }; }
      if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ profiles: [
        { id: 'a', label: 'Personal', active: !selected, signedInFilePresent: true },
        { id: 'b', label: 'Work', active: selected, signedInFilePresent: true },
      ], ...(selected ? { live } : {}) }) };
    }));
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount; await flush(); openOthers(view);
    (rowOf(view, 'Work')!.props.onSwitch as (n: number, name: string) => void)(2, 'Work'); await flush();
    expect(rowText(rowOf(view, 'Work')!)).toContain('open Codex app could not switch');
    recovered = true;
    (one(view.tree, n => String(n.props.className).includes('ap-refresh'))!.props.onClick as () => void)(); await flush();
    expect(rowText(rowOf(view, 'Work')!)).not.toContain('open Codex app could not switch');
  });
  it.each([undefined, 'applied', 'failed', 'waiting', 'children_waiting', 'manual_required'])('guards duplicate activation and reports native switch state %s', async liveState => {
    let switched = false, writes = 0;
    let answer!: () => void;
    const pending = new Promise<void>(resolve => { answer = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/codex-profile-select') {
        writes++; await pending; switched = true;
        return { ok: true, json: async () => ({ ok: true, id: 'b', revision: 1, ...(liveState ? { live: { state: ['manual_required', 'children_waiting'].includes(liveState) ? 'applied' : liveState, continuation: liveState === 'children_waiting' ? 'waiting' : liveState, profileId: 'b', requestedProfileId: 'b' } } : {}) }) };
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
      (selected.props.onDismissRefusal as () => void)(); await flush();
      expect(rowText(rowOf(view, 'Work')!)).not.toContain('Default saved');
    } else if (liveState === 'waiting') {
      expect(rowText(selected)).toContain('Waiting for running tools or pending input');
      expect(rowText(selected)).not.toContain('now use this account');
    } else if (liveState === 'children_waiting') {
      expect(rowText(selected)).toContain('Account switched. Waiting for subagents to resume.');
      expect(rowText(selected)).not.toContain('Interrupted tasks resume automatically');
    } else if (liveState === 'manual_required') {
      expect(rowText(selected)).toContain('Automatic continuation could not be confirmed');
      expect(rowText(selected)).not.toContain('Interrupted tasks resume automatically');
    } else if (liveState === 'applied') {
      expect(rowText(selected)).toContain('Connected Codex conversations now use this account');
      expect(rowText(selected)).toContain('Interrupted tasks resume automatically');
    } else {
      expect(rowText(selected)).toContain('Default changed');
      expect(rowText(selected)).toContain('Sessions using terminal selection will follow this account');
      expect(rowText(selected)).not.toContain('Connected Codex conversations');
    }
  });
});
