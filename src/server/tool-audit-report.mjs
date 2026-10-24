// Runs in a worker: complete local journals, not the canvas's bounded call list.
export async function buildToolAuditReport({ files, query, now, meta }, { createReadStream, createInterface }) {
const DAY = 86400000;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const valid = r => /^[a-f0-9]{64}$/.test(r?.id ?? '') && ['claude', 'codex'].includes(r.provider)
  && ['start', 'end', 'skill', 'turn', 'turn-end'].includes(r.kind) && finite(r.t) && (r.at === null || finite(r.at))
  && ['hook', 'rollout'].includes(r.clock)
  // A typed or detected skill is not a tool call; Skill activity reads it. Nor is a
  // turn, which only bounds the calls made for one prompt.
  && (r.kind === 'skill' ? typeof r.skill === 'string'
    : r.kind === 'turn' ? true
    : r.kind === 'turn-end' ? typeof r.stop === 'string' && r.stop.length <= 40
    : r.kind === 'end' ? typeof r.failed === 'boolean' && (r.ms === undefined || finite(r.ms) && r.ms >= 0) && (r.asked === undefined || typeof r.asked === 'boolean')
    : typeof r.tool === 'string' && r.tool.length <= 100
    && Array.isArray(r.operations) && r.operations.length > 0 && r.operations.length <= 16
    && r.operations.every(s => typeof s === 'string' && s.length <= 150)
    && (r.lead === undefined || Array.isArray(r.lead) && r.lead.length > 0 && r.lead.every(s => r.operations.includes(s)))
    && (r.turn === undefined || /^[a-f0-9]{64}$/.test(r.turn)));
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
        // A turn a Stop hook sent back to work ends at its last Stop.
        if (call[r.kind]) { duplicates++; if (r.kind === 'turn-end' && finite(r.at) && !(r.at <= call[r.kind].at)) call[r.kind] = r; continue; }
        call[r.kind] = r;
      }
    } finally { lines.close(); stream.destroy(); }
  }
  const since = query.since ?? now - (query.days ?? 7) * DAY;
  const until = query.until ?? now;
  const retainedSince = Math.max(meta.startedAt, Math.floor(now / DAY) * DAY - (meta.retentionDays - 1) * DAY);
  const daily = new Map();
  const dayFormatter = query.history ? new Intl.DateTimeFormat('en-CA', { timeZone: query.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : null;
  const dayKey = time => {
    const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  // Calendar labels advance independently of offsets: DST days may be 23 or 25 hours.
  if (query.history && query.operation) {
    const first = Date.parse(dayKey(since)), last = Date.parse(dayKey(until));
    if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 91 * DAY) throw new Error('Daily history exceeds report capacity');
    const retainedDay = dayKey(retainedSince);
    const atBoundary = (time, end = false) => {
      const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
      return parts.hour === (end ? '23' : '00') && parts.minute === (end ? '59' : '00') && parts.second === (end ? '59' : '00') && ((time % 1000) + 1000) % 1000 === (end ? 999 : 0);
    };
    const firstDay = dayKey(since), lastDay = dayKey(until);
    const firstPartial = !atBoundary(since), lastPartial = !atBoundary(until, true), retainedPartial = !atBoundary(retainedSince);
    for (let date = first; date <= last; date += DAY) {
      const key = new Date(date).toISOString().slice(0, 10);
      daily.set(key, { date: key, calls: 0, measured: 0, shared: 0, providers: { claude: 0, codex: 0 }, durations: [],
        status: key < retainedDay ? 'outside-history' : 'no-calls', partial: key === retainedDay && retainedPartial || key === firstDay && firstPartial || key === lastDay && lastPartial });
    }
  }
  const groups = new Map(); let total = 0, measured = 0, failed = 0, pending = 0, orphaned = 0;
  const details = [];
  let totalMs = null, observedSince = null, observedUntil = null;
  const providers = { claude: { calls: 0, measured: 0, failed: 0 }, codex: { calls: 0, measured: 0, failed: 0 } };
  for (const [id, call] of calls) {
    const start = call.start, end = call.end;
    if (!start) { if (!call.skill && !call.turn && !call['turn-end']) orphaned++; continue; }
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
      if (operation === query.operation && daily.size) {
        const bucket = daily.get(dayKey(start.t));
        if (bucket) { bucket.calls++; bucket.providers[start.provider]++; if (shared) bucket.shared++; if (duration !== null) { bucket.measured++; bucket.durations.push(duration); } }
      }
      if (operation === query.operation) details.push({ id, operation, provider: start.provider, tool: start.tool,
        capturedAt: start.t, durationMs: duration, state: !end ? 'unmatched' : end.failed ? 'failed' : 'success', clock: start.clock, shared });
    }
  }
  // Where the turns' time went: Claude, this machine, or you. Wall-clock time, so the
  // calls that ran together, a subagent's among them, count once; a turn's time is cut
  // into the stretches between its calls' edges, and each stretch goes to one of three:
  // this machine while any call runs or hooks start one, you while one waits for your
  // approval or answer, and Claude while nothing does — the model, the network to it,
  // and Claude Code itself. An Agent call only holds its subagent's calls, which count.
  const holders = new Set(['Agent', 'Task']), questions = new Set(['AskUserQuestion', 'ExitPlanMode']);
  const middle = list => list.length ? list.length % 2 ? list[Math.floor(list.length / 2)] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2 : null;
  let split = null;
  if (query.provider !== 'codex') {
    const byTurn = new Map();
    for (const call of calls.values()) {
      const s = call.start, e = call.end;
      if (!s?.turn || !e || s.provider !== 'claude' || s.clock !== 'hook' || e.clock !== 'hook' || !finite(s.at) || !finite(e.at) || e.at < s.at || holders.has(s.tool)) continue;
      if (!byTurn.has(s.turn)) byTurn.set(s.turn, []);
      byTurn.get(s.turn).push(call);
    }
    const sum = { turns: 0, open: 0, totalMs: 0, claudeMs: 0, machineMs: 0, youMs: 0 }, machine = new Map(), you = new Map(), replies = [], stops = {};
    const add = (map, operation, ms) => map.set(operation, (map.get(operation) ?? 0) + ms);
    for (const [id, call] of calls) {
      const begin = call.turn, end = call['turn-end'];
      if (!begin || begin.t < since || begin.t > until) continue;
      if (!end || !finite(begin.at) || !finite(end.at) || end.at <= begin.at || end.at - begin.at > DAY) { sum.open++; continue; }
      const a = begin.at, b = end.at, spans = [];
      sum.turns++; sum.totalMs += b - a;
      if (end.stop !== 'done') stops[end.stop] = (stops[end.stop] ?? 0) + 1;
      for (const { start: s, end: e } of byTurn.get(id) ?? []) {
        // A command's time is its lead's: npm test's, not the tail reading its output.
        const own = s.lead ?? s.operations;
        if (questions.has(s.tool)) { spans.push([s.at, e.at, you, own]); continue; }
        // Claude Code's own time for the call ends where the call does; what comes
        // before it is the approval, when a prompt came up, or else the hooks.
        const run = finite(e.ms) ? Math.min(e.ms, e.at - s.at) : e.at - s.at, from = e.at - run;
        if (run > 0) spans.push([from, e.at, machine, own]);
        if (from > s.at) spans.push(e.asked ? [s.at, from, you, own] : [s.at, from, machine, ['(starting tools)']]);
      }
      const edges = [];
      for (const span of spans) { const x = Math.max(span[0], a), y = Math.min(span[1], b); if (y > x) edges.push([x, 1, span], [y, -1, span]); }
      edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const live = new Set(); let at = a, reply = 0, replyFrom = a;
      const spend = to => {
        const ms = to - at; if (ms <= 0) return;
        const running = [...live].filter(span => span[2] === machine), lane = running.length ? running : [...live];
        if (!lane.length) { if (!reply) replyFrom = at; reply += ms; sum.claudeMs += ms; at = to; return; }
        if (reply) { replies.push([replyFrom, reply]); reply = 0; }
        if (running.length) sum.machineMs += ms; else sum.youMs += ms;
        for (const span of lane) for (const operation of span[3]) add(span[2], operation, ms / lane.length / span[3].length);
        at = to;
      };
      for (const [t, step, span] of edges) { spend(t); if (step > 0) live.add(span); else live.delete(span); }
      spend(b);
      if (reply) replies.push([replyFrom, reply]);
    }
    // Claude's replies by the reader's calendar day, so a slow afternoon shows as one.
    const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: query.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    const days = new Map();
    for (let t = since; t <= until; t += DAY / 2) days.set(dayOf.format(new Date(t)), []);
    days.set(dayOf.format(new Date(until)), days.get(dayOf.format(new Date(until))) ?? []);
    for (const [t, ms] of replies) days.get(dayOf.format(new Date(t)))?.push(ms);
    const lengths = replies.map(r => r[1]).sort((x, y) => x - y);
    const top = (map, n) => [...map].map(([operation, ms]) => ({ operation, ms: Math.round(ms) })).sort((p, q) => q.ms - p.ms || p.operation.localeCompare(q.operation)).slice(0, n);
    split = { ...sum, machine: top(machine, 40), you: top(you, 20), stops,
      replies: { count: lengths.length, medianMs: middle(lengths), p90Ms: lengths.length >= 10 ? percentile(lengths, .9) : null, maxMs: lengths.at(-1) ?? null,
        days: [...days].map(([date, list]) => { list.sort((x, y) => x - y); return { date, count: list.length, medianMs: middle(list) }; }) } };
  }
  const rows = [...groups.values()].map(g => {
    const durations = g.durations.sort((a, b) => a - b);
    const n = durations.length;
    return { operation: g.operation, calls: g.calls, completed: g.completed, failed: g.failed,
      errorRate: g.completed ? g.failed / g.completed : null, measured: n, missingTiming: g.missingTiming,
      unmatched: g.pending, shared: g.shared, providers: g.providers, tools: [...g.tools],
      totalMs: n ? durations.reduce((a, b) => a + b, 0) : null,
      averageMs: n ? durations.reduce((a, b) => a + b, 0) / n : null,
      medianMs: n ? n % 2 ? durations[Math.floor(n / 2)] : (durations[n / 2 - 1] + durations[n / 2]) / 2 : null,
      p95Ms: n >= 20 ? percentile(durations, .95) : null, maxMs: n ? durations.at(-1) : null };
  }).sort((a, b) => b.calls - a.calls || a.operation.localeCompare(b.operation));
  return { ok: true, capturedAt: now, since, until, provider: query.provider, total, measured, failed, unmatched: pending,
    corrupt, duplicates, orphaned, rows, totalMs, completed: total - pending, providers, observedSince, observedUntil,
    retainedSince, split,
    details: query.operation ? { operation: query.operation, total: details.length,
      ...(query.history ? { capturedAt: now, measurements: rows.find(row => row.operation === query.operation) ?? null, history: { timeZone: query.timeZone ?? 'UTC', days: [...daily.values()].map(bucket => {
        const sorted = bucket.durations.sort((a, b) => a - b), n = sorted.length;
        return { date: bucket.date, calls: bucket.calls, measured: n, shared: bucket.shared, providers: bucket.providers, partial: bucket.partial,
          status: n ? 'measured' : bucket.calls ? 'missing-timing' : bucket.status,
          averageMs: n ? sorted.reduce((sum, duration) => sum + duration, 0) / n : null,
          medianMs: n ? n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null,
          maxMs: n ? sorted.at(-1) : null, p95Ms: n >= 20 ? percentile(sorted, .95) : null };
      }) } } : {}),
      slowest: details.filter(d => d.durationMs !== null).sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
      recent: details.sort((a, b) => b.capturedAt - a.capturedAt).slice(0, 30) } : null };
}
