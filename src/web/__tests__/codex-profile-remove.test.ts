import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexProfiles } from '../../server/codex-profiles.mjs';
import { addCodexProfile, codexProfileId, codexSelectionPath, readCodexSelection, removeCodexProfile, selectCodexProfile } from '../../server/codex-selection.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-remove-')); roots.push(root);
  const original = join(root, 'original'), store = join(root, 'store');
  await mkdir(original);
  const options = { store, env: { CODEX_HOME: original } };
  return { root, original, store, options };
}

describe('removing a Codex profile', () => {
  it('unlists a managed profile, keeps its folder aside and leaves the others alone', async () => {
    const { options, original, store } = await fixture();
    const added = await addCodexProfile({ label: 'Work', operationId: 'add-work' }, options);
    const home = (await readCodexSelection(options)).profiles.find((p: { id: string }) => p.id === added.id)!.home;
    await writeFile(join(home, 'auth.json'), '{"sign":"in"}');
    const removed = await removeCodexProfile({ id: added.id, expectedRevision: added.revision }, options);
    expect(removed).toMatchObject({ status: 'removed', revision: added.revision + 1 });
    const after = await readCodexSelection(options);
    expect(after.profiles.map((p: { id: string }) => p.id)).toEqual([await codexProfileId(original)]);
    expect(after.managedProfiles).toEqual([]);
    // Not deleted: the folder, with its sign-in, waits in codex-profiles-removed.
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    const kept = await readdir(join(store, 'codex-profiles-removed'));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(store, 'codex-profiles-removed', kept[0], 'auth.json'), 'utf8')).toBe('{"sign":"in"}');
  });

  it('falls back to the original home when the default account is removed, and stays loadable', async () => {
    const { options, original } = await fixture();
    const added = await addCodexProfile({ label: 'Work', operationId: 'add-work' }, options);
    const selected = await selectCodexProfile({ id: added.id, expectedRevision: added.revision, operationId: 'pick' }, options);
    expect(selected.profileId).toBe(added.id);
    const removed = await removeCodexProfile({ id: added.id, expectedRevision: selected.revision }, options);
    expect(removed.profileId).toBe(await codexProfileId(original));
    // The registry still validates: the operations naming the profile went with it.
    const saved = JSON.parse(await readFile(codexSelectionPath(options), 'utf8'));
    expect(saved.operations).toEqual([]);
    expect((await readCodexSelection(options)).profileId).toBe(await codexProfileId(original));
  });

  it('refuses the original home, an unknown profile, a stale revision and a bad id', async () => {
    const { options, original } = await fixture();
    const added = await addCodexProfile({ label: 'Work', operationId: 'add-work' }, options);
    await expect(removeCodexProfile({ id: await codexProfileId(original), expectedRevision: added.revision }, options)).rejects.toMatchObject({ code: 'not_removable' });
    await expect(removeCodexProfile({ id: 'a'.repeat(20), expectedRevision: added.revision }, options)).rejects.toMatchObject({ code: 'unknown_profile' });
    await expect(removeCodexProfile({ id: added.id, expectedRevision: added.revision + 5 }, options)).rejects.toMatchObject({ code: 'selection_conflict' });
    await expect(removeCodexProfile({ id: '../etc', expectedRevision: 0 }, options)).rejects.toMatchObject({ code: 'unknown_profile' });
    await expect(removeCodexProfile({ id: added.id, expectedRevision: -1 }, options)).rejects.toMatchObject({ code: 'invalid_revision' });
    // Nothing changed.
    expect((await readCodexSelection(options)).managedProfiles).toHaveLength(1);
  });

  it('adds an account with no name, lists it as the deck\'s own, and removes it like any other', async () => {
    const { options } = await fixture();
    const added = await addCodexProfile({ operationId: 'add-unnamed' }, options);
    expect(added.profile).toMatchObject({ id: added.id, label: null, managed: true });
    // The registry with a nameless account still validates when read back.
    const profiles = await discoverCodexProfiles(options);
    const mine = profiles.find((p: { id: string }) => p.id === added.id);
    // Until it is signed in it has only a placeholder name, and it says it is the deck's own.
    expect(mine).toMatchObject({ managed: true, label: expect.stringMatching(/^Codex profile \d+$/) });
    expect(mine.managedLabel).toBeUndefined();
    expect(profiles.find((p: { id: string }) => p.id !== added.id)).not.toHaveProperty('managed');
    await expect(addCodexProfile({ label: 'bad/name', operationId: 'add-bad' }, options)).rejects.toMatchObject({ code: 'invalid_label' });
    const removed = await removeCodexProfile({ id: added.id, expectedRevision: added.revision }, options);
    expect(removed.status).toBe('removed');
  });
});
