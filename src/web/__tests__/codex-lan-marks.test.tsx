import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mount, flush } from './fake-react';
import { openOthers, rowOf, rowText } from './codex-panel-helpers';
import type { SharedMark } from '../account-lan';
vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

const ANA = 'codex:ana@example.net@@0123456789abcdef0123456789abcdef';
const BEN = 'codex:ben@example.net@@fedcba9876543210fedcba9876543210';

// A Codex login ticked in Local network says so on its row, as a Claude one
// has since #2170: the same mark, from the same status, by the same key.
describe('the share mark on a Codex account row', () => {
  it('marks every row of a login this deck offers, and only those', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/codex-profile-quota')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ profiles: [
        { id: 'a', label: 'Personal', active: true, signedInFilePresent: true, lan: { key: ANA, email: 'ana@example.net' } },
        { id: 'b', label: 'Spare', active: false, signedInFilePresent: true, lan: { key: ANA, email: 'ana@example.net' } },
        { id: 'c', label: 'Work', active: false, signedInFilePresent: true, lan: { key: BEN, email: 'ben@example.net' } },
        { id: 'd', label: 'Key', active: false, signedInFilePresent: true },
      ] }) };
    }));
    const shared = new Map<string, SharedMark>([[ANA, { to: ['Deck-B'], inUse: true }]]);
    const view = mount(() => CodexProfilesSection({ shared })); cleanup = view.unmount; await flush();
    openOthers(view);
    expect(rowOf(view, 'Personal')!.props.lan).toEqual({ sharedTo: ['Deck-B'], sharedInUse: true });
    expect(rowOf(view, 'Spare')!.props.lan).toEqual({ sharedTo: ['Deck-B'], sharedInUse: true });
    expect(rowOf(view, 'Work')!.props.lan).toBeUndefined();
    expect(rowOf(view, 'Key')!.props.lan).toBeUndefined();
    // In the row's own words, the line Claude's rows say.
    expect(rowText(rowOf(view, 'Personal')!)).toContain('Deck-B');
    expect(rowText(rowOf(view, 'Work')!)).not.toContain('Deck-B');
  });

  it('takes the marks from the Local network section drawn on the Codex side', () => {
    const panel = readFileSync(fileURLToPath(new URL('../components/CodexAccountsPanel.tsx', import.meta.url)), 'utf8');
    expect(panel).toContain('onShared={setShared}');
    expect(panel).toContain('shared={shared}');
  });
});
