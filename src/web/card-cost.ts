// The card's cost tooltip: the multiplication behind the figure in its chip,
// written out so it can be checked by hand.
//
// Pure arithmetic over a usage record and a rate card, and it lived in
// AgentNode.tsx, so the suites that check the rows multiply out imported a
// React Flow component to reach it. It is here, beside nothing but the
// pricing it reads.
import { billedInputTokens, cacheWriteBreakdown, costForUsage, fmtCost, ratesForModel } from "./pricing";
import { agentCost, usageByModelEntries, type UsageBearing } from "./usage-models";
import type { TokenUsage } from "./types";

/** Multi-line breakdown for the cost chip tooltip — shows the actual
 *  multiplication so the user can verify pricing is sane.
 *  e.g. "input  725 × $5/M     = $0.00"
 *
 *  Every row must multiply out to the figure printed beside it, and the rows
 *  must sum to the total: this tooltip exists only to be checked by hand, so a
 *  row whose operands don't produce its own result is worse than no row. */
export function costBreakdownTooltip(usage: TokenUsage, modelId: string | undefined): string {
  const rates = ratesForModel(modelId);
  // This branch was unreachable until #400: the only element carrying this
  // tooltip was gated on the same ratesForModel call that returns null here, so
  // the graceful answer existed and could never be read. It names the model now
  // because that is the one thing the reader needs in order to act on it — the
  // sentence is otherwise a claim about nothing, and the id is what goes in the
  // issue asking for the row.
  if (!rates) {
    return `model: ${modelId}\nno published rate in this build — the tokens are counted, the dollars are not`;
  }
  const fmtN = (n: number) => n.toLocaleString();
  const fmtR = (r: number) => `$${r}/MTok`;
  const c = costForUsage(usage, modelId);
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
    `model: ${modelId}`,
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
  if (entries.length <= 1) return costBreakdownTooltip(a.usage, a.model);
  return [
    ...entries.map(e => costBreakdownTooltip(e.usage, e.model)),
    `═════════════════════════════════════════`,
    `all models                            = ${fmtCost(agentCost(a).total)}`,
  ].join("\n");
}
