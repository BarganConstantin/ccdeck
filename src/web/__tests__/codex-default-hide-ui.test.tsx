// The ⋯ menu of Codex's own home: no Remove, a line that says why, and a Hide
// while it is signed out and unused; any other row's ⋯ shows it again. A home
// the deck made keeps its Remove, asked twice, as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, mount, one, textOf, flush, type Drawn } from './fake-react';
import { isFold, openOthers, openMenuOf, rowOf } from './codex-panel-helpers';

vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

const OWN = 'a'.repeat(20), WORK = 'b'.repeat(20);
type Profile = Record<string, unknown>;
/** The report's roster: Codex's own home signed out and unused, a home the deck
 *  made signed in and in use. */
const own: Profile = { id: OWN, label: 'Default Codex', codexOwnHome: true, hideable: true, active: false, authSource: 'native', signedIn: false, signedInFilePresent: false, identityVersion: 'a' };
const work: Profile = { id: WORK, label: 'Work · me@example.com', managedLabel: 'Work', account: 'me@example.com', managed: true, active: true, authSource: 'native', signedIn: true, signedInFilePresent: false, identityVersion: 'b' };

async function setup({ ownRow = own, homeId = null as string | null, refuse = false } = {}) {
  vi.useFakeTimers();
  const hides: unknown[] = [];
  let hidden = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/codex-profile-hide') {
      const body = JSON.parse(String(options?.body));
      hides.push(body);
      if (refuse) return { ok: false, status: 400, json: async () => ({ ok: false, reason: 'profile_in_use' }) };
      hidden = body.hidden;
      return { ok: true, json: async () => ({ ok: true, id: body.id, revision: 3, status: hidden ? 'hidden' : 'shown' }) };
    }
    if (url === '/api/codex-auto') return { ok: true, json: async () => ({
      ok: true, enabled: false, external: false, lastTick: null,
      settings: { 'autoswitch.threshold': { value: '90', isDefault: true } },
      choice: { next: 'room', home: null }, homeId, heldOut: [],
    }) };
    if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ revision: 3, profiles: [hidden ? { ...ownRow, hidden: true } : ownRow, work] }) };
  }));
  const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
  await flush();
  if (one(view.tree, isFold)) openOthers(view);
  return { view, hides };
}

type View = { tree: unknown };
const items = (view: View) => all(view.tree, el => el.type === 'button' && el.props.role === 'menuitem');
const item = (view: View, text: RegExp) => items(view).find(el => text.test(textOf(el)));
const press = async (el: Drawn | undefined) => { (el!.props.onClick as () => void)(); await flush(); };
const NOTE = "Can't be removed: it is Codex's own sign-in folder, and ccdeck never deletes it.";

describe('the ⋯ menu of Codex\'s own home', () => {
  it('says why it has no Remove, as an item the keyboard reaches and nothing presses', async () => {
    const { view } = await setup();
    openMenuOf(view, 'Default Codex');
    expect(item(view, /^(Remove|Confirm)$/)).toBeUndefined();
    const note = item(view, /Can't be removed/)!;
    expect(textOf(note)).toBe(NOTE);
    expect(note.props['aria-disabled']).toBe('true');
    // aria-disabled, never disabled: the arrows still land on it.
    expect(note.props.disabled).toBeUndefined();
    expect(note.props.onClick).toBeUndefined();
    expect(String(note.props.className)).toContain('ap-menu-note');
  });

  it('keeps Remove, asked twice, on a home the deck made, with no note and no Hide', async () => {
    const { view } = await setup();
    openMenuOf(view, 'Work');
    expect(textOf(item(view, /^Remove$/)!)).toBe('Remove');
    await press(item(view, /^Remove$/));
    expect(textOf(item(view, /^Confirm$/)!)).toBe('Confirm');
    expect(item(view, /Can't be removed/)).toBeUndefined();
    expect(item(view, /^Hide$/)).toBeUndefined();
  });

  it('hides the signed-out, unused row and brings it back from another row\'s ⋯', async () => {
    const { view, hides } = await setup();
    openMenuOf(view, 'Default Codex');
    await press(item(view, /^Hide$/));
    expect(hides).toEqual([{ id: OWN, hidden: true }]);
    expect(rowOf(view, 'Default Codex')).toBeUndefined();
    // Nothing left behind the fold, so the fold goes too.
    expect(one(view.tree, isFold)).toBeFalsy();
    expect(textOf(view.tree)).toContain("Default Codex is hidden. Any account's ⋯ menu shows it again.");

    openMenuOf(view, 'Work');
    const show = item(view, /^Show Default Codex$/);
    expect(show).toBeTruthy();
    await press(show);
    expect(hides).toEqual([{ id: OWN, hidden: true }, { id: OWN, hidden: false }]);
    // Back behind the fold, which opens for it.
    expect(one(view.tree, isFold)!.props.open).toBe(true);
    expect(rowOf(view, 'Default Codex')).toBeTruthy();
    expect(textOf(view.tree)).not.toContain('is hidden');
    openMenuOf(view, 'Work');
    expect(item(view, /^Show /)).toBeUndefined();
  });

  it('offers no Hide while the row is signed in, in use, or Auto-switch\'s home — the note stays', async () => {
    for (const [ownRow, homeId] of [
      [{ ...own, hideable: false, signedIn: true, account: 'me@example.com' }, null],
      [{ ...own, active: true }, null],
      [own, OWN],
    ] as [Profile, string | null][]) {
      const { view } = await setup({ ownRow, homeId });
      const name = ownRow.account ? 'me@example.com' : 'Default Codex';
      openMenuOf(view, name);
      expect(item(view, /^Hide$/)).toBeUndefined();
      expect(textOf(item(view, /Can't be removed/)!)).toBe(NOTE);
      cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers();
    }
  });

  it('says so in the menu when the deck refuses, and keeps the row', async () => {
    const { view, hides } = await setup({ refuse: true });
    openMenuOf(view, 'Default Codex');
    await press(item(view, /^Hide$/));
    expect(hides).toHaveLength(1);
    expect(rowOf(view, 'Default Codex')).toBeTruthy();
    expect(textOf(view.tree)).toContain('Could not hide the account. Reload and try again.');
  });
});
