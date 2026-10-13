// Runs in a worker: complete local journals, not the canvas's bounded call list.
export async function buildToolAuditReport({ files, query, now, meta }, { createReadStream, createInterface }) {
const DAY = 86400000;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const valid = r => /^[a-f0-9]{64}$/.test(r?.id ?? '') && ['claude', 'codex'].includes(r.provider)
  && ['start', 'end'].includes(r.kind) && finite(r.t) && (r.at === null || finite(r.at))
  && ['hook', 'rollout'].includes(r.clock)
  && (r.kind === 'end' ? typeof r.failed === 'boolean' : typeof r.tool === 'string' && r.tool.length <= 100
    && Array.isArray(r.operations) && r.operations.length > 0 && r.operations.length <= 16
    && r.operations.every(s => typeof s === 'string' && s.length <= 150));
const percentile = (sorted, p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  const calls = new Map(); let corrupt = 0, duplicates = 0;
  // Explicit failure rather than a convincing-looking partial report.
  for (const file of files) {
    if (file.size > 64 * 1024 * 1024) throw new Error('Daily tool history exceeds report capacity');
    if (!file.size) continue;
    const stream = createReadStream(file.path, { start: 0, end: file.size - 1, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { corrupt++; continue; }
        if (!valid(r)) { corrupt++; continue; }
        let call = calls.get(r.id);
        if (!call) { if (calls.size >= 500000) throw new Error('Tool history exceeds report capacity; choose shorter retention in Settings'); call = {}; calls.set(r.id, call); }
        if (call[r.kind]) { duplicates++; continue; }
        call[r.kind] = r;
      }
    } finally { lines.close(); stream.destroy(); }
  }
  const since = query.since ?? now - (query.days ?? 7) * DAY;
  const until = query.until ?? now;
  const groups = new Map(); let total = 0, measured = 0, failed = 0, pending = 0, orphaned = 0;
  const details = [];
  let totalMs = null, observedSince = null, observedUntil = null;
  const providers = { claude: { calls: 0, measured: 0, failed: 0 }, codex: { calls: 0, measured: 0, failed: 0 } };
  for (const [id, call] of calls) {
    const start = call.start, end = call.end;
    if (!start) { orphaned++; continue; }
    if (start.t < since || start.t > until || query.provider !== 'all' && start.provider !== query.provider) continue;
    total++; providers[start.provider].calls++;
    observedSince = observedSince === null ? start.t : Math.min(observedSince, start.t);
    observedUntil = observedUntil === null ? start.t : Math.max(observedUntil, start.t);
    const duration = end && start.clock === end.clock && finite(start.at) && finite(end.at)
      && end.at >= start.at && end.at - start.at <= 7 * DAY ? end.at - start.at : null;
    if (duration !== null) { measured++; providers[start.provider].measured++; totalMs = (totalMs ?? 0) + duration; }
    if (end?.failed) { failed++; providers[start.provider].failed++; }
    if (!end) pending++;
    const shared = start.operations.length > 1;
    for (const operation of start.operations) {
      let group = groups.get(operation);
      if (!group) { group = { operation, calls: 0, completed: 0, failed: 0, missingTiming: 0, pending: 0, shared: 0, durations: [], providers: { claude: 0, codex: 0 }, tools: new Set() }; groups.set(operation, group); }
      group.calls++; group.providers[start.provider]++; group.tools.add(start.tool);
      if (end) group.completed++; else group.pending++;
      if (end?.failed) group.failed++;
      if (shared) group.shared++;
      if (duration !== null) group.durations.push(duration); else group.missingTiming++;
      if (operation === query.operation) details.push({ id, operation, provider: start.provider, tool: start.tool,
        capturedAt: start.t, durationMs: duration, state: !end ? 'unmatched' : end.failed ? 'failed' : 'success', clock: start.clock, shared });
    }
  }
  const rows = [...groups.values()].map(g => {
    const durations = g.durations.sort((a, b) => a - b);
    const n = durations.length;
    return { operation: g.operation, calls: g.calls, completed: g.completed, failed: g.failed,
      errorRate: g.completed ? g.failed / g.completed : null, measured: n, missingTiming: g.missingTiming,
      unmatched: g.pending, shared: g.shared, providers: g.providers, tools: [...g.tools],
      totalMs: n ? durations.reduce((a, b) => a + b, 0) : null,
      medianMs: n ? n % 2 ? durations[Math.floor(n / 2)] : (durations[n / 2 - 1] + durations[n / 2]) / 2 : null,
      p95Ms: n >= 20 ? percentile(durations, .95) : null, maxMs: n ? durations.at(-1) : null };
  }).sort((a, b) => b.calls - a.calls || a.operation.localeCompare(b.operation));
  return { ok: true, capturedAt: now, since, until, provider: query.provider, total, measured, failed, unmatched: pending,
    corrupt, duplicates, orphaned, rows, totalMs, completed: total - pending, providers, observedSince, observedUntil,
    retainedSince: Math.max(meta.startedAt, Math.floor(now / DAY) * DAY - (meta.retentionDays - 1) * DAY),
    details: query.operation ? { operation: query.operation, total: details.length,
      slowest: details.filter(d => d.durationMs !== null).sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
      recent: details.sort((a, b) => b.capturedAt - a.capturedAt).slice(0, 30) } : null };
}
