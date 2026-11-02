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
    if (result.reason !== 'usage_limit' || !result.threadId || result.code === 0) return result;
    if (threadId && threadId !== result.threadId) return { ...result, reason: 'thread_changed' };
    threadId = result.threadId;
    const settings = await adapter.settings();
    if (!settings.enabled) return { ...result, reason: 'disabled' };
    const rows = await adapter.accounts();
    const source = rows.find(row => row.id === current.id);
    if (!source) return { ...result, reason: 'source_unavailable' };
    const exclude = [...tried];
    // All duplicate rows share the exhausted account's quota.
    for (const row of rows) if (row.sameAccountAs === current.id || source.sameAccountAs === row.id
      || source.sameAccountAs && row.sameAccountAs === source.sameAccountAs) exclude.push(row.id);
    const quotas = new Map();
    for (const row of rows) {
      if (signal?.aborted) return { ...result, reason: 'cancelled' };
      if (!exclude.includes(row.id) && !settings.heldOut?.includes(row.id)) {
        try { quotas.set(row.id, await adapter.quota(row.id)); } catch { /* unavailable is not room */ }
      }
    }
    const pick = chooseEngineAccount(rows, quotas, { ...settings, exclude });
    if (!pick) return { ...result, reason: 'no_account_with_room' };
    // Recheck the switch immediately before it starts; a person may turn it off
    // or hold the target out while the quota probes are running.
    const latest = await adapter.settings();
    if (!latest.enabled || signal?.aborted) return { ...result, reason: 'cancelled' };
    if (!chooseEngineAccount(rows.filter(row => row.id === pick.id), quotas, { ...latest, exclude })) return { ...result, reason: 'settings_changed' };
    let next;
    try { next = await adapter.prepare({ from: current, id: pick.id, threadId }); }
    catch { return { ...result, reason: 'handoff_failed' }; }
    if (signal?.aborted) return { ...result, reason: 'cancelled' };
    const beforeLaunch = await adapter.settings();
    if (!beforeLaunch.enabled || beforeLaunch.heldOut?.includes(next.id)) return { ...result, reason: 'disabled' };
    onSwitch({ from: current.id, to: next.id, threadId });
    current = next;
  }
  return { code: 1, reason: 'attempt_limit', threadId };
}
