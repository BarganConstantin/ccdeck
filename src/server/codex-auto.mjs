// Auto-switch for Codex accounts: when the account new sessions start on is
// nearly full, move the default to another account that still has room.
// This loop moves only the registry's default, through selectCodexProfile.
// Managed exec continuation is a separate adapter of the shared account engine.
//
// A HOME ACCOUNT, as Claude's has (account-choice.mjs), by the same rules: it
// is the first place a full account goes; Auto-switch takes the default back
// there once it has room again, but only from an account Auto-switch moved to
// and only after the move has settled — never from one somebody picked by hand;
// and setting a home while elsewhere moves there on the next tick. Home is a
// profile, kept by its id, since a Codex account here is a folder.
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { deckDataDir } from './deck-home.mjs';
import { createTemp, renameWithRetry } from './atomic-write.mjs';
import { readCodexSelection, selectCodexProfile } from './codex-selection.mjs';
import { discoverCodexProfiles, readCodexProfileQuota } from './codex-profiles.mjs';
import { chooseEngineAccount } from './account-engine.mjs';

// The same whole-percent range the page offers (CUSTOM_MIN / CUSTOM_MAX in
// src/web/auto-switch-threshold.ts). A server module must not import from the
// web tree, so the two numbers are repeated here.
const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 99;
const DEFAULT_THRESHOLD = '90';
const COOLDOWN_MS = 5 * 60_000;
const TICK_MS = 60_000;
/** How far under the threshold home must sit to be landed on, so a full
 *  account is not left for one that fills again at once (ROOM_MARGIN_PCT). */
const ROOM_MARGIN_PCT = 5;
/** How long after a move the way back home waits (SETTLE_MS). */
const SETTLE_MS = 30 * 60_000;
/** A reading older than this is not landed on, as chooseEngineAccount. */
const FRESH_FOR_MS = 15 * 60_000;
const idPattern = /^[a-f0-9]{20}$/;

const storeDir = o => resolve(o.store ?? deckDataDir());
const filePath = o => join(storeDir(o), 'codex-auto.json');

// Last tick and cooldown live in memory only, one set per store.
const memory = new Map();
const mem = o => {
  const key = storeDir(o);
  if (!memory.has(key)) memory.set(key, { lastTick: null, lastSwitchAt: 0 });
  return memory.get(key);
};

function validThreshold(v) {
  if (typeof v !== 'string' || !/^\d{1,3}$/.test(v)) return false;
  const n = Number(v);
  return n >= THRESHOLD_MIN && n <= THRESHOLD_MAX;
}

const idOrNull = v => (typeof v === 'string' && idPattern.test(v) ? v : null);

async function load(o) {
  let raw = {};
  try { raw = JSON.parse(await readFile(filePath(o), 'utf8')) ?? {}; } catch { /* missing or corrupt: defaults */ }
  return {
    enabled: raw.enabled === true,
    threshold: validThreshold(raw.threshold) ? raw.threshold : DEFAULT_THRESHOLD,
    next: raw.next === 'weekly' ? 'weekly' : 'room',
    heldOut: Array.isArray(raw.heldOut) ? [...new Set(raw.heldOut.filter(id => typeof id === 'string' && idPattern.test(id)))] : [],
    home: idOrNull(raw.home),
    // A home was just set, so the next tick may take the default there.
    goHome: raw.goHome === true && idOrNull(raw.home) != null,
    // The default in use was picked by hand, so the optional way home leaves
    // it alone until it fills or a home is set.
    manual: raw.manual === true,
    // The default the last tick saw, which is how a pick by hand is told from
    // one of Auto-switch's own.
    lastActive: idOrNull(raw.lastActive),
    movedAt: Number.isFinite(raw.movedAt) ? raw.movedAt : 0,
  };
}

async function save(o, state) {
  const target = filePath(o);
  await mkdir(dirname(target), { recursive: true });
  const { tmp, handle } = await createTemp(target, { mode: 0o600 });
  try {
    try { await handle.writeFile(JSON.stringify(state) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await renameWithRetry(tmp, target);
  } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}

const statusOf = (o, s) => ({
  ok: true,
  enabled: s.enabled,
  external: false,
  lastTick: mem(o).lastTick,
  settings: { 'autoswitch.threshold': { value: s.threshold, isDefault: s.threshold === DEFAULT_THRESHOLD } },
  // `home` is Claude's shape (an email and an organization); a Codex home is a
  // profile, so it travels as `homeId` and `home` stays empty.
  choice: { next: s.next, home: null },
  homeId: s.home,
  heldOut: s.heldOut,
});

export async function readCodexAuto(options = {}) {
  return statusOf(options, await load(options));
}

// Writes are read-modify-write, so two quick posts must not interleave.
let writes = Promise.resolve();

export function applyCodexAuto(body, options = {}) {
  const run = writes.then(() => apply(body, options));
  writes = run.catch(() => {});
  return run;
}

/** What a tick learned, written over the file as it is when the write runs —
 *  in the same queue as the panel's writes, so neither undoes the other. */
function update(options, change) {
  const run = writes.then(async () => {
    const state = await load(options);
    const next = change(state);
    if (next && JSON.stringify(next) !== JSON.stringify(state)) await save(options, next);
  });
  writes = run.catch(() => {});
  return run;
}

async function apply(body, options) {
  const bad = { ok: false, reason: 'bad_request' };
  if (!body || typeof body !== 'object') return bad;
  const state = await load(options);
  switch (body.action) {
    case 'enable':
      if (typeof body.enabled !== 'boolean') return bad;
      state.enabled = body.enabled;
      break;
    case 'setting':
      if (body.key !== 'autoswitch.threshold' || !validThreshold(body.value)) return bad;
      state.threshold = body.value;
      break;
    case 'next':
      if (body.value !== 'room' && body.value !== 'weekly') return bad;
      state.next = body.value;
      break;
    case 'account':
      if (typeof body.id !== 'string' || !idPattern.test(body.id) || typeof body.enabled !== 'boolean') return bad;
      state.heldOut = state.heldOut.filter(id => id !== body.id);
      if (!body.enabled) state.heldOut.push(body.id);
      break;
    case 'home':
      // One home; null removes it. Set with Auto-switch on or off, as Claude's:
      // a tick reads it only while the switch is on.
      if (body.id !== null && idOrNull(body.id) == null) return bad;
      state.home = body.id;
      state.goHome = body.id !== null;
      state.manual = false;
      break;
    default:
      return bad;
  }
  try { await save(options, state); } catch { return { ok: false, reason: 'write_failed' }; }
  return statusOf(options, state);
}

// Only windows that have not reset count: a reset window's percent is old news.
const liveWindows = (quota, nowSec) =>
  (quota?.windows ?? []).filter(w => Number.isFinite(w.usedPercent) && (w.resetAt == null || w.resetAt > nowSec));
const loadOf = live => (live.length ? Math.max(...live.map(w => w.usedPercent)) : null);

const hasLogin = row => (row.signedIn === undefined ? row.signedInFilePresent === true : row.signedIn === true);

/** Two profiles that are one ChatGPT account share one quota, so being on
 *  either is being on it. */
const sameLogin = (a, b) => a.id === b.id || a.sameAccountAs === b.id || b.sameAccountAs === a.id
  || (a.sameAccountAs != null && a.sameAccountAs === b.sameAccountAs);

/** What the notifications call a profile: its own name, else who it is signed
 *  in as, else the row's label. */
const nameOf = row => row.managedLabel || row.account || row.label || null;

/**
 * One round of the loop. `options.onTick`, when given, is told what the round
 * did (account-watch.mjs `noteCodexAutoTick`, which says the swap notice):
 * `{ enabled: false }` while the loop is off; else `threshold` and `switched`,
 * `reason: 'cooldown'` while the last move settles, and for a move `from`,
 * `to`, `used` and `trigger`. A round that failed tells nothing.
 */
export async function codexAutoTick(options = {}) {
  let outcome = null;
  try { outcome = await tickOnce(options); } catch { /* a failed round is retried on the next tick */ }
  if (outcome) {
    try { options.onTick?.(outcome); } catch { /* never the loop's problem */ }
  }
}

async function tickOnce(options) {
  const state = await load(options);
  if (!state.enabled) return { enabled: false };
  const m = mem(options);
  const now = options.now ?? Date.now;
  const threshold = Number(state.threshold);
  const stayed = { enabled: true, threshold, switched: false };
  if (now() - m.lastSwitchAt < COOLDOWN_MS) return { ...stayed, reason: 'cooldown' };
  const nowSec = Math.floor(now() / 1000);
  const readSelection = options.readSelection ?? readCodexSelection;
  const discover = options.discover ?? discoverCodexProfiles;
  const readQuota = options.readQuota ?? readCodexProfileQuota;
  const select = options.select ?? selectCodexProfile;

  const selection = await readSelection(options);
  const rows = await discover({ ...options, selection, enableNative: true });
  const current = rows.find(r => r.id === selection.profileId);
  if (!current) return stayed;
  const homeRow = state.home ? rows.find(r => r.id === state.home) ?? null : null;
  const onHome = homeRow != null && sameLogin(homeRow, current);

  // WHO PICKED THE DEFAULT IN USE. One the last tick did not see is a pick
  // by hand — the panel's Switch, or Codex itself — and stays picked until it
  // fills or a home is set. Written over the file as it is now only when the
  // person has not changed home since it was read, or this would undo them.
  const manual = state.manual || (state.lastActive != null && state.lastActive !== current.id);
  const goHome = state.goHome && !onHome;
  if (manual !== state.manual || goHome !== state.goHome || state.lastActive !== current.id) {
    await update(options, s => (s.home === state.home && s.goHome === state.goHome && s.manual === state.manual
      ? { ...s, manual, goHome, lastActive: current.id }
      : { ...s, lastActive: current.id }));
  }

  const readOpts = { ...options, selection, enableNative: true };
  const currentQuota = await readQuota(current.id, readOpts);
  // Only a reading taken now says how full an account is: the last good one
  // kept for a failed read is an old number, and acting on it moves sessions
  // for a window that may have reset, or onto an account that has since filled.
  const currentLoad = currentQuota?.ok && !currentQuota.stale ? loadOf(liveWindows(currentQuota, nowSec)) : null;
  if (currentLoad === null) return stayed;

  // Home has room: in rotation, signed in, read recently, and comfortably
  // under the threshold on every window that has not reset.
  const homeHasRoom = async () => {
    if (!homeRow || onHome || homeRow.available === false || !hasLogin(homeRow) || state.heldOut.includes(homeRow.id)) return false;
    const q = await readQuota(homeRow.id, readOpts);
    if (!q?.ok || q.stale || (Number.isFinite(q.fetchedAt) && now() - q.fetchedAt > FRESH_FOR_MS)) return false;
    const load = loadOf(liveWindows(q, nowSec));
    return load !== null && load < threshold - ROOM_MARGIN_PCT;
  };
  /** Move the default to `row`; what the round did, for the notifications. */
  const move = async (row, trigger) => {
    try {
      await select({ id: row.id, expectedRevision: selection.revision, operationId: randomUUID() }, options);
    } catch (e) {
      if (e?.code === 'selection_conflict') return stayed; // somebody else moved it; look again next tick
      throw e;
    }
    m.lastSwitchAt = now();
    m.lastTick = { at: now(), event: 'switched', to: row.id, trigger };
    await update(options, s => ({ ...s, manual: false, lastActive: row.id, movedAt: now(), goHome: s.goHome && row.id !== s.home }));
    return {
      ...stayed, switched: true, trigger, used: currentLoad,
      from: { id: current.id, name: nameOf(current) }, to: { id: row.id, name: nameOf(row) },
    };
  };

  if (currentLoad >= threshold) {
    // HAS TO LEAVE: home first, then the account the engine picks.
    if (await homeHasRoom()) return move(homeRow, 'home');
    // A row that is the same ChatGPT account shares the quota that just ran out.
    const roster = rows.filter(r => r.id !== current.id && r.available && hasLogin(r)
      && !state.heldOut.includes(r.id) && r.sameAccountAs !== current.id);
    const quotas = new Map();
    for (const row of roster) { // one at a time: each read may spawn a process
      quotas.set(row.id, await readQuota(row.id, readOpts));
    }
    const pick = chooseEngineAccount(roster, quotas, { threshold, next: state.next, nowSec });
    const target = pick ? roster.find(r => r.id === pick.id) : null;
    if (!target) {
      m.lastTick = { at: now(), event: 'nowhere', reason: 'no_account_with_room' };
      return stayed;
    }
    return move(target, 'proactive');
  }

  // BELOW THE THRESHOLD the one move made is the way home, and it is
  // optional: never from home itself, never from a pick by hand, and only
  // once the last move has settled — unless a home was just set, when the
  // person asked to be taken there.
  if (!homeRow || onHome) return stayed;
  const settled = now() - Math.max(m.lastSwitchAt, state.movedAt) >= SETTLE_MS;
  if ((goHome || (!manual && settled)) && await homeHasRoom()) return move(homeRow, 'home');
  return stayed;
}

let stopLoop = null;

export function startCodexAutoLoop(options = {}) {
  if (stopLoop) return stopLoop;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await codexAutoTick(options); } catch { /* the tick never throws; belt and braces */ }
    finally { running = false; }
  }, TICK_MS);
  timer.unref();
  stopLoop = () => { clearInterval(timer); stopLoop = null; };
  return stopLoop;
}
