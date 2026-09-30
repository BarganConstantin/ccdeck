// Live Anthropic API pricing → dollar cost per agent.
//
// The rates themselves, and where and when each was read, are in
// rate-table.ts. This file is the arithmetic over them.
//
// Anthropic bills a cache write by the TTL it was written at: 1.25× base
// input for a 5-minute entry, 2× for a 1-hour one. CC writes 1-hour caches
// for the bulk of its prefix, so charging the whole of
// `cache_creation_input_tokens` at the 5-minute rate — which this file used
// to do — under-reported every Claude session by 5-10% and disagreed with
// the ccusage number the deck prints in its own usage-history modal. The
// transcript carries the split; costForUsage documents what happens to
// tokens that reach us without one.

import { bareModelId } from "./model-id";
import type { TokenUsage } from "./types";
import { FAST_RATES, RATES } from "./rate-table";

export interface ModelRates {
  input: number;       // $/Mtok
  output: number;      // $/Mtok
  cacheRead: number;   // $/Mtok — hits & refreshes
  cacheWrite: number;  // $/Mtok — 5-minute writes (1.25× input)
  /** $/Mtok for a 1-hour cache write (2× input). Anthropic is the only
   *  family here that publishes a second cache-write price — OpenAI has one
   *  cache tier and its usage never carries a TTL split — so the Codex rows
   *  leave this unset and costForUsage falls back to `cacheWrite`. */
  cacheWrite1h?: number;
}

/** Recognise Codex / OpenAI model ids — gpt-*, codex-*, o-series.
 *
 *  Not exported (#383). The doc here used to say this was "so the UI can tag the
 *  model display", and that has not been true for some time: the display name is
 *  `shortModel` in model-label.ts, which reads the id's own shape and never asks
 *  this question. The one thing this decides is which arithmetic
 *  `billedInputTokens` does below — Codex bills cache reads and writes on their
 *  own lines, Claude folds them into input — so it is a detail of the pricing
 *  model and is exercised through `billedInputTokens` on both providers.
 *
 *  Deliberately NOT given the `bareModelId` strip the two tables got in #475.
 *  The prefix it would remove is `anthropic.`, and the only ids carrying one
 *  are Claude ids — Bedrock, Vertex and Mantle serve no OpenAI model, so no
 *  `gpt-*` id ever arrives wearing it. Stripping first would change no answer
 *  here, and leaving the question anchored at the raw id keeps this a test of
 *  "did an OpenAI id arrive" rather than one more thing to keep in step. */
function isCodexModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return /^(?:gpt[-_]|codex[-_]|o\d)/i.test(modelId);
}

/** `now` is injectable so a dated rate can be exercised on both sides of its
 *  cutover; callers in the app leave it alone and get the wall clock.
 *
 *  The id is stripped of its provider namespace first (#475). Every row in
 *  rate-table.ts is `^`-anchored, and a Bedrock id arrives as
 *  `us.anthropic.claude-opus-4-1-20250805-v1:0`, so `^claude` reached none of
 *  them and every Claude model on Bedrock or Mantle priced out at `null` —
 *  which is not a wrong number but no number at all, on every cost surface, for
 *  the whole session. See model-id.ts for why this is a strip rather than
 *  thirty looser patterns. A first-party or Vertex id is unchanged by it.
 *
 *  `speed` is the usage object's `speed`, and it picks the table: the standard
 *  one unless a request ran fast (#754). A Map rather than an object literal,
 *  because the value is read out of a transcript and `"constructor"` is a key
 *  every object literal already has. */
export function ratesForModel(
  modelId: string | undefined,
  now: number = Date.now(),
  speed: string = STANDARD_SPEED,
): ModelRates | null {
  if (!modelId) return null;
  const table = RATES_BY_SPEED.get(speed);
  if (!table) return null;
  const bare = bareModelId(modelId);
  for (const r of table) {
    if (r.match.test(bare)) return typeof r.rates === "function" ? r.rates(now) : r.rates;
  }
  return null;
}

/** The speed a request is billed at when its usage names no other: every
 *  Codex request, every Claude request Claude Code wrote before it recorded
 *  `usage.speed`, and every one that says `"standard"`. */
export const STANDARD_SPEED = "standard";

/** Which table prices each speed a usage object can name (#754). A speed with
 *  no entry here is one this build has never read a price for, and
 *  `ratesForModel` answers it with null rather than the standard rate: a
 *  premium tier priced at the standard rate is a confident figure that is
 *  wrong by the premium. */
const RATES_BY_SPEED: ReadonlyMap<string, typeof RATES> = new Map([
  [STANDARD_SPEED, RATES],
  ["fast", FAST_RATES],
]);

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// No long-context surcharge here, deliberately. OpenAI's >272K tier re-prices
// a single request at 2x input / 1.5x output once THAT REQUEST's input passes
// the line, but the only usage we ever hold for a Codex agent is the session
// running total (`info.total_token_usage` from the rollout's token_count
// events, which the reducer overwrites onto the session root). Cumulative
// input crosses 272K on almost any multi-turn session while each individual
// request stays far below it, so testing the total against a per-request
// threshold surcharged nearly every Codex session by roughly 2x. The Codex
// CLI also clamps its window to 258,400 (272,000 x 95%) precisely so no single
// request crosses the boundary — see CODEX_CONTEXT_DEFAULTS in
// context-window.ts — which makes the tier effectively unreachable. Restoring
// it would need per-request input (the rollout's `last_token_usage`)
// accumulated request by request.

/** Dollars for `tokens` at a rate quoted per million tokens, which is how
 *  every rate in ModelRates is written. */
function usdAt(tokens: number, perMtok: number): number {
  return tokens * perMtok / 1_000_000;
}

/** Cache-creation tokens grouped by the TTL they were billed at, with the
 *  dollars each bucket contributes. Exported so the cost tooltip can print
 *  the same multiplication the total is built from rather than re-deriving
 *  it and drifting. */
export interface CacheWriteBreakdown {
  tokens5m: number;
  tokens1h: number;
  usd5m: number;
  usd1h: number;
}

/** Claude reports `cache_creation_input_tokens` alongside a per-TTL split
 *  (`ephemeral_5m_input_tokens` + `ephemeral_1h_input_tokens`) that sums back
 *  to it exactly. Whatever the split does not account for — a transcript
 *  written before CC emitted one, a hook payload carrying only the flat
 *  field, any Codex agent — is billed at the 5-minute rate, which is what
 *  every token got before the split was plumbed through. So a session with
 *  no split reads exactly as it did, and no token is ever charged twice. */
export function cacheWriteBreakdown(usage: TokenUsage, rates: ModelRates): CacheWriteBreakdown {
  const tokens1h = Math.max(0, usage.cacheCreate1hTokens ?? 0);
  const split5m = Math.max(0, usage.cacheCreate5mTokens ?? 0);
  const unsplit = Math.max(0, usage.cacheCreateTokens - tokens1h - split5m);
  const tokens5m = split5m + unsplit;
  const rate1h = rates.cacheWrite1h ?? rates.cacheWrite;
  return {
    tokens5m,
    tokens1h,
    usd5m: usdAt(tokens5m, rates.cacheWrite),
    usd1h: usdAt(tokens1h, rate1h),
  };
}

/** The token count the input rate is actually applied to.
 *
 *  OpenAI/Codex: `input_tokens` INCLUDES the cached prefix, so only the
 *  non-cached remainder is billed at the full input rate — the cached part is
 *  charged again, cheaper, on the cache-read line. Claude reports the two
 *  disjoint, so its count stands as-is.
 *
 *  Cache WRITES are subtracted on the same argument, and only for the families
 *  that price them. Codex's `total_token_usage` carries two headline counts and
 *  a set of qualifier fields that are subsets of them: measured over the 171
 *  usage objects in this machine's rollouts, `total_tokens` equals
 *  `input_tokens + output_tokens` in every single one, while
 *  `cached_input_tokens` and `reasoning_output_tokens` are each ≤ their
 *  headline. `cache_write_input_tokens` is the same shape and the same naming
 *  convention, so it too is part of `input_tokens` — which means billing it at
 *  the cache-write rate WITHOUT taking it off the input line would charge those
 *  tokens twice, at input + cache-write together. Subtracting it only when a
 *  non-zero cache-write rate exists is what keeps every token billed exactly
 *  once in both directions: gpt-5.6 charges its written tokens at $5/Mtok
 *  instead of $4, and every other Codex family — where a zero rate means
 *  "writes cost nothing extra", not "writes are free of the input charge" —
 *  leaves them on the input line where they were always billed correctly.
 *
 *  Exported so the cost tooltip prints THIS number beside the input dollars.
 *  It used to print `usage.inputTokens`, which on a cache-heavy Codex session
 *  is close to an order of magnitude larger — the one place a user goes to
 *  check the pricing showed a multiplication that missed its own printed
 *  result, reading exactly like the deck overcharging by 10x. */
export function billedInputTokens(
  usage: TokenUsage,
  modelId: string | undefined,
  now: number = Date.now(),
): number {
  if (!isCodexModel(modelId)) return usage.inputTokens;
  const rates = ratesForModel(modelId, now);
  const written = (rates?.cacheWrite ?? 0) > 0 ? Math.max(0, usage.cacheCreateTokens) : 0;
  return Math.max(0, usage.inputTokens - usage.cacheReadTokens - written);
}

/** A model with no row comes back as a breakdown of zeros, and those zeros are
 *  not a price: they are "this build cannot say". A caller that SUMS the result
 *  must ask ratesForModel as well and carry the unpriced tokens beside its
 *  total, or the total reads as complete when it is a floor. agentUnpricedTokens
 *  does this for the board and the reconciliation does it for the Projects
 *  report, which is where it was missing (#1330).
 *
 *  Each speed share of `usage` is priced at its own speed's rates (#754), and a
 *  share whose speed has no rate for this model is the same kind of zero: the
 *  standard share of a session can be priced while its fast share is not, and
 *  agentUnpricedTokens counts that share with the rest. */
export function costForUsage(
  usage: TokenUsage,
  modelId: string | undefined,
  now: number = Date.now(),
): CostBreakdown {
  const out: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const share of speedShares(usage)) {
    const c = costAtSpeed(share.usage, modelId, share.speed, now);
    out.input += c.input;
    out.output += c.output;
    out.cacheRead += c.cacheRead;
    out.cacheWrite += c.cacheWrite;
    out.total += c.total;
  }
  return out;
}

/** `usage` priced at one speed's rate card, `usage.bySpeed` ignored. The
 *  tooltip prints one of these per share, so its rows add up to the total
 *  costForUsage builds from the same shares. */
export function costAtSpeed(
  usage: TokenUsage,
  modelId: string | undefined,
  speed: string,
  now: number = Date.now(),
): CostBreakdown {
  const rates = ratesForModel(modelId, now, speed);
  if (!rates) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  const input      = usdAt(billedInputTokens(usage, modelId, now), rates.input);
  const output     = usdAt(usage.outputTokens, rates.output);
  const cacheRead  = usdAt(usage.cacheReadTokens, rates.cacheRead);
  const cw = cacheWriteBreakdown(usage, rates);
  const cacheWrite = cw.usd5m + cw.usd1h;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** One speed's share of a usage object. */
export interface SpeedShare {
  speed: string;
  usage: TokenUsage;
}

/** `usage` split by the speed each token was billed at: the standard share
 *  first, then every share `usage.bySpeed` names, in its own order.
 *
 *  The named shares are a SUBSET of the counts they sit on, the way the TTL
 *  split is a subset of `cacheCreateTokens`, so the standard share is what they
 *  leave, clamped at zero per field. A usage with no `bySpeed` is one share, the
 *  object itself, so everything that has never run fast prices exactly as it
 *  always did. */
export function speedShares(usage: TokenUsage): SpeedShare[] {
  const named = usage.bySpeed ? Object.entries(usage.bySpeed) : [];
  if (named.length === 0) return [{ speed: STANDARD_SPEED, usage }];
  return [
    { speed: STANDARD_SPEED, usage: withoutShares(usage, named.map(([, u]) => u)) },
    ...named.map(([speed, u]) => ({ speed, usage: u })),
  ];
}

/** `usage` less every share in `shares`, per field and never below zero. */
function withoutShares(usage: TokenUsage, shares: readonly TokenUsage[]): TokenUsage {
  const sum = (pick: (u: TokenUsage) => number | undefined) =>
    shares.reduce((n, u) => n + (pick(u) ?? 0), 0);
  const less = (pick: (u: TokenUsage) => number | undefined) =>
    Math.max(0, (pick(usage) ?? 0) - sum(pick));
  const out: TokenUsage = {
    inputTokens: less(u => u.inputTokens),
    outputTokens: less(u => u.outputTokens),
    cacheReadTokens: less(u => u.cacheReadTokens),
    cacheCreateTokens: less(u => u.cacheCreateTokens),
  };
  if (usage.cacheCreate1hTokens !== undefined || usage.cacheCreate5mTokens !== undefined) {
    out.cacheCreate1hTokens = less(u => u.cacheCreate1hTokens);
    out.cacheCreate5mTokens = less(u => u.cacheCreate5mTokens);
  }
  if (usage.reasoningOutputTokens !== undefined) out.reasoningOutputTokens = usage.reasoningOutputTokens;
  return out;
}

/** What a surface prints in the slot a dollar figure would occupy when the deck
 *  holds no rate for the model.
 *
 *  It is not `fmtCost(0)`. That returns "—", which is this file's word for a
 *  number it knows to be zero, and the two facts are worth different things to
 *  a reader: "this session cost nothing" is an answer, and "we cannot price
 *  this model" is an admission. Printing "$0.00" for real spend would be worse
 *  than either — a figure that is wrong rather than absent — and printing
 *  nothing at all is what shipped before #400: the element carrying the cost
 *  was gated on the rates lookup that had just failed, so a session on an
 *  unpriced model showed its tokens with a hole where the money goes.
 *
 *  One constant rather than three string literals, for the reason stateLabel
 *  in agent-copy.ts is one function: the node chip, the by-model table and the
 *  by-session list are three views of the same fact, and a reader who sees two
 *  of them has to be able to tell that they say the same thing. */
export const UNPRICED_LABEL = "not priced";

/** `value` rounded to `digits` places, as fmtCost prints it — or null when the
 *  rounding carries it up to `limit`, where the next tier starts. Judged on the
 *  rounded string rather than the raw value, because the string is what is
 *  printed. fmtTokens hands its tiers over with the same rule (#1807). */
export function roundedUnder(value: number, digits: number, limit: number): string | null {
  const text = value.toFixed(digits);
  return Number(text) < limit ? text : null;
}

export function fmtCost(usd: number): string {
  if (usd <= 0) return "—";
  if (usd < 0.005) return "<1¢";
  if (usd < 1) {
    // Rounding can carry the cents past a full dollar ($0.996 → "100¢"), so
    // check the rounded string rather than the raw value and fall through to
    // the dollar branch when it does.
    const cents = roundedUnder(usd * 100, usd < 0.1 ? 1 : 0, 100);
    if (cents !== null) return `${cents}¢`;
  }
  // The same carry at the next two boundaries (#1173): $99.995 rounds to
  // "100.00" where the next tier prints "$100", and $9,999.50 to "10000" where
  // it prints "$10.0k". Same fix as the cents: judge the rounded string.
  if (usd < 100) {
    const dollars = roundedUnder(usd, 2, 100);
    if (dollars !== null) return `$${dollars}`;
  }
  if (usd < 10_000) {
    const whole = roundedUnder(usd, 0, 10_000);
    if (whole !== null) return `$${whole}`;
  }
  return `$${(usd / 1000).toFixed(1)}k`;
}

/** Burn rate — total cost over elapsed seconds. Auto-picks /min vs /hr
 *  scale so the number reads naturally (always 0.01 - 99 in chosen unit).
 *  Returns null when there's no meaningful rate yet (<10s of activity
 *  or zero cost) so callers can hide the chip. */
export function fmtCostRate(totalUsd: number, elapsedSec: number): string | null {
  if (totalUsd <= 0 || elapsedSec < 10) return null;
  const perSec = totalUsd / elapsedSec;
  const perMin = perSec * 60;
  // Prefer /min when it reads ≥ 1¢; otherwise switch to /hr.
  if (perMin >= 0.01) return `${fmtCost(perMin)}/min`;
  return `${fmtCost(perSec * 3600)}/hr`;
}
