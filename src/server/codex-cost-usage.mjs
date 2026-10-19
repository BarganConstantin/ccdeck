// Price only observed increases under recorded settings, never a whole session
// at its latest tier. These are API-equivalent estimates, not billing evidence.
const FIELDS = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens"];
const TIERS = new Map([["default", "standard"], ["standard", "standard"], ["priority", "fast"], ["fast", "fast"], ["flex", "flex"]]);
const count = n => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
const empty = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
export function codexCostState() {
  return { model: null, tier: null, previous: null, models: new Map(), hasTier: false };
}
export function codexCostGap(state) {
  state.previous = null;
  state.tier = null;
  state.model = null;
}
export function foldCodexCost(state, obj) {
  const pl = obj?.payload;
  if (obj?.type === "session_meta" && state.previous === null) state.previous = empty();
  if (obj?.type === "session_meta" && typeof pl?.model === "string") state.model = pl.model;
  if ((obj?.type === "turn_context" || obj?.type === "response_item") && typeof pl?.model === "string") state.model = pl.model;
  if (obj?.type !== "event_msg") return;
  if (pl?.type === "thread_settings_applied" && Object.hasOwn(pl.thread_settings ?? {}, "service_tier")) {
    const tier = pl.thread_settings.service_tier;
    state.tier = TIERS.get(tier) ?? "unknown";
  }
  const raw = pl?.type === "token_count" ? pl.info?.total_token_usage : null;
  if (!raw || typeof raw !== "object") return;
  const next = Object.fromEntries(FIELDS.map(k => [k, count(raw[k])]));
  const prior = state.previous;
  state.previous = next;
  // The first total could precede the tier setting; the first read after a gap
  // certainly does. Leave that part at base rates instead of guessing its tier.
  if (prior && FIELDS.some(k => next[k] < prior[k])) {
    state.models.clear();
    state.hasTier = false;
    return;
  }
  if (!prior || !state.model) return;
  const delta = Object.fromEntries(FIELDS.map(k => [k, next[k] - prior[k]]));
  const bucket = state.models.get(state.model) ?? { ...empty(), speeds: new Map() };
  for (const k of FIELDS) bucket[k] += delta[k];
  if (state.tier && state.tier !== "standard") {
    const share = bucket.speeds.get(state.tier) ?? empty();
    for (const k of FIELDS) share[k] += delta[k];
    bucket.speeds.set(state.tier, share);
    state.hasTier = true;
  }
  state.models.set(state.model, bucket);
}
export function codexCostBuckets(state) {
  if (!state.hasTier) return undefined;
  return Object.fromEntries([...state.models].map(([model, { speeds, ...usage }]) => [model, {
    ...usage, ...(speeds.size ? { speeds: Object.fromEntries(speeds) } : {}),
  }]));
}
