// The server's half of Codex's account rows: a name kept for any account, and two
// rows on one ChatGPT login told apart from two accounts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCodexProfile, moveCodexLogin, readCodexSelection, renameCodexProfile, selectCodexProfile } from '../../server/codex-selection.mjs';
import { discoverCodexProfiles, replaceCodexLogin } from '../../server/codex-profiles.mjs';

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

describe('a sign-in that landed on an account already here', () => {
  const defaultFile = () => join(root, '.codex', 'auth.json');
  const homeOf = async (id: string) => (await readCodexSelection(options)).homes.find(home => home.includes('codex-profiles'))!;
  const sameAccount = signedIn(() => 'one@example.com');
  /** Both homes signed in, the default's login the older one. */
  async function landed() {
    const added = await addCodexProfile({ operationId: 'add-one' }, options);
    const { profileId } = await readCodexSelection(options);
    await writeFile(defaultFile(), 'old login', { mode: 0o600 });
    await writeFile(join(await homeOf(added.id), 'auth.json'), 'new login', { mode: 0o600 });
    return { id: added.id, into: profileId };
  }

  it('gives the account the new login, keeps its row and its default, and takes the new row back', async () => {
    const { id, into } = await landed();
    await renameCodexProfile({ id: into, label: 'personal', expectedRevision: await revision() }, options);
    const made = await homeOf(id);
    const out = await replaceCodexLogin({ id, into, expectedRevision: await revision() }, { ...options, nativeRead: sameAccount });
    expect(out.status).toBe('replaced');
    expect(await readFile(defaultFile(), 'utf8')).toBe('new login');
    if (process.platform !== 'win32') expect((await stat(defaultFile())).mode & 0o777).toBe(0o600);
    const selection = await readCodexSelection(options);
    expect(selection.profileId).toBe(into);
    expect(selection.homes).toHaveLength(1);
    expect(selection.profileLabels?.find(p => p.id === into)?.label).toBe('personal');
    // Moved, not copied: the folder set aside holds no second copy of the login.
    await expect(stat(made)).rejects.toMatchObject({ code: 'ENOENT' });
    const trash = join(options.store, 'codex-profiles-removed');
    for (const folder of await readdir(trash)) expect(await readdir(join(trash, folder))).not.toContain('auth.json');
  });

  it('never moves a login between two accounts', async () => {
    const { id, into } = await landed();
    const two = signedIn(home => home.includes('codex-profiles') ? 'two@example.com' : 'one@example.com');
    await expect(replaceCodexLogin({ id, into, expectedRevision: await revision() }, { ...options, nativeRead: two }))
      .rejects.toMatchObject({ code: 'not_same_account' });
    expect(await readFile(defaultFile(), 'utf8')).toBe('old login');
    expect((await readCodexSelection(options)).homes).toHaveLength(2);
  });

  it('does not take two workspaces of one address and plan for one account', async () => {
    const { id, into } = await landed();
    const login = (account: string) => JSON.stringify({ tokens: { account_id: account } });
    await writeFile(defaultFile(), login('workspace-a'));
    await writeFile(join(await homeOf(id), 'auth.json'), login('workspace-b'));
    await expect(replaceCodexLogin({ id, into, expectedRevision: await revision() }, { ...options, nativeRead: sameAccount }))
      .rejects.toMatchObject({ code: 'not_same_account' });
    expect(await readFile(defaultFile(), 'utf8')).toBe(login('workspace-a'));
  });

  it('leaves everything as it was when the account keeps its login somewhere that cannot be moved to', async () => {
    const { id, into } = await landed();
    await rm(defaultFile());
    await expect(moveCodexLogin({ id, into, expectedRevision: await revision() }, options)).rejects.toMatchObject({ code: 'login_not_movable' });
    await expect(stat(defaultFile())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(await homeOf(id), 'auth.json'), 'utf8')).toBe('new login');
    expect((await readCodexSelection(options)).homes).toHaveLength(2);
  });

  it('refuses a stale revision, an unknown row, itself, and a home the deck did not make', async () => {
    const { id, into } = await landed();
    const current = await revision();
    await expect(moveCodexLogin({ id, into, expectedRevision: 0 }, options)).rejects.toMatchObject({ code: 'selection_conflict' });
    await expect(moveCodexLogin({ id, into: 'f'.repeat(20), expectedRevision: current }, options)).rejects.toMatchObject({ code: 'unknown_profile' });
    await expect(moveCodexLogin({ id, into: id, expectedRevision: current }, options)).rejects.toMatchObject({ code: 'unknown_profile' });
    await expect(moveCodexLogin({ id: into, into: id, expectedRevision: current }, options)).rejects.toMatchObject({ code: 'not_removable' });
    expect(await readFile(defaultFile(), 'utf8')).toBe('old login');
  });
});
