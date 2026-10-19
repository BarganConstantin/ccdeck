import { FREE_AUTO_REVIEW_TIER, isFreeAutoReview } from "./codex-review-policy.mjs";
// Price only observed increases under recorded settings, never a whole session
// at its latest tier. These are API-equivalent estimates, not billing evidence.
const FIELDS = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens"];
const TIERS = new Map([["default", "standard"], ["standard", "standard"], ["priority", "fast"], ["fast", "fast"], ["flex", "flex"]]);
const count = n => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
const empty = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
export function codexCostState() {
  return { model: null, tier: null, previous: null, models: new Map() };
}
export function codexCostGap(state) {
  state.gapPrevious = state.previous;
  state.previous = null;
  state.tier = null;
  state.model = null;
  state.lastUsageAt = undefined;
}
export function foldCodexCost(state, obj) {
  const pl = obj?.payload;
  if (obj?.type === "session_meta") {
    state.creator = pl?.creator_account_id;
    state.startedAt = obj.timestamp;
    if (state.previous === null) state.previous = empty();
  }
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
  const priorUsageAt = state.lastUsageAt;
  state.lastUsageAt = obj.timestamp;
  const prior = state.previous;
  const baseline = prior ?? state.gapPrevious;
  state.gapPrevious = null;
  state.previous = next;
  // The first total could precede the tier setting; the first read after a gap
  // certainly does. Leave that part at base rates instead of guessing its tier.
  if (baseline && FIELDS.some(k => next[k] < baseline[k])) {
    state.models.clear();
    return;
  }
  if (!prior || !state.model) return;
  const delta = Object.fromEntries(FIELDS.map(k => [k, next[k] - prior[k]]));
  const bucket = state.models.get(state.model) ?? { ...empty(), speeds: new Map() };
  for (const k of FIELDS) bucket[k] += delta[k];
  const free = isFreeAutoReview(state.model, state.creator, obj.timestamp)
    && (isFreeAutoReview(state.model, state.creator, priorUsageAt)
      || isFreeAutoReview(state.model, state.creator, state.startedAt));
  const billedTier = free ? FREE_AUTO_REVIEW_TIER : state.tier;
  if (billedTier && billedTier !== "standard") {
    const share = bucket.speeds.get(billedTier) ?? empty();
    for (const k of FIELDS) share[k] += delta[k];
    bucket.speeds.set(billedTier, share);
  }
  state.models.set(state.model, bucket);
}
export function codexCostBuckets(state) {
  if (state.models.size === 0) return undefined;
  return Object.fromEntries([...state.models].map(([model, { speeds, ...usage }]) => [model, {
    ...usage, ...(speeds.size ? { speeds: Object.fromEntries(speeds) } : {}),
  }]));
}
