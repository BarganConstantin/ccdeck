// Provider-independent selection and continuation. Claude deliberately keeps its
// existing cswap path; only an explicitly supplied adapter can run this engine.
export function chooseEngineAccount(rows, quotas, { threshold = 90, next = 'room', heldOut = [], exclude = [], nowSec = Date.now() / 1000 } = {}) {
  const excluded = new Set([...heldOut, ...exclude]);
  const fits = rows.flatMap(row => {
    if (excluded.has(row.id) || excluded.has(row.sameAccountAs) || row.available === false
      || !(row.signedIn ?? row.signedInFilePresent)) return [];
    const q = quotas.get(row.id);
    if (!q?.ok || q.stale || Number.isFinite(q.fetchedAt) && nowSec * 1000 - q.fetchedAt > 15 * 60_000) return [];
    const windows = (q.windows ?? []).filter(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && (w.resetAt == null || w.resetAt > nowSec));
    // An empty or expired reading is unknown, never unlimited room.
    if (!windows.length) return [];
    const load = Math.max(...windows.map(w => w.usedPercent));
    if (load >= threshold) return [];
    const weekly = windows.find(w => w.seconds >= 6 * 86400 && w.resetAt != null && w.resetAt - nowSec <= 4 * 86400);
    return [{ id: row.id, load, reset: weekly?.resetAt ?? null }];
  });
  const soon = next === 'weekly' ? fits.filter(f => f.reset !== null) : [];
  return (soon.length ? soon.sort((a, b) => a.reset - b.reset || a.load - b.load) : fits.sort((a, b) => a.load - b.load))[0] ?? null;
}

/** Every retry starts only after the adapter has observed the previous process
 * exit and a terminal usage-limit failure. No retry of a partial/unknown result,
 * no `--last`, no global account change, no repeated account in the same run. */
export async function runAccountEngine(adapter, initial, { signal, onSwitch = () => {} } = {}) {
  const tried = new Set();
  let current = initial;
  let threadId = initial.threadId ?? null;
  for (let attempt = 0; attempt < 32; attempt++) {
    if (signal?.aborted) return { code: 130, reason: 'cancelled' };
    tried.add(current.id);
    const result = await adapter.run(current, { signal });
    if (signal?.aborted) return { ...result, reason: 'cancelled' };
    const manual = result.reason === 'manual_switch';
    if ((!manual && result.reason !== 'usage_limit') || !result.threadId || result.code === 0) return result;
    if (!manual && threadId && threadId !== result.threadId) return { ...result, reason: 'thread_changed' };
    threadId = result.threadId;
    const settings = await adapter.settings();
    if (!manual && !settings.enabled) return { ...result, reason: 'disabled' };
    const rows = await adapter.accounts();
    const source = rows.find(row => row.id === current.id);
    if (!source) return { ...result, reason: 'source_unavailable' };
    let pick;
    if (manual) {
      const target = rows.find(row => row.id === result.targetId && row.id !== current.id && row.available !== false && (row.signedIn ?? row.signedInFilePresent));
      if (!target) return { ...result, reason: 'target_unavailable' };
      pick = { id: target.id };
    } else {
      const exclude = [...tried];
      for (const row of rows) if (row.sameAccountAs === current.id || source.sameAccountAs === row.id
        || source.sameAccountAs && row.sameAccountAs === source.sameAccountAs) exclude.push(row.id);
      const quotas = new Map();
      for (const row of rows) {
        if (signal?.aborted) return { ...result, reason: 'cancelled' };
        if (!exclude.includes(row.id) && !settings.heldOut?.includes(row.id)) {
          try { quotas.set(row.id, await adapter.quota(row.id)); } catch { /* unavailable is not room */ }
        }
      }
      pick = chooseEngineAccount(rows, quotas, { ...settings, exclude });
      if (!pick) return { ...result, reason: 'no_account_with_room' };
      const latest = await adapter.settings();
      if (!latest.enabled || signal?.aborted) return { ...result, reason: 'cancelled' };
      if (!chooseEngineAccount(rows.filter(row => row.id === pick.id), quotas, { ...latest, exclude })) return { ...result, reason: 'settings_changed' };
    }
    // Do not move a stopped rollout into an account we cannot launch.
    if (!manual && attempt === 31) return { ...result, reason: 'attempt_limit' };
    let next;
    try { next = await adapter.prepare({ from: current, id: pick.id, threadId }); }
    catch { return { ...result, reason: 'handoff_failed' }; }
    const abandon = async reason => {
      try { await next.restoreSource?.(); }
      catch { return { ...result, reason: 'handoff_failed' }; }
      return { ...result, reason };
    };
    if (signal?.aborted) return abandon('cancelled');
    let beforeLaunch;
    try { beforeLaunch = await adapter.settings(); }
    catch { return abandon('handoff_failed'); }
    if (signal?.aborted) return abandon('cancelled');
    if (!manual && (!beforeLaunch.enabled || beforeLaunch.heldOut?.includes(next.id))) return abandon('disabled');
    try { onSwitch({ from: current.id, to: next.id, threadId }); }
    catch { return abandon('handoff_failed'); }
    if (manual) { tried.clear(); attempt = -1; }
    current = next;
  }
  return { code: 1, reason: 'attempt_limit', threadId };
}
