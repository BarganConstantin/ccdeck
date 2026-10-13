// ccusage's two session formats, reduced to the figures the inspector needs.
// No prompts, tool arguments or transcript text cross this boundary.
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const counters = value => ({
  inputTokens: number(value?.inputTokens), outputTokens: number(value?.outputTokens),
  cacheReadTokens: number(value?.cacheReadTokens), cacheCreationTokens: number(value?.cacheCreationTokens),
  reasoningOutputTokens: number(value?.reasoningOutputTokens),
});
const tokenTotal = row => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

// Both ccusage providers normalize inputTokens to NON-cached input. Codex's
// raw input_tokens (which includes cache) must never be fed to this formula.
// ccusage/ccusage rust/adapters/codex/src/report.rs: non_cached_input_tokens.
export function sessionCacheReuse(rows, agent) {
  let input = 0, cached = 0, measured = 0;
  for (const row of rows) {
    const values = [row?.inputTokens, row?.cacheReadTokens, row?.cacheCreationTokens];
    if (!values.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) continue;
    input += values[0] + values[1] + values[2];
    cached += values[1];
    measured++;
  }
  return { pct: input > 0 ? cached / input * 100 : null, inputTokens: input, cachedTokens: cached,
    measured, total: rows.length, unit: agent === "codex" ? "model groups" : "usage records" };
}

export function validSessionLookup(agent, id, speed = "auto") {
  if (agent !== "claude" && agent !== "codex") return false;
  if (!["auto", "standard", "fast", "flex"].includes(speed) || (agent !== "codex" && speed !== "auto")) return false;
  if (typeof id !== "string" || id.includes("..")) return false;
  return agent === "codex"
    ? /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)
    : /^[a-z\d][a-z\d._:-]{0,255}$/i.test(id);
}

export function sessionDetail(raw, agent, sessionId, speed = "auto") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.sessionId !== "string" || !Number.isFinite(raw.totalTokens)
      || !Number.isFinite(raw.totalCost) || raw.totalTokens < 0 || raw.totalCost < 0) return null;
  // Codex answers with its rollout ID (path + UUID); Claude answers with the
  // requested filename. Never display another session as the one requested.
  const uuid = raw.sessionId.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(?:\.jsonl(?:\.zst)?)?$/i)?.[0]
    .replace(/\.jsonl(?:\.zst)?$/i, "");
  if (agent === "codex" ? uuid?.toLowerCase() !== sessionId.toLowerCase() : raw.sessionId !== sessionId) return null;
  const models = new Map();
  let usage = counters(raw), firstActivity = date(raw.firstActivity), lastActivity = date(raw.lastActivity);
  let entries = null;
  if (agent === "claude" && Array.isArray(raw.entries)) {
    usage = counters({});
    entries = raw.entries.length;
    for (const entry of raw.entries) {
      const row = counters(entry);
      for (const key of Object.keys(usage)) usage[key] += row[key];
      const model = typeof entry?.model === "string" ? entry.model : "unknown";
      const bucket = models.get(model) ?? { model, ...counters({}), missingPricing: false };
      for (const key of Object.keys(usage)) bucket[key] += row[key];
      models.set(model, bucket);
      const at = date(entry?.timestamp);
      if (at && (!firstActivity || Date.parse(at) < Date.parse(firstActivity))) firstActivity = at;
      if (at && (!lastActivity || Date.parse(at) > Date.parse(lastActivity))) lastActivity = at;
    }
  } else if (agent === "codex" && raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)) {
    for (const [model, value] of Object.entries(raw.models)) {
      models.set(model, { model, ...counters(value), missingPricing: value?.missingPricing === true });
    }
  } else return null;
  // Per-model dollars are absent in Codex's JSON and Claude's entry costUSD
  // may omit calculated costs. Keep the reported total; don't invent a split.
  return {
    sessionId, agent, speed, totalCost: raw.totalCost, totalTokens: raw.totalTokens,
    ...usage, firstActivity, lastActivity, entries,
    cacheReuse: sessionCacheReuse(agent === "claude" ? raw.entries : Object.values(raw.models), agent),
    models: [...models.values()].map(row => ({ ...row, totalTokens: tokenTotal(row) }))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
  };
}
