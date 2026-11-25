// Hiding the row of Codex's own home (CODEX_HOME, else ~/.codex) while nobody
// is signed in there and nothing uses it.
//
// That home is Codex's own sign-in folder: the deck lists it and never removes
// it, so its row has no Remove. It may be hidden instead, as a note the deck
// keeps in its own registry; nothing in the folder is read for it, moved or
// written. The row comes back as soon as Codex signs in there or something uses
// it, and a later sign-out does not hide it again.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexOwnHomeHideable, codexProfileInUse, codexProfilesForPanel, discoverCodexProfiles, setCodexDefaultHidden,
} from '../../server/codex-profiles.mjs';
import {
  addCodexProfile, codexProfileId, codexSelectionPath, markCodexProfileHidden, readCodexSelection, selectCodexProfile,
} from '../../server/codex-selection.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

type Native = { ok: boolean; signedIn?: boolean; label?: string | null; identityVersion?: string | null; reason?: string };
const signedOut: Native = { ok: true, signedIn: false, label: null, identityVersion: 'out' };
const signedIn: Native = { ok: true, signedIn: true, label: 'me@example.com', identityVersion: 'in' };

/** Codex's own home with a config of its own, an account the deck made and
 *  selected, and Codex's own answer about each home, which a test can change. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-hide-')); roots.push(root);
  const own = join(root, 'codex'), store = join(root, 'store');
  await mkdir(own);
  await writeFile(join(own, 'config.toml'), 'model = "gpt-5"\n');
  const native = new Map<string, Native>();
  const options = {
    store, env: { CODEX_HOME: own },
    nativeRead: async (home: string) => native.get(home) ?? signedOut,
  };
  const ownId = await codexProfileId(own);
  const work = await addCodexProfile({ label: 'Work', operationId: 'add-work' }, options);
  const picked = await selectCodexProfile({ id: work.id, expectedRevision: work.revision, operationId: 'pick-work' }, options);
  const workHome = (await readCodexSelection(options)).profiles.find((p: { id: string }) => p.id === work.id)!.home;
  native.set(workHome, signedIn);
  return { root, own, store, options, native, ownId, workId: work.id as string, revision: picked.revision as number };
}

const rowOf = (profiles: { id: string }[], id: string) => profiles.find(p => p.id === id) as Record<string, unknown>;

describe('the row of Codex\'s own home', () => {
  it('is the first row, marked as Codex\'s own home, and no row the deck made is', async () => {
    const { options, ownId, workId } = await fixture();
    const profiles = await discoverCodexProfiles({ ...options, enableNative: true });
    expect(profiles[0]).toMatchObject({ id: ownId, codexOwnHome: true, label: 'Default Codex' });
    expect(rowOf(profiles, workId)).not.toHaveProperty('codexOwnHome');
    expect(profiles[0]).not.toHaveProperty('managed');
  });

  it('may be hidden only while it is signed out and nothing uses it', () => {
    const row = { id: 'a'.repeat(20), codexOwnHome: true, active: false, authSource: 'native', signedIn: false, signedInFilePresent: false };
    expect(codexOwnHomeHideable(row)).toBe(true);
    expect(codexOwnHomeHideable({ ...row, signedIn: true })).toBe(false);
    // Codex could not say: not taken for signed out.
    expect(codexOwnHomeHideable({ ...row, metadataUnavailable: true })).toBe(false);
    expect(codexOwnHomeHideable({ ...row, codexOwnHome: undefined })).toBe(false);
    expect(codexOwnHomeHideable({ ...row, managed: true })).toBe(false);
    // New sessions start on it, running ones were sent there or run there, or
    // Auto-switch goes home to it.
    expect(codexOwnHomeHideable({ ...row, active: true })).toBe(false);
    expect(codexProfileInUse(row, { selection: { runningSelection: { id: row.id } } })).toBe(true);
    expect(codexProfileInUse(row, { live: { profileId: row.id } })).toBe(true);
    expect(codexProfileInUse(row, { live: { requestedProfileId: row.id } })).toBe(true);
    expect(codexProfileInUse(row, { autoHome: row.id })).toBe(true);
    expect(codexProfileInUse(row, { autoHome: 'b'.repeat(20), live: { profileId: null } })).toBe(false);
  });
});

describe('hiding it', () => {
  it('hides the signed-out, unused row and shows it again, touching nothing in the folder', async () => {
    const { options, own, ownId, revision } = await fixture();
    const before = await stat(join(own, 'config.toml'));
    expect(rowOf(await codexProfilesForPanel(options), ownId)).toMatchObject({ hideable: true });

    const hidden = await setCodexDefaultHidden({ id: ownId, hidden: true }, options);
    expect(hidden).toMatchObject({ status: 'hidden', revision });
    expect(rowOf(await codexProfilesForPanel(options), ownId)).toMatchObject({ hidden: true, hideable: true });
    const saved = JSON.parse(await readFile(codexSelectionPath(options), 'utf8'));
    expect(saved.profiles.find((p: { id: string }) => p.id === ownId)).toMatchObject({ managed: false, hidden: true });
    // The selection's revision is not a hide's to move: a switch on its way stays good.
    expect(saved.revision).toBe(revision);

    const shown = await setCodexDefaultHidden({ id: ownId, hidden: false }, options);
    expect(shown.status).toBe('shown');
    expect(rowOf(await codexProfilesForPanel(options), ownId)).not.toHaveProperty('hidden');
    // Codex's own folder: no login written, its config as it was.
    await expect(stat(join(own, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(own, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n');
    expect((await stat(join(own, 'config.toml'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('comes back by itself once Codex signs in there, and a later sign-out does not hide it again', async () => {
    const { options, native, own, ownId } = await fixture();
    await setCodexDefaultHidden({ id: ownId, hidden: true }, options);
    native.set(own, signedIn);
    const back = rowOf(await codexProfilesForPanel(options), ownId);
    expect(back).not.toHaveProperty('hidden');
    expect(back).not.toHaveProperty('hideable');
    expect((await readCodexSelection(options)).hiddenProfiles).toEqual([]);
    native.set(own, signedOut);
    expect(rowOf(await codexProfilesForPanel(options), ownId)).not.toHaveProperty('hidden');
  });

  it('comes back once something uses it: Auto-switch\'s home, or the live sessions', async () => {
    for (const use of [(id: string) => ({ autoHome: id }), (id: string) => ({ live: { profileId: id } })]) {
      const { options, ownId } = await fixture();
      await setCodexDefaultHidden({ id: ownId, hidden: true }, options);
      expect(rowOf(await codexProfilesForPanel({ ...options, ...use(ownId) }), ownId)).not.toHaveProperty('hidden');
      expect((await readCodexSelection(options)).hiddenProfiles).toEqual([]);
    }
  });

  it('stays hidden when Codex could not read the login this round', async () => {
    const { options, native, own, ownId } = await fixture();
    await setCodexDefaultHidden({ id: ownId, hidden: true }, options);
    native.set(own, { ok: false, reason: 'native_busy' });
    expect(rowOf(await codexProfilesForPanel(options), ownId)).toMatchObject({ hidden: true });
    expect((await readCodexSelection(options)).hiddenProfiles).toEqual([ownId]);
  });

  it('comes back when it becomes the account new sessions start on', async () => {
    const { options, ownId } = await fixture();
    await setCodexDefaultHidden({ id: ownId, hidden: true }, options);
    const selection = await readCodexSelection(options);
    await selectCodexProfile({ id: ownId, expectedRevision: selection.revision, operationId: 'back-home' }, options);
    expect(rowOf(await codexProfilesForPanel(options), ownId)).toMatchObject({ active: true });
    expect(rowOf(await codexProfilesForPanel(options), ownId)).not.toHaveProperty('hidden');
  });

  it('is refused while signed in, while in use, and for any other row', async () => {
    const { options, native, own, ownId, workId } = await fixture();
    native.set(own, signedIn);
    await expect(setCodexDefaultHidden({ id: ownId, hidden: true }, options)).rejects.toMatchObject({ code: 'profile_in_use' });
    native.set(own, signedOut);
    await expect(setCodexDefaultHidden({ id: ownId, hidden: true }, { ...options, autoHome: ownId })).rejects.toMatchObject({ code: 'profile_in_use' });
    await expect(setCodexDefaultHidden({ id: ownId, hidden: true }, { ...options, live: { requestedProfileId: ownId } })).rejects.toMatchObject({ code: 'profile_in_use' });
    await expect(setCodexDefaultHidden({ id: workId, hidden: true }, options)).rejects.toMatchObject({ code: 'not_hideable' });
    await expect(setCodexDefaultHidden({ id: 'f'.repeat(20), hidden: true }, options)).rejects.toMatchObject({ code: 'not_hideable' });
    expect((await readCodexSelection(options)).hiddenProfiles).toEqual([]);
  });

  it('is refused by the registry itself for the selected home, a home the deck made, and a bad request', async () => {
    const { options, ownId, workId } = await fixture();
    await expect(markCodexProfileHidden({ id: workId, hidden: true }, options)).rejects.toMatchObject({ code: 'not_hideable' });
    const selection = await readCodexSelection(options);
    await selectCodexProfile({ id: ownId, expectedRevision: selection.revision, operationId: 'own-again' }, options);
    await expect(markCodexProfileHidden({ id: ownId, hidden: true }, options)).rejects.toMatchObject({ code: 'profile_in_use' });
    await expect(markCodexProfileHidden({ id: '../etc', hidden: true }, options)).rejects.toMatchObject({ code: 'unknown_profile' });
    await expect(markCodexProfileHidden({ id: ownId, hidden: 'yes' }, options)).rejects.toMatchObject({ code: 'invalid_operation' });
    expect((await readCodexSelection(options)).hiddenProfiles).toEqual([]);
  });
});
