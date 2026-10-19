// Skill activity (#2181). Runs in a worker like the tool report, over the same
// journal, so everything it uses lives inside the function.
export async function buildSkillReport({ files, query, now, meta }, { createReadStream, createInterface }) {
const DAY = 86400000;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const text = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
const base = r => /^[a-f0-9]{64}$/.test(r?.id ?? '') && ['claude', 'codex'].includes(r.provider) && finite(r.t)
  && (r.at === null || finite(r.at)) && ['hook', 'rollout'].includes(r.clock);
// The fields a skill row carries beside a call: a Skill tool call's start, or a typed or detected use.
const named = r => text(r.skill, 150) && ['typed', 'agent', 'detected'].includes(r.origin) && text(r.session, 256)
  && (r.project === null || text(r.project, 150)) && typeof r.subagent === 'boolean';
  const uses = new Map(); let corrupt = 0, duplicates = 0;
  for (const file of files) {
    if (file.size > 64 * 1024 * 1024) throw new Error('Daily tool history exceeds report capacity');
    if (!file.size) continue;
    const stream = createReadStream(file.path, { start: 0, end: file.size - 1, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { corrupt++; continue; }
        if (!base(r)) { corrupt++; continue; }
        // A call ends after it starts, and the journal is read in the order it was written.
        if (r.kind === 'end') { const use = uses.get(r.id); if (use && use.state === 'pending' && typeof r.failed === 'boolean') use.state = r.failed ? 'failed' : 'done'; continue; }
        if (r.kind !== 'skill' && !(r.kind === 'start' && r.skill !== undefined)) continue;
        if (!named(r) || r.kind === 'skill' && typeof r.repeat !== 'boolean') { corrupt++; continue; }
        if (uses.has(r.id)) { duplicates++; continue; }
        if (uses.size >= 500000) throw new Error('Tool history exceeds report capacity; choose shorter retention in Settings');
        // When it happened, never later than when the deck heard of it: a rollout's clock may run ahead.
        uses.set(r.id, { id: r.id, name: r.skill, provider: r.provider, at: Math.min(r.at ?? r.t, r.t), origin: r.origin, session: r.session, project: r.project,
          subagent: r.subagent, repeat: r.kind === 'skill' && r.repeat, state: r.kind === 'start' ? 'pending' : 'done' });
      }
    } finally { lines.close(); stream.destroy(); }
  }
  const since = query.since ?? now - (query.days ?? 7) * DAY;
  const until = query.until ?? now;
  const retainedSince = Math.max(meta.startedAt, Math.floor(now / DAY) * DAY - (meta.retentionDays - 1) * DAY);
  const countedSince = Math.max(retainedSince, finite(meta.skillsSince) ? meta.skillsSince : meta.startedAt);
  const groups = new Map(), picked = [];
  let total = 0, repeats = 0, failed = 0;
  const providers = { claude: 0, codex: 0 };
  for (const use of uses.values()) {
    if (use.at < since || use.at > until || query.provider !== 'all' && use.provider !== query.provider) continue;
    let group = groups.get(use.name);
    if (!group) { group = { name: use.name, uses: 0, repeats: 0, failed: 0, typed: 0, agent: 0, detected: 0, subagent: 0, providers: { claude: 0, codex: 0 }, firstAt: use.at, lastAt: use.at, sessions: new Set(), projects: new Set() }; groups.set(use.name, group); }
    group.firstAt = Math.min(group.firstAt, use.at); group.lastAt = Math.max(group.lastAt, use.at);
    if (use.name === query.skill) picked.push(use);
    // A repeat is the same command run again with the same arguments, such as a scheduled /loop tick.
    if (use.repeat) { group.repeats++; repeats++; continue; }
    group.uses++; group[use.origin]++; group.providers[use.provider]++; total++; providers[use.provider]++;
    if (use.subagent) group.subagent++;
    if (use.state === 'failed') { group.failed++; failed++; }
    group.sessions.add(use.session); if (use.project) group.projects.add(use.project);
  }
  const rows = [...groups.values()].map(({ sessions, projects, ...group }) => ({ ...group, sessions: sessions.size, projects: projects.size }))
    .sort((a, b) => b.uses - a.uses || b.lastAt - a.lastAt || a.name.localeCompare(b.name));
  let details = null;
  if (query.skill) {
    const counted = picked.filter(use => !use.repeat).sort((a, b) => b.at - a.at);
    const projects = new Map();
    for (const use of counted) if (use.project) projects.set(use.project, (projects.get(use.project) ?? 0) + 1);
    details = { name: query.skill, row: rows.find(row => row.name === query.skill) ?? null, total: counted.length,
      projects: [...projects].map(([name, uses]) => ({ name, uses })).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, 5),
      recent: counted.slice(0, 50).map(({ id, provider, at, origin, session, project, subagent, state }) => ({ id, provider, at, origin, session, project, subagent, state })) };
    if (query.history) {
      const format = new Intl.DateTimeFormat('en-CA', { timeZone: query.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
      const dayKey = time => { const p = Object.fromEntries(format.formatToParts(new Date(time)).map(part => [part.type, part.value])); return `${p.year}-${p.month}-${p.day}`; };
      const first = Date.parse(dayKey(since)), last = Date.parse(dayKey(until)), countedDay = dayKey(countedSince);
      if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 91 * DAY) throw new Error('Daily history exceeds report capacity');
      const days = new Map();
      // Calendar labels advance independently of offsets: DST days may be 23 or 25 hours.
      for (let date = first; date <= last; date += DAY) {
        const key = new Date(date).toISOString().slice(0, 10);
        days.set(key, { date: key, uses: 0, providers: { claude: 0, codex: 0 }, status: key < countedDay ? 'outside-history' : 'no-uses' });
      }
      for (const use of counted) { const day = days.get(dayKey(use.at)); if (day) { day.uses++; day.providers[use.provider]++; day.status = 'used'; } }
      details.history = { timeZone: query.timeZone ?? 'UTC', days: [...days.values()] };
    }
  }
  return { ok: true, view: 'skills', capturedAt: now, since, until, provider: query.provider, total, repeats, failed, providers,
    corrupt, duplicates, retainedSince, countedSince, rows, details };
}
