// The server's half of Codex's account rows: a name kept for any account, and two
// rows on one ChatGPT login told apart from two accounts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCodexProfile, readCodexSelection, renameCodexProfile, selectCodexProfile } from '../../server/codex-selection.mjs';
import { discoverCodexProfiles } from '../../server/codex-profiles.mjs';

let root: string, options: { store: string; env: Record<string, string>; home: string };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccdeck-codex-rename-'));
  await mkdir(join(root, '.codex'));
  options = { store: join(root, 'store'), env: {}, home: root };
  await mkdir(options.store);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const revision = async () => (await readCodexSelection(options)).revision;
const signedIn = (emailOf: (home: string) => string | null) => async (home: string) => {
  const email = emailOf(home);
  return email ? { ok: true, signedIn: true, label: email, identityVersion: `login:${email}`, plan: 'plus' } : { ok: true, signedIn: false };
};

describe('renaming a Codex account', () => {
  it('names the user\'s own home too, and an empty name takes it away', async () => {
    const before = await readCodexSelection(options);
    await renameCodexProfile({ id: before.profileId, label: 'personal', expectedRevision: await revision() }, options);
    const named = await discoverCodexProfiles({ ...options, selection: await readCodexSelection(options), enableNative: true, nativeRead: signedIn(() => 'me@example.com') });
    expect(named[0]).toMatchObject({ managedLabel: 'personal', account: 'me@example.com', label: 'personal · me@example.com' });
    expect(named[0].managed).toBeUndefined();
    await renameCodexProfile({ id: before.profileId, label: '', expectedRevision: await revision() }, options);
    const cleared = await discoverCodexProfiles({ ...options, selection: await readCodexSelection(options), enableNative: true, nativeRead: signedIn(() => 'me@example.com') });
    expect(cleared[0].managedLabel).toBeUndefined();
    expect(cleared[0].label).toBe('me@example.com');
  });

  it('refuses a name the registry could not read back, a stale revision and an unknown account', async () => {
    const { profileId } = await readCodexSelection(options);
    await addCodexProfile({ operationId: 'add-one' }, options);
    await expect(renameCodexProfile({ id: profileId, label: 'a/b', expectedRevision: await revision() }, options)).rejects.toMatchObject({ code: 'invalid_label' });
    await expect(renameCodexProfile({ id: profileId, label: 'x', expectedRevision: 0 }, options)).rejects.toMatchObject({ code: 'selection_conflict' });
    await expect(renameCodexProfile({ id: 'f'.repeat(20), label: 'x', expectedRevision: await revision() }, options)).rejects.toMatchObject({ code: 'unknown_profile' });
  });
});

describe('two rows on one ChatGPT account', () => {
  it('marks the row that repeats the default, whichever of them was added first', async () => {
    const added = await addCodexProfile({ operationId: 'add-one' }, options);
    const roster = await discoverCodexProfiles({ ...options, selection: await readCodexSelection(options), enableNative: true, nativeRead: signedIn(() => 'one@example.com') });
    const [mine, theirs] = roster;
    expect(mine.sameAccountAs).toBeUndefined();
    expect(theirs).toMatchObject({ id: added.id, sameAccountAs: mine.id });
    // Make the added one the default: now the first row is the repeat.
    await selectCodexProfile({ id: added.id, expectedRevision: await revision(), operationId: 'pick-it' }, options);
    const swapped = await discoverCodexProfiles({ ...options, selection: await readCodexSelection(options), enableNative: true, nativeRead: signedIn(() => 'one@example.com') });
    expect(swapped.find(p => p.active)?.sameAccountAs).toBeUndefined();
    expect(swapped.find(p => !p.active)?.sameAccountAs).toBe(added.id);
  });

  it('leaves two accounts, and a signed-out row, alone', async () => {
    const added = await addCodexProfile({ operationId: 'add-one' }, options);
    const two = await discoverCodexProfiles({ ...options, selection: await readCodexSelection(options), enableNative: true,
      nativeRead: signedIn(home => home.includes('codex-profiles') ? 'two@example.com' : 'one@example.com') });
    expect(two.every(p => p.sameAccountAs === undefined)).toBe(true);
    const out = await discoverCodexProfiles({ ...options, selection: await readCodexSelection(options), enableNative: true, nativeRead: signedIn(() => null) });
    expect(out.every(p => p.sameAccountAs === undefined)).toBe(true);
    expect(out.find(p => p.id === added.id)?.account).toBeNull();
  });
});
