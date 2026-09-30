// The card's cost tooltip: the multiplication behind the figure in its chip,
// written out so it can be checked by hand.
//
// Pure arithmetic over a usage record and a rate card, and it lived in
// AgentNode.tsx, so the suites that check the rows multiply out imported a
// React Flow component to reach it. It is here, beside nothing but the
// pricing it reads.
import {
  STANDARD_SPEED, billedInputTokens, cacheWriteBreakdown, costAtSpeed, costForUsage, fmtCost,
  fmtCostRate, ratesForModel, speedShares,
} from "./pricing";
// Tokens are priced at the model that produced them. See usage-models.ts for
// what the last-wins multiplication this replaces was measured to cost (#686).
import { agentCost, agentUnpricedTokens, usageByModelEntries, type UsageBearing } from "./usage-models";
import type { AgentNodeData, TokenUsage } from "./types";

/** Multi-line breakdown for the cost chip tooltip — shows the actual
 *  multiplication so the user can verify pricing is sane.
 *  e.g. "input  725 × $5/M     = $0.00"
 *
 *  Every row must multiply out to the figure printed beside it, and the rows
 *  must sum to the total: this tooltip exists only to be checked by hand, so a
 *  row whose operands don't produce its own result is worse than no row. */
export function costBreakdownTooltip(usage: TokenUsage, modelId: string | undefined): string {
  if (!usage.bySpeed) return rateCardTooltip(usage, modelId, STANDARD_SPEED);
  // A session that ran fast has two rate cards on one model (#754), so one
  // multiplication cannot reproduce its total. One block per speed, the same
  // way agentCostTooltip gives one per model, and a standard share that holds
  // nothing is left out rather than printed as a block of zeros.
  const shares = speedShares(usage).filter(s => s.speed !== STANDARD_SPEED || hasTokens(s.usage));
  if (shares.length === 1) return rateCardTooltip(shares[0].usage, modelId, shares[0].speed);
  return [
    ...shares.map(s => rateCardTooltip(s.usage, modelId, s.speed)),
    `═════════════════════════════════════════`,
    `all speeds                            = ${fmtCost(costForUsage(usage, modelId).total)}`,
  ].join("\n");
}

function hasTokens(u: TokenUsage): boolean {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreateTokens > 0;
}

/** One rate card's multiplication: `usage` at `speed`'s rates. */
function rateCardTooltip(usage: TokenUsage, modelId: string | undefined, speed: string): string {
  const rates = ratesForModel(modelId, Date.now(), speed);
  const heading = speed === STANDARD_SPEED ? `model: ${modelId}` : `model: ${modelId} · ${speed}`;
  // This branch was unreachable until #400: the only element carrying this
  // tooltip was gated on the same ratesForModel call that returns null here, so
  // the graceful answer existed and could never be read. It names the model now
  // because that is the one thing the reader needs in order to act on it — the
  // sentence is otherwise a claim about nothing, and the id is what goes in the
  // issue asking for the row.
  if (!rates) {
    return `${heading}\nno published rate in this build — the tokens are counted, the dollars are not`;
  }
  const fmtN = (n: number) => n.toLocaleString();
  const fmtR = (r: number) => `$${r}/MTok`;
  const c = costAtSpeed(usage, modelId, speed);
  const cw = cacheWriteBreakdown(usage, rates);
  // Cache writes are billed per TTL — 2× input for a 1-hour entry, 1.25× for a
  // 5-minute one — so once a transcript reports both, one multiplication can't
  // reproduce the total the chip shows. Split the row rather than print a
  // product that doesn't check out.
  const cacheWriteRows = cw.tokens1h > 0
    ? [
        `cache w5m${fmtN(cw.tokens5m).padStart(14)}  × ${fmtR(rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd5m)}`,
        `cache w1h${fmtN(cw.tokens1h).padStart(14)}  × ${fmtR(rates.cacheWrite1h ?? rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd1h)}`,
      ]
    : [`cache w  ${fmtN(cw.tokens5m).padStart(14)}  × ${fmtR(rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd5m)}`];
  // Codex reports a single `input_tokens` that already contains the cached
  // prefix, and only the remainder is billed at the input rate — so the raw
  // count printed here disagreed with its own dollar column by ~10x on a
  // multi-turn session. Print the tokens the rate is applied to, and relabel
  // the row when that differs from what the agent reported so the missing
  // tokens are visibly the ones on the cache-read line below.
  const inputTokens = billedInputTokens(usage, modelId);
  const inputLabel = inputTokens === usage.inputTokens ? "input" : "uncached";
  return [
    heading,
    `${inputLabel.padEnd(9)}${fmtN(inputTokens).padStart(14)}  × ${fmtR(rates.input).padEnd(11)} = ${fmtCost(c.input)}`,
    `output   ${fmtN(usage.outputTokens).padStart(14)}  × ${fmtR(rates.output).padEnd(11)} = ${fmtCost(c.output)}`,
    `cache r  ${fmtN(usage.cacheReadTokens).padStart(14)}  × ${fmtR(rates.cacheRead).padEnd(11)} = ${fmtCost(c.cacheRead)}`,
    ...cacheWriteRows,
    `─────────────────────────────────────────`,
    `total                                 = ${fmtCost(c.total)}`,
  ].join("\n");
}

/** The same tooltip for a whole agent, one section per model its tokens came
 *  from (#686).
 *
 *  One section is the common case and renders byte-identically to what this card
 *  has always shown — a session on one model has one rate card, and a footer
 *  under a single block would be arithmetic about nothing. Two or more sections
 *  earn the footer, because that line is the only place on the card where the
 *  figure in the chip can be checked by hand: neither block's own total is it,
 *  and without the footer a reader has no way to see that the two were added
 *  rather than one of them chosen — which is precisely the mistake this whole
 *  change is about. */
export function agentCostTooltip(a: UsageBearing): string {
  const entries = usageByModelEntries(a);
  // The entry's usage rather than `a.usage`: the counts are the same, and only
  // the entry carries the speed split the chip's figure was priced with.
  if (entries.length <= 1) return costBreakdownTooltip(entries[0]?.usage ?? a.usage, a.model);
  return [
    ...entries.map(e => costBreakdownTooltip(e.usage, e.model)),
    `═════════════════════════════════════════`,
    `all models                            = ${fmtCost(agentCost(a).total)}`,
  ].join("\n");
}

/** What the cost slot at the end of the card's meta row holds: the marker for
 *  an agent with no priced spend at all, the figure with the tooltip that
 *  checks it, or nothing. `floor` is the `+` beside the figure.
 *
 *  The card drew this from an IIFE in its JSX; the decision is here, where it
 *  can be run, and the card draws what it says. */
export type CostChip =
  | { kind: "unpriced"; tt: string }
  | { kind: "spent"; total: number; floor: boolean; tt: string };

/** The slot's decision, for a card whose chip names a model — the card's own
 *  gate, and nothing is drawn without one. */
export function costChip(data: AgentNodeData): CostChip | null {
  if (!data.model) return null;
  // An unpriced model says so, in the slot the money would have used.
  // The gate here used to be `ratesForModel(data.model) &&`, which took
  // the whole element away the moment the lookup failed: a gpt-5.1-codex
  // card showed `412.3k tok` and then nothing, indistinguishable from a
  // session that had spent nothing, and the tooltip written for exactly
  // this case sat behind the failing call. The marker only appears once
  // there are tokens to price — a card with no usage yet has nothing to
  // be unpriced about, and would otherwise carry this the whole time it
  // was starting up.
  const rates = ratesForModel(data.model);
  const c = agentCost(data);
  // The two questions this branch asks have come apart (#686). `rates`
  // is about the model the card is ON — the one in the chip, the one the
  // next turn will use. `c.total` is about money already spent, which can
  // be real on a card whose current model has no published rate, and
  // zero on a card whose current model has one. So the marker is for the
  // agent with no priced spend AT ALL; an agent with some gets its
  // figure, and the `+` beside it says the figure is a floor because
  // some of its tokens reached no rate card — the same thing the "+" on
  // the usage panel's session rows has always meant.
  const unpricedTok = agentUnpricedTokens(data);
  if (!rates && c.total <= 0) {
    if ((data.usage.inputTokens + data.usage.outputTokens) <= 0) return null;
    return { kind: "unpriced", tt: agentCostTooltip(data) };
  }
  if (c.total <= 0) return null;
  // As of this render (#873). The card re-renders on its agent's events
  // and the rate lives in a tooltip, so it is at most one event stale.
  const elapsedSec = Math.max(0, ((data.endedAt ?? Date.now()) - data.startedAt) / 1000);
  // Not for a session the deck joined late (#822): its cost is the whole
  // session's and its clock only the part this page saw, so the quotient
  // would overstate the burn by however much of the session was missed.
  const rate = data.state === "active" && !data.synthetic ? fmtCostRate(c.total, elapsedSec) : null;
  const tt = agentCostTooltip(data) + (rate ? `\nburn: ${rate}` : "");
  // THE BURN RATE IS IN THE TOOLTIP AND NOWHERE ELSE NOW. The row is
  // flex, no-wrap, inside `overflow: hidden`, with 232px of content;
  // five items at 11px measure about 290px, so the live card — the one
  // case where a rate means anything — pushed its last item off the
  // right edge and said nothing about it. The rate was that item. It is
  // also derived from two figures printed 20px away, so of the five it
  // is the one whose removal costs a reader the least: the row now fits
  // in the state it used to break in, and the card loses a type size.
  return { kind: "spent", total: c.total, floor: unpricedTok > 0, tt };
}
