// Auto-switch for Codex accounts: when the account new sessions start on is
// nearly full, move the default to another account that still has room.
// Running sessions keep the account they started on; only the registry's
// default moves, through the same selectCodexProfile the panel uses.
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { deckDataDir } from './deck-home.mjs';
import { createTemp, renameWithRetry } from './atomic-write.mjs';
import { readCodexSelection, selectCodexProfile } from './codex-selection.mjs';
import { discoverCodexProfiles, readCodexProfileQuota } from './codex-profiles.mjs';

// The same whole-percent range the page offers (CUSTOM_MIN / CUSTOM_MAX in
// src/web/auto-switch-threshold.ts). A server module must not import from the
// web tree, so the two numbers are repeated here.
const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 99;
const DEFAULT_THRESHOLD = '90';
const COOLDOWN_MS = 5 * 60_000;
const TICK_MS = 60_000;
const DAY = 86_400;
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

async function load(o) {
  let raw = {};
  try { raw = JSON.parse(await readFile(filePath(o), 'utf8')) ?? {}; } catch { /* missing or corrupt: defaults */ }
  return {
    enabled: raw.enabled === true,
    threshold: validThreshold(raw.threshold) ? raw.threshold : DEFAULT_THRESHOLD,
    next: raw.next === 'weekly' ? 'weekly' : 'room',
    heldOut: Array.isArray(raw.heldOut) ? [...new Set(raw.heldOut.filter(id => typeof id === 'string' && idPattern.test(id)))] : [],
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
  choice: { next: s.next, home: null },
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

// When the weekly window resets, if it does within 4 days; otherwise null.
function weeklyReset(live, nowSec) {
  const w = live.find(x => x.seconds >= 6 * DAY && x.resetAt != null && x.resetAt - nowSec <= 4 * DAY);
  return w ? w.resetAt : null;
}

const hasLogin = row => (row.signedIn === undefined ? row.signedInFilePresent === true : row.signedIn === true);

export async function codexAutoTick(options = {}) {
  try {
    const state = await load(options);
    if (!state.enabled) return;
    const m = mem(options);
    const now = options.now ?? Date.now;
    if (now() - m.lastSwitchAt < COOLDOWN_MS) return;
    const nowSec = Math.floor(now() / 1000);
    const threshold = Number(state.threshold);
    const readSelection = options.readSelection ?? readCodexSelection;
    const discover = options.discover ?? discoverCodexProfiles;
    const readQuota = options.readQuota ?? readCodexProfileQuota;
    const select = options.select ?? selectCodexProfile;

    const selection = await readSelection(options);
    const rows = await discover({ ...options, selection, enableNative: true });
    const home = rows.find(r => r.id === selection.profileId);
    if (!home) return;
    const readOpts = { ...options, selection, enableNative: true };
    const homeQuota = await readQuota(home.id, readOpts);
    const homeLoad = homeQuota?.ok ? loadOf(liveWindows(homeQuota, nowSec)) : null;
    if (homeLoad === null || homeLoad < threshold) return;

    // A row that is the same ChatGPT account shares the quota that just ran out.
    const roster = rows.filter(r => r.id !== home.id && r.available && hasLogin(r)
      && !state.heldOut.includes(r.id) && r.sameAccountAs !== home.id);
    const fits = [];
    for (const row of roster) { // one at a time: each read may spawn a process
      const quota = await readQuota(row.id, readOpts);
      if (!quota?.ok) continue;
      const live = liveWindows(quota, nowSec);
      const load = loadOf(live) ?? 0;
      if (load < threshold) fits.push({ id: row.id, load, reset: weeklyReset(live, nowSec) });
    }
    if (!fits.length) {
      m.lastTick = { at: now(), event: 'nowhere', reason: 'no_account_with_room' };
      return;
    }
    const soon = state.next === 'weekly' ? fits.filter(f => f.reset !== null) : [];
    const pick = soon.length ? soon.sort((a, b) => a.reset - b.reset)[0] : fits.sort((a, b) => a.load - b.load)[0];
    try {
      await select({ id: pick.id, expectedRevision: selection.revision, operationId: randomUUID() }, options);
    } catch (e) {
      if (e?.code === 'selection_conflict') return; // somebody else moved it; look again next tick
      throw e;
    }
    m.lastSwitchAt = now();
    m.lastTick = { at: now(), event: 'switched', to: pick.id, trigger: 'proactive' };
  } catch { /* a failed round is retried on the next tick */ }
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
