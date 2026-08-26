// Which model's rate card each of an agent's tokens is billed against.
//
// WHY THIS IS ITS OWN MODULE. Before #686 every cost surface in the deck wrote
// the same expression — `costForUsage(a.usage, a.model)` — and every one of them
// was wrong in the same way, because the two halves of that multiplication
// answer different questions. `a.usage` is a CUMULATIVE total for the whole
// transcript; `a.model` is the model observed MOST RECENTLY. A session that
// typed `/model`, or that Claude Code dropped from Opus to Sonnet when the
// weekly allowance ran low, has tokens from two rate cards in one bucket, and
// the last line of the file decided which card the lot was billed at.
//
// Measured on a constructed transcript of twenty Opus turns (50,000 in /
// 5,000 out each) followed by one Sonnet turn (1,000 / 100), read back through
// the deck's own scanner at Sonnet 5's introductory pricing: the truth is
// $7.503 and the deck printed $3.003, 60% under. Reverse the ordering — twenty
// Sonnet turns then one Opus turn — and the truth is $3.0075 against the deck's
// $7.5075, 150% over. Same 1.1M tokens both times. The SIGN of the error is
// whichever model happened to write the final line, which is not a property a
// bill has.
//
// So the rule this module exists to hold is one sentence: tokens are priced at
// the model that produced them. Everything else here is what that costs.
//
// It is a module and not six copies of a fold for the reason model-label.ts and
// token-format.ts are modules: nine call sites across six files multiply usage
// by a price, the branches that matter are the ones nobody exercises by hand (a
// session on one model, a session on three, a Codex session that reports no
// split at all, a server too old to send one), and a rule that lives inside a
// .tsx is a rule the suite cannot reach — the test environment is plain Node.
import { costForUsage, ratesForModel, type CostBreakdown } from "./pricing";
import type { TokenUsage } from "./types";

/** The shape every cost surface needs off an agent, and no more of one than
 *  that. Structural rather than `AgentNodeData` so a test — and the usage
 *  panel's own row builders — can pass a literal without inventing prompts, a
 *  tool list and a start time to satisfy a type. */
export interface UsageBearing {
  usage: TokenUsage;
  usageByModel?: Record<string, TokenUsage>;
  model?: string;
}

/** One model's share of an agent's tokens. `model` is undefined only for an
 *  agent that has reported no model at all — the same "unknown" the by-model
 *  table has always had a row for. */
export interface ModelUsage {
  model?: string;
  usage: TokenUsage;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreateTokens: a.cacheCreateTokens + b.cacheCreateTokens,
  };
  // Absent is not zero: pricing.ts bills whatever the TTL split does not cover
  // at the 5-minute rate, so writing a 0/0 split onto a sum of two split-less
  // usages would move nothing — but writing one onto a sum where only ONE side
  // carried a split would silently reclassify the other side's cache writes.
  // Carry a split only when at least one side has one, and let the shortfall
  // fall through to the 5-minute rate exactly as it does everywhere else.
  if (a.cacheCreate1hTokens !== undefined || a.cacheCreate5mTokens !== undefined
      || b.cacheCreate1hTokens !== undefined || b.cacheCreate5mTokens !== undefined) {
    out.cacheCreate1hTokens = (a.cacheCreate1hTokens ?? 0) + (b.cacheCreate1hTokens ?? 0);
    out.cacheCreate5mTokens = (a.cacheCreate5mTokens ?? 0) + (b.cacheCreate5mTokens ?? 0);
  }
  if (a.reasoningOutputTokens !== undefined || b.reasoningOutputTokens !== undefined) {
    out.reasoningOutputTokens = (a.reasoningOutputTokens ?? 0) + (b.reasoningOutputTokens ?? 0);
  }
  return out;
}

/** Whatever `flat` holds that the per-model buckets do not account for, or null
 *  when they account for all of it.
 *
 *  THIS IS THE PART THAT KEEPS THE FIX HONEST. The buckets come from the
 *  transcript scan; the flat total is the same scan's sum, so normally the
 *  difference is exactly zero. But the flat total is also where usage from
 *  paths the scan never saw arrives — a finished `Task` folds its subagent's
 *  tokens into its owner's `usage` and into nothing else — and a split that
 *  simply ignored the shortfall would make those tokens FREE. Attributing the
 *  remainder to the agent's current model is the old last-wins guess, applied
 *  now only to the tokens nothing better is known about instead of to the whole
 *  history. So: every token keeps exactly one price, and no token is counted
 *  twice in either direction.
 *
 *  Clamped at zero per field. A bucket sum larger than the flat total means the
 *  two arrived from different passes, and a negative bucket would subtract real
 *  money from a real row. */
function remainderUsage(flat: TokenUsage, mapped: readonly TokenUsage[]): TokenUsage | null {
  let i = 0, o = 0, r = 0, c = 0, h1 = 0, m5 = 0;
  for (const u of mapped) {
    i += u.inputTokens;
    o += u.outputTokens;
    r += u.cacheReadTokens;
    c += u.cacheCreateTokens;
    h1 += u.cacheCreate1hTokens ?? 0;
    m5 += u.cacheCreate5mTokens ?? 0;
  }
  const short = (whole: number, part: number) => Math.max(0, whole - part);
  const out: TokenUsage = {
    inputTokens: short(flat.inputTokens, i),
    outputTokens: short(flat.outputTokens, o),
    cacheReadTokens: short(flat.cacheReadTokens, r),
    cacheCreateTokens: short(flat.cacheCreateTokens, c),
  };
  if (flat.cacheCreate1hTokens !== undefined || flat.cacheCreate5mTokens !== undefined) {
    out.cacheCreate1hTokens = short(flat.cacheCreate1hTokens ?? 0, h1);
    out.cacheCreate5mTokens = short(flat.cacheCreate5mTokens ?? 0, m5);
  }
  const any = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheCreateTokens;
  return any > 0 ? out : null;
}

/**
 * An agent's tokens, grouped by the model that produced them.
 *
 * The single-entry answer — `[{ model: a.model, usage: a.usage }]` — is the
 * fallback and covers three real cases, all of which must go on pricing exactly
 * as they did before this landed: a Codex session, whose rollout reports one
 * running total and no split at all; a subagent, which carries no map; and any
 * session read by a server older than the field. In every one of those the old
 * arithmetic IS the right arithmetic, because there is only one model in play
 * or only one model known.
 *
 * Order is the map's own, which is the order the models first appear in the
 * transcript. Stable across passes, so a tooltip listing them does not reshuffle
 * itself every 2.5 seconds.
 */
export function usageByModelEntries(a: UsageBearing): ModelUsage[] {
  const map = a.usageByModel;
  const keys = map ? Object.keys(map) : [];
  if (!map || keys.length === 0) return [{ model: a.model, usage: a.usage }];

  const out: ModelUsage[] = keys.map(model => ({ model, usage: map[model] }));
  const rest = remainderUsage(a.usage, out.map(e => e.usage));
  if (rest) {
    const own = out.findIndex(e => e.model === a.model);
    // Merged into the matching row rather than pushed beside it, so one agent
    // never contributes two entries for one model — the by-model table counts
    // agents per row, and a row that claimed the same agent twice would say the
    // deck is running more sessions than it is.
    if (own >= 0) out[own] = { model: out[own].model, usage: addUsage(out[own].usage, rest) };
    else out.push({ model: a.model, usage: rest });
  }
  return out;
}

/**
 * What an agent's tokens actually cost, each bucket at its own model's rates.
 *
 * The replacement for `costForUsage(a.usage, a.model)` at every call site in
 * the deck. Identical to it, line item by line item, for an agent whose tokens
 * came from one model — which is most of them — and the sum of the parts for
 * one whose tokens did not.
 *
 * `now` is injectable for the same reason `costForUsage`'s is: Sonnet 5's
 * introductory rate ends 2026-08-31 and a test that depended on the day it ran
 * would start failing on its own.
 */
export function agentCost(a: UsageBearing, now: number = Date.now()): CostBreakdown {
  const out: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const e of usageByModelEntries(a)) {
    const c = costForUsage(e.usage, e.model, now);
    out.input += c.input;
    out.output += c.output;
    out.cacheRead += c.cacheRead;
    out.cacheWrite += c.cacheWrite;
    out.total += c.total;
  }
  return out;
}

/**
 * The tokens in this agent that no rate could be applied to.
 *
 * Per model, not per agent, and that is the whole change: a session that ran on
 * a priced model and then on one this build has never heard of used to be
 * either fully priced or fully unpriced depending on which of the two wrote the
 * last line. Now the priced half prints its dollars and the unpriced half prints
 * as the floor marker beside them, which is what the "+" on the session row has
 * always meant.
 */
export function agentUnpricedTokens(a: UsageBearing, now: number = Date.now()): number {
  let n = 0;
  for (const e of usageByModelEntries(a)) {
    if (ratesForModel(e.model, now) == null) n += e.usage.inputTokens + e.usage.outputTokens;
  }
  return n;
}

/**
 * Every model that produced tokens on this agent, first-seen order.
 *
 * Not the same list as "every model observed": a model the session switched to
 * and then away from before spending anything is not part of what this session
 * cost, and a card that counted it would promise a row the by-model table does
 * not have. Models with no tokens are dropped for that reason.
 */
export function agentModelIds(a: UsageBearing): string[] {
  const out: string[] = [];
  for (const e of usageByModelEntries(a)) {
    if (!e.model || out.includes(e.model)) continue;
    const u = e.usage;
    if (u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreateTokens <= 0) continue;
    out.push(e.model);
  }
  return out;
}

/**
 * The models this agent spent on OTHER than the one it is currently running —
 * the `+N` on the card's model chip, and the list in its tooltip.
 *
 * Asked this way round rather than as "is there more than one model", because
 * the two differ in the case that matters most: a session that has just typed
 * `/model` is on Sonnet with every token it has spent belonging to Opus. One
 * model produced the tokens, so a `spansModels` test says no; the chip still
 * names a model that produced none of the money printed beside it, which is the
 * misreading #686 is about, in miniature. What the card owes the reader is the
 * count of models its figure covers but its chip does not name.
 */
export function otherModelIds(a: UsageBearing): string[] {
  return agentModelIds(a).filter(m => m !== a.model);
}

/** Whether this agent's spend spans more than one model — the one thing a
 *  session card can say that its single model chip cannot. */
export function spansModels(a: UsageBearing): boolean {
  return agentModelIds(a).length > 1;
}
