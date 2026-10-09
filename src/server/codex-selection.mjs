// Machine-local metadata only. This module never opens or copies credentials.
import { link, lstat, mkdir, open, readFile, realpath, rm, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { join, posix, win32, resolve } from 'node:path';
import { codexHome } from './codex-dir.mjs';
import { deckDataDir } from './deck-home.mjs';
import { createTemp, renameWithRetry } from './atomic-write.mjs';

export function configuredCodexHomes(env = process.env, home = homedir(), platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const result = [codexHome(env, home, platform)];
  let extras = [];
  try { const value = JSON.parse(env.CCDECK_CODEX_HOMES ?? '[]'); if (Array.isArray(value)) extras = value; } catch { /* optional configuration */ }
  for (const entry of extras) {
    if (typeof entry !== 'string' || !entry.trim() || !path.isAbsolute(entry.trim())) continue;
    const candidate = path.resolve(entry.trim());
    if (!result.includes(candidate)) result.push(candidate);
  }
  return result;
}

export function codexSelectionError(code) {
  return Object.assign(new Error(code), { code });
}
const fail = code => { throw codexSelectionError(code); };
const idPattern = /^[a-f0-9]{20}$/;
const operationPattern = /^[A-Za-z0-9_-]{1,128}$/;
const safeCodes = new Set(['selection_conflict', 'operation_conflict', 'selection_busy', 'unknown_profile', 'profile_unavailable', 'registry_corrupt', 'registry_write_failed', 'invalid_operation', 'invalid_revision', 'invalid_label']);
const storeDir = options => resolve(options.store ?? deckDataDir(options.platform, options.env, options.home));
export const codexSelectionPath = (options = {}) => join(storeDir(options), 'codex-accounts.json');

export async function codexProfileId(home) {
  let canonical;
  try { canonical = await realpath(home); } catch { canonical = home; }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 20);
}

async function directoryExists(home) {
  try { return (await stat(home)).isDirectory(); } catch { return false; }
}
async function validate(state, options) {
  const path = (options.platform ?? process.platform) === 'win32' ? win32 : posix;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || typeof state.originalHome !== 'string' || !path.isAbsolute(state.originalHome)
    || typeof state.selectedProfileId !== 'string' || !idPattern.test(state.selectedProfileId) || !Array.isArray(state.profiles) || !Array.isArray(state.operations)) fail('registry_corrupt');
  const ids = new Set();
  for (const p of state.profiles) {
    if (!p || typeof p.id !== 'string' || !idPattern.test(p.id) || ids.has(p.id) || typeof p.home !== 'string' || !path.isAbsolute(p.home)
      || typeof p.managed !== 'boolean' || !(p.label === null || validLabel(p.label))) fail('registry_corrupt');
    ids.add(p.id);
    if (p.managed) {
      const root = join(storeDir(options), 'codex-profiles');
      const leaf = path.basename(p.home);
      if (!/^[a-f0-9]{32}$/.test(leaf) || p.home !== join(root, leaf)) fail('registry_corrupt');
      // Never follow an externally substituted managed directory.
      try { if (!(await lstat(root)).isDirectory() || !(await lstat(p.home)).isDirectory() || await realpath(p.home) !== join(await realpath(root), leaf)) fail('registry_corrupt'); }
      catch (e) { if (e.code === 'registry_corrupt') throw e; if (e.code !== 'ENOENT') fail('profile_unavailable'); }
    }
    // Missing homes remain inspectable, with their persisted IDs.
    if (await directoryExists(p.home) && await codexProfileId(p.home) !== p.id) fail('profile_unavailable');
  }
  if (!state.profiles.some(p => p.home === state.originalHome) || !ids.has(state.selectedProfileId)) fail('registry_corrupt');
  const operations = new Set();
  for (const op of state.operations) {
    if (!op || typeof op.operationId !== 'string' || !operationPattern.test(op.operationId) || operations.has(op.operationId)
      || !['add', 'select'].includes(op.kind) || !ids.has(op.id) || !Number.isSafeInteger(op.revision)
      || op.revision < 1 || op.revision > state.revision
      || (op.kind === 'select' && (!Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 0))
      || (op.kind === 'add' && !validLabel(op.label))) fail('registry_corrupt');
    operations.add(op.operationId);
  }
  return state;
}
async function load(options) {
  try {
    const file = codexSelectionPath(options);
    if ((await lstat(file)).isSymbolicLink()) fail('registry_corrupt');
    return await validate(JSON.parse(await readFile(file, 'utf8')), options);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (['registry_corrupt', 'profile_unavailable'].includes(e.code)) throw e;
    fail('registry_corrupt');
  }
}
async function homesFor(state, options) {
  const candidates = [...configuredCodexHomes(options.env, options.home, options.platform), ...(state?.profiles.map(p => p.home) ?? [])];
  const ids = new Set(), homes = [];
  for (const home of candidates) {
    const id = state?.profiles.find(p => p.home === home)?.id ?? await codexProfileId(home);
    if (!ids.has(id)) { ids.add(id); homes.push(home); }
  }
  return homes;
}
async function snapshot(state, options) {
  const homes = await homesFor(state, options);
  const selected = state?.profiles.find(p => p.id === state.selectedProfileId);
  const home = selected?.home ?? homes[0];
  const profiles = await Promise.all(homes.map(async directory => ({
    id: state?.profiles.find(p => p.home === directory)?.id ?? await codexProfileId(directory),
    home: directory,
    available: await directoryExists(directory),
  })));
  // Absence is a recoverable state, not permission to choose another account.
  return {
    home, profileId: state?.selectedProfileId ?? await codexProfileId(home),
    revision: state?.revision ?? 0, selectionEnabled: state !== null,
    available: await directoryExists(home), homes, profiles,
    managedProfiles: (state?.profiles ?? []).filter(p => p.managed).map(({ id, label }) => ({ id, label })),
  };
}
export async function readCodexSelection(options = {}) { return snapshot(await load(options), options); }

// Immutable file locks serialize independent processes. A recovery-only OS
// mutex prevents two reclaimers from unlinking a fresh owner's replacement.
// Its kernel ownership disappears on crash, unlike a second recovery file.
async function locked(options, fn) {
  try { return await acquireAndRun(options, fn); }
  catch (e) { if (safeCodes.has(e.code)) throw e; fail('registry_write_failed'); }
}
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
async function lockRecord(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    const owner = JSON.parse(await handle.readFile('utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9]{32}$/.test(owner.nonce ?? '')) return null;
    return { ...owner, ino: info.ino, dev: info.dev };
  } catch { return null; }
  finally { await handle?.close(); }
}
const sameLock = (a, b) => a && b && a.pid === b.pid && a.nonce === b.nonce && a.ino === b.ino && a.dev === b.dev;
async function reclaimDeadLock(file, dir) {
  const observed = await lockRecord(file);
  if (!observed || ownerAlive(observed.pid)) return;
  const canonical = await realpath(dir);
  const port = 32768 + createHash('sha256').update(canonical).digest().readUInt16BE(0) % 16384;
  const mutex = createServer(socket => socket.destroy());
  const held = await new Promise(resolve => {
    mutex.once('error', () => resolve(false));
    mutex.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
  });
  if (!held) return; // occupied port: never reclaim without exclusive ownership
  try {
    const current = await lockRecord(file);
    if (!sameLock(observed, current) || ownerAlive(current.pid)) return;
    // No competing reclaimer can act between this check and unlink. A new
    // owner cannot link its lock while this dead owner's file still exists.
    const checked = await lockRecord(file);
    if (sameLock(current, checked) && !ownerAlive(checked.pid)) await unlink(file);
  } finally { await new Promise(resolve => mutex.close(resolve)); }
}
async function acquireAndRun(options, fn) {
  const dir = storeDir(options), file = join(dir, 'codex-accounts.lock');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString('hex');
  const staged = join(dir, `.codex-accounts-lock-${process.pid}-${nonce}.tmp`);
  const handle = await open(staged, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync(); }
    finally { await handle.close(); }
  } catch (e) { await unlink(staged).catch(() => {}); throw e; }
  const deadline = Date.now() + (options.lockTimeoutMs ?? 5000);
  let held = false;
  try {
    while (!held) {
      try { await link(staged, file); held = true; }
      catch (e) {
        if (e.code !== 'EEXIST') fail('registry_write_failed');
        await reclaimDeadLock(file, dir);
        if (Date.now() >= deadline) fail('selection_busy');
        await new Promise(r => setTimeout(r, 25));
      }
    }
    return await fn();
  } finally {
    if (held) {
      const record = await lockRecord(file);
      if (record?.pid === process.pid && record.nonce === nonce) await unlink(file);
    }
    await unlink(staged).catch(() => {});
  }
}
async function initial(options) {
  const state = await load(options);
  if (state) return state;
  const home = configuredCodexHomes(options.env, options.home, options.platform)[0];
  const id = await codexProfileId(home);
  return { version: 1, revision: 0, originalHome: home, selectedProfileId: id,
    profiles: [{ id, home, label: null, managed: false }], operations: [] };
}
function validLabel(label) {
  return typeof label === 'string' && label.trim() === label && label.length > 0 && label.length <= 80 && !/[\x00-\x1f\x7f/\\]/.test(label);
}
function operationId(value) { if (typeof value !== 'string' || !operationPattern.test(value)) fail('invalid_operation'); }
// Restrictive mode from creation, including the staged metadata file.
async function writeRegistryAtomic(target, text) {
  const { tmp, handle } = await createTemp(target, { mode: 0o600 });
  try {
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await renameWithRetry(tmp, target);
  } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}
async function persist(state, options) {
  try { await (options.writeFileAtomic ?? writeRegistryAtomic)(codexSelectionPath(options), JSON.stringify(state) + '\n'); }
  catch { fail('registry_write_failed'); }
}
function replay(state, operationId, kind, matches) {
  const op = state.operations.find(o => o.operationId === operationId);
  if (op && (op.kind !== kind || !matches(op))) fail('operation_conflict');
  return op;
}
export async function selectCodexProfile({ id, expectedRevision, operationId: operation } = {}, options = {}) {
  operationId(operation);
  if (typeof id !== 'string' || !idPattern.test(id)) fail('unknown_profile');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('invalid_revision');
  return locked(options, async () => {
    const state = await initial(options);
    if (replay(state, operation, 'select', o => o.id === id && o.expectedRevision === expectedRevision)) {
      return { ...await snapshot(state, options), status: 'applied_for_new_sessions' };
    }
    if (state.revision !== expectedRevision) fail('selection_conflict');
    const homes = await homesFor(state, options);
    let home;
    for (const candidate of homes) if ((state.profiles.find(p => p.home === candidate)?.id ?? await codexProfileId(candidate)) === id) { home = candidate; break; }
    if (!home) fail('unknown_profile');
    if (!await directoryExists(home)) fail('profile_unavailable');
    if (!state.profiles.some(p => p.id === id)) state.profiles.push({ id, home, label: null, managed: false });
    state.selectedProfileId = id;
    state.revision++;
    state.operations.push({ operationId: operation, kind: 'select', id, expectedRevision, revision: state.revision });
    const result = await snapshot(state, options);
    await persist(state, options);
    return { ...result, status: 'applied_for_new_sessions' };
  });
}
export async function addCodexProfile({ label, operationId: operation } = {}, options = {}) {
  operationId(operation);
  if (!validLabel(label)) fail('invalid_label');
  return locked(options, async () => {
    const state = await initial(options);
    const previous = replay(state, operation, 'add', o => o.label === label);
    if (previous) return { ...await snapshot(state, options), id: previous.id, profile: { id: previous.id, label, managed: true } };
    const root = join(storeDir(options), 'codex-profiles');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) fail('registry_corrupt');
    const home = join(root, randomBytes(16).toString('hex'));
    await mkdir(home, { mode: 0o700 });
    try {
      const id = await codexProfileId(home);
      state.profiles.push({ id, home, label, managed: true });
      state.revision++;
      state.operations.push({ operationId: operation, kind: 'add', id, label, revision: state.revision });
      const result = await snapshot(state, options);
      await persist(state, options);
      return { ...result, id, profile: { id, label, managed: true } };
    } catch (e) { await rm(home, { recursive: true, force: true }); throw e; }
  });
}

