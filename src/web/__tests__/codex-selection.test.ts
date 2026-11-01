import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { addCodexProfile, codexProfileId, codexSelectionPath, readCodexSelection, selectCodexProfile } from '../../server/codex-selection.mjs';
import { configuredCodexHomes, codexProfileLaunchCommand, codexProfileSessionDirs, discoverCodexProfiles, readCodexProfileQuota, resolveCodexProfile } from '../../server/codex-profiles.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-selection-')); roots.push(root);
  const original = join(root, 'original'), alternate = join(root, 'alternate'), store = join(root, 'store');
  await mkdir(original); await mkdir(alternate);
  const options = { store, env: { CODEX_HOME: original, CCDECK_CODEX_HOMES: JSON.stringify([alternate]) } };
  return { root, original, alternate, store, options };
}

describe('machine-local Codex selection', () => {
  it('preserves synchronous startup homes and reads an uninitialized selection without writing', async () => {
    const { options, original, alternate, root } = await fixture();
    expect(configuredCodexHomes(options.env)).toEqual([original, alternate]);
    expect(await readCodexSelection(options)).toMatchObject({ home: original, profileId: await codexProfileId(original), revision: 0, selectionEnabled: false, homes: [original, alternate] });
    expect(await readdir(root)).not.toContain('store');
  });

  it('persists selection independently of subsequent startup environment and preserves original home', async () => {
    const { options, original, alternate } = await fixture();
    const id = await codexProfileId(alternate);
    expect(await selectCodexProfile({ id, expectedRevision: 0, operationId: 'select-a' }, options)).toMatchObject({ home: alternate, revision: 1, status: 'applied_for_new_sessions' });
    const restarted = { ...options, env: { CODEX_HOME: alternate } };
    expect(await readCodexSelection(restarted)).toMatchObject({ home: alternate, profileId: id, homes: [alternate, original] });
    expect(JSON.parse(await readFile(codexSelectionPath(options), 'utf8')).originalHome).toBe(original);
    expect(await readdir(original)).toEqual([]);
  });

  it('replays operations before checking revision and rejects conflicting reuse', async () => {
    const { options, original, alternate } = await fixture();
    const input = { id: await codexProfileId(alternate), expectedRevision: 0, operationId: 'select-a' };
    await selectCodexProfile(input, options);
    expect((await selectCodexProfile(input, options)).revision).toBe(1);
    await expect(selectCodexProfile({ ...input, id: await codexProfileId(original) }, options)).rejects.toMatchObject({ code: 'operation_conflict' });
    await expect(selectCodexProfile({ ...input, operationId: 'select-b' }, options)).rejects.toMatchObject({ code: 'selection_conflict' });
  });

  it('serializes independent processes so only one optimistic revision wins', async () => {
    const { options, original, alternate } = await fixture();
    const moduleUrl = new URL('../../server/codex-selection.mjs', import.meta.url).href;
    const run = promisify(execFile);
    const child = (id: string, operationId: string) => run(process.execPath, ['--input-type=module', '-e',
      `import {selectCodexProfile} from ${JSON.stringify(moduleUrl)}; try { const s = await selectCodexProfile(${JSON.stringify({ id, operationId, expectedRevision: 0 })}, ${JSON.stringify(options)}); process.stdout.write(JSON.stringify(s)); } catch(e) {process.stdout.write(JSON.stringify({code:e.code}));}`]);
    const answers = await Promise.all([child(await codexProfileId(original), 'process-a'), child(await codexProfileId(alternate), 'process-b')]);
    const values = answers.map(a => JSON.parse(a.stdout));
    expect(values.filter(v => v.status === 'applied_for_new_sessions')).toHaveLength(1);
    expect(values.filter(v => v.code === 'selection_conflict')).toHaveLength(1);
    expect((await readCodexSelection(options)).revision).toBe(1);
  });

  it('adds isolated managed homes idempotently without selecting or creating credentials', async () => {
    const { options, original, store } = await fixture();
    const input = { label: 'Work', operationId: 'add-a' };
    const first = await addCodexProfile(input, options), second = await addCodexProfile(input, options);
    expect(second.id).toBe(first.id); expect(second.revision).toBe(1); expect(second.home).toBe(original);
    expect(await readdir(join(store, 'codex-profiles'))).toHaveLength(1);
    const home = await resolveCodexProfile(first.id, options);
    expect(home).toBeTruthy(); expect(await readdir(home!)).toEqual([]);
    expect(first.profile).toEqual({ id: first.id, label: 'Work', managed: true });
    if (process.platform !== 'win32') {
      expect((await stat(codexSelectionPath(options))).mode & 0o777).toBe(0o600);
      expect((await stat(home!)).mode & 0o777).toBe(0o700);
    }
    await expect(addCodexProfile({ ...input, label: 'Personal' }, options)).rejects.toMatchObject({ code: 'operation_conflict' });
  });

  it('rolls back an added directory on atomic-write failure and leaves selection unchanged', async () => {
    const { options, store } = await fixture();
    const before = await readCodexSelection(options);
    const failing = { ...options, writeFileAtomic: async () => { throw new Error('private/path'); } };
    await expect(addCodexProfile({ label: 'Work', operationId: 'add-fail' }, failing)).rejects.toMatchObject({ code: 'registry_write_failed', message: 'registry_write_failed' });
    expect(await readdir(join(store, 'codex-profiles'))).toEqual([]);
    expect(await readCodexSelection(options)).toEqual(before);
    await addCodexProfile({ label: 'Work', operationId: 'add-fail' }, options);
  });

  it('leaves a committed selection intact if its replacement write fails', async () => {
    const { options, original, alternate } = await fixture();
    await selectCodexProfile({ id: await codexProfileId(alternate), expectedRevision: 0, operationId: 'first' }, options);
    const failing = { ...options, writeFileAtomic: async () => { throw Error('disk full'); } };
    await expect(selectCodexProfile({ id: await codexProfileId(original), expectedRevision: 1, operationId: 'second' }, failing)).rejects.toMatchObject({ code: 'registry_write_failed' });
    expect(await readCodexSelection(options)).toMatchObject({ home: alternate, revision: 1 });
  });

  it('fails closed on corrupt state but exposes a missing selection for recovery', async () => {
    const { options, original, alternate, store } = await fixture();
    await mkdir(store);
    await writeFile(codexSelectionPath(options), '{broken');
    await expect(readCodexSelection(options)).rejects.toMatchObject({ code: 'registry_corrupt' });
    await expect(addCodexProfile({ label: 'Work', operationId: 'add-a' }, options)).rejects.toMatchObject({ code: 'registry_corrupt' });
    await rm(codexSelectionPath(options));
    const selectedId = await codexProfileId(alternate);
    await selectCodexProfile({ id: selectedId, expectedRevision: 0, operationId: 'select-a' }, options);
    await rm(alternate, { recursive: true });
    const unavailable = await readCodexSelection(options);
    expect(unavailable).toMatchObject({ home: alternate, profileId: selectedId, revision: 1, available: false });
    expect((await discoverCodexProfiles({ ...options, selection: unavailable })).find(p => p.active)).toMatchObject({ id: unavailable.profileId, available: false });
    expect(await readCodexProfileQuota(unavailable.profileId, options)).toEqual({ ok: false, reason: 'profile_unavailable' });
    await expect(codexProfileLaunchCommand(unavailable.profileId, options)).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect(await selectCodexProfile({ id: await codexProfileId(original), expectedRevision: unavailable.revision, operationId: 'recover' }, options)).toMatchObject({ home: original, revision: 2, available: true });
  });

  it('recovers a killed lock owner without losing the last committed selection', async () => {
    const { options, original, alternate, store } = await fixture();
    await selectCodexProfile({ id: await codexProfileId(original), expectedRevision: 0, operationId: 'initial' }, options);
    const moduleUrl = new URL('../../server/codex-selection.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {selectCodexProfile} from ${JSON.stringify(moduleUrl)};
       await selectCodexProfile(${JSON.stringify({ id: await codexProfileId(alternate), expectedRevision: 1, operationId: 'killed' })}, {
         ...${JSON.stringify(options)}, writeFileAtomic: async () => { process.stdout.write('held\\n'); await new Promise(() => {setInterval(() => {}, 1000);}); }
       });`], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(Error('owner exited before taking the lock')));
    });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGKILL'); await exited;
    expect((await readCodexSelection(options)).revision).toBe(1);
    // Two reclaimers contend for the same dead owner's lock. Only one can
    // apply revision 1; neither may remove a freshly acquired live lock.
    const results = await Promise.allSettled([
      selectCodexProfile({ id: await codexProfileId(alternate), expectedRevision: 1, operationId: 'after-crash-a' }, options),
      selectCodexProfile({ id: await codexProfileId(original), expectedRevision: 1, operationId: 'after-crash-b' }, options),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'selection_conflict' } });
    expect((await readCodexSelection(options)).revision).toBe(2);
    expect(await readdir(store)).not.toContain('codex-accounts.lock');
  });

  it('never steals a live owner lock based on old timestamps', async () => {
    const { options, store, alternate } = await fixture();
    await mkdir(store);
    const file = join(store, 'codex-accounts.lock');
    await writeFile(file, JSON.stringify({ pid: process.pid, nonce: 'a'.repeat(32) }));
    await utimes(file, new Date(0), new Date(0));
    await expect(selectCodexProfile({ id: await codexProfileId(alternate), expectedRevision: 0, operationId: 'live' }, { ...options, lockTimeoutMs: 0 })).rejects.toMatchObject({ code: 'selection_busy' });
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(process.pid);
  });

  it('keeps a missing nonselected managed home inspectable without blocking other profiles', async () => {
    const { options, original } = await fixture();
    const added = await addCodexProfile({ label: 'Offline', operationId: 'offline' }, options);
    const managedHome = await resolveCodexProfile(added.id, options);
    await rm(managedHome!, { recursive: true });
    const selection = await readCodexSelection(options);
    expect(selection.home).toBe(original);
    expect(await discoverCodexProfiles({ ...options, selection })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: added.id, label: 'Offline', signedInFilePresent: false, active: false, available: false }),
    ]));
    await expect(selectCodexProfile({ id: added.id, expectedRevision: 1, operationId: 'missing' }, options)).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect((await selectCodexProfile({ id: await codexProfileId(original), expectedRevision: 1, operationId: 'available' }, options)).revision).toBe(2);
  });

  it('refuses occupied locks without age-based lock stealing', async () => {
    const { options, store, alternate } = await fixture();
    await mkdir(store); await writeFile(join(store, 'codex-accounts.lock'), '{}');
    await expect(selectCodexProfile({ id: await codexProfileId(alternate), expectedRevision: 0, operationId: 'locked' }, { ...options, lockTimeoutMs: 0 })).rejects.toMatchObject({ code: 'selection_busy' });
    expect(await readFile(join(store, 'codex-accounts.lock'), 'utf8')).toBe('{}');
  });

  it('uses supplied roster snapshots and includes managed homes in lookup and watching', async () => {
    const { options, original } = await fixture();
    const added = await addCodexProfile({ label: 'Work', operationId: 'add-work' }, options);
    const old = await readCodexSelection(options);
    const selected = await selectCodexProfile({ id: added.id, expectedRevision: 1, operationId: 'select-work' }, options);
    const current = await discoverCodexProfiles({ ...options, selection: selected });
    expect(current.find(p => p.active)?.id).toBe(added.id);
    expect(current.find(p => p.id === added.id)).toMatchObject({ label: 'Work', managedLabel: 'Work', signedInFilePresent: false });
    expect(JSON.stringify(current)).not.toContain(options.store);
    expect((await discoverCodexProfiles({ ...options, selection: old })).find(p => p.active)?.id).toBe(await codexProfileId(original));
    expect(await codexProfileSessionDirs(options)).toContain(join(selected.home, 'sessions'));
  });

  it('can add and select a managed profile when the original home never existed', async () => {
    const { options, original } = await fixture();
    await rm(original, { recursive: true });
    const added = await addCodexProfile({ label: 'First login', operationId: 'first-login' }, options);
    expect(added).toMatchObject({ home: original, available: false, revision: 1 });
    expect(await selectCodexProfile({ id: added.id, expectedRevision: added.revision, operationId: 'choose-first' }, options)).toMatchObject({ profileId: added.id, available: true, revision: 2 });
  });

  it('preserves the canonical ID after the literal home alias disappears', async () => {
    const { options, root, original, alternate } = await fixture();
    const alias = join(root, 'alias');
    await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliased = { ...options, env: { CODEX_HOME: alias, CCDECK_CODEX_HOMES: JSON.stringify([alternate]) } };
    const id = await codexProfileId(alias);
    await selectCodexProfile({ id, expectedRevision: 0, operationId: 'alias' }, aliased);
    await rm(alias, { recursive: true });
    expect(await codexProfileId(alias)).not.toBe(id);
    const selected = await readCodexSelection(aliased);
    expect(selected).toMatchObject({ home: alias, profileId: id, available: false, revision: 1 });
    expect((await discoverCodexProfiles({ ...aliased, selection: selected })).find(p => p.active)).toMatchObject({ id, available: false });
    expect(await selectCodexProfile({ id: await codexProfileId(alternate), expectedRevision: selected.revision, operationId: 'recover-alias' }, aliased)).toMatchObject({ home: alternate, revision: 2 });
  });

  it('rejects managed directory substitution and unsafe labels', async () => {
    const { options, alternate } = await fixture();
    await expect(addCodexProfile({ label: '/private/home', operationId: 'bad' }, options)).rejects.toMatchObject({ code: 'invalid_label' });
    const added = await addCodexProfile({ label: 'Work', operationId: 'work' }, options);
    const home = await resolveCodexProfile(added.id, options);
    await rm(home!, { recursive: true });
    await symlink(alternate, home!, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readCodexSelection(options)).rejects.toMatchObject({ code: 'registry_corrupt' });
  });
});
