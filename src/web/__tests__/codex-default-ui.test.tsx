import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flush, one, textOf } from './fake-react';
import { openOthers, rowOf, rowText } from './codex-panel-helpers';
vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

describe('Codex default selection controls', () => {
  it.each([false, true])('explains unsafe login permissions after %s persisted failure', async persisted => {
    let selected = persisted;
    const live = { state: 'failed', requestedProfileId: 'b', reason: 'credential_file_unsafe' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/codex-profile-select') { selected = true; return { ok: true, json: async () => ({ ok: true, live }) }; }
      if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ profiles: [
        { id: 'a', label: 'Personal', active: !selected, signedInFilePresent: true },
        { id: 'b', label: 'Work', active: selected, signedInFilePresent: true },
      ], ...(selected ? { live } : {}) }) };
    }));
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount; await flush();
    if (!persisted) {
      openOthers(view);
      (rowOf(view, 'Work')!.props.onSwitch as (num: number, name: string) => void)(2, 'Work'); await flush();
    }
    const text = rowText(rowOf(view, 'Work')!);
    expect(text).toContain('Use + to sign this account into a separate profile');
    expect(text).toContain('Keep the existing Codex sandbox permissions');
    expect(text).not.toContain('/status');
  });
  it('offers an explicit reconnect for the already-selected account after native ownership is lost', async () => {
    let writes = 0, reconnected = false;
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/codex-profile-select') { writes++; reconnected = true; return { ok: true, json: async () => ({ ok: true, live: { state: 'applied', profileId: 'a' } }) }; }
      if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ profiles: [{ id: 'a', label: 'Personal', active: true, signedInFilePresent: true }],
        live: { state: reconnected ? 'applied' : 'external_change', profileId: reconnected ? 'a' : null, reason: 'native_identity_unattested' } }) };
    });
    vi.stubGlobal('fetch', fetch);
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount; await flush();
    expect(writes).toBe(0);
    expect(textOf(view.tree)).toContain('Check /status before reconnecting');
    (one(view.tree, n => n.type === 'button' && textOf(n) === 'Reconnect selected account')!.props.onClick as () => void)();
    await flush();
    expect(writes).toBe(1);
    expect(textOf(view.tree)).not.toContain('Check /status before reconnecting');
  });

  it('shows pending child continuation when the panel opens after the account already switched', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ profiles: [{ id: 'a', label: 'Personal', active: true, signedInFilePresent: true }],
        live: { state: 'applied', profileId: 'a', continuation: 'waiting' } }) };
    }));
    const view = mount(() => CodexProfilesSection()); cleanup = view.unmount; await flush();
    expect(rowText(rowOf(view, 'Personal')!)).toContain('Account switched. Waiting for subagents to resume.');
    expect(rowText(rowOf(view, 'Personal')!)).not.toContain('Interrupted tasks resume automatically');
  });
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
    } else {
      // A switch that took, live or not, adds no words: the row's dot says it.
      expect(rowText(selected)).not.toContain('Connected Codex conversations');
      expect(rowText(selected)).not.toContain('Default changed');
      expect(rowText(selected)).not.toContain('Interrupted tasks resume automatically');
    }
  });
});
