// How a session's context is said in one figure: "129k / 200k · 64%" (V4, owner
// answer 17). The Term header's chip says it today and the Inspector's Context
// tab will say it next, so the words are made in one place and the two cannot
// print two numbers for one fact. `fmtTokens` stays as it is for every other
// caller: it keeps a decimal under 100k ("61.4k"), which this figure does not.
import { effectiveContextWindow } from "./context-window";
import type { AgentNodeData } from "./types";

/** Whole thousands, so "129k" and "200k" line up as a pair; a million is "1M",
 *  and "1.2M" past it, with no trailing ".0". Under a thousand the number as is. */
export function contextTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  // 999,500 would round to "1000k": it is a million, said as one.
  if (v < 999_500) return `${Math.round(v / 1000)}k`;
  return `${String(Math.round(v / 100_000) / 10)}M`;
}

/** How full the window is, unrounded and held to 0..100: a session can run
 *  past a window it was assumed to have, and the window is then full, which is
 *  what the Inspector's Context tab says (100.0%) and its bar draws. */
export function contextPct(used: number, window: number): number {
  if (!(window > 0)) return 0;
  return Math.min(100, Math.max(0, (used / window) * 100));
}

/** The same fill as a whole percent: the number the header's chip prints. */
export function contextPercent(used: number, window: number): number {
  return Math.round(contextPct(used, window));
}

/** How full the agent's context window is: tokens used, the window's size and
 *  the percent (unrounded, capped at 100). One function for the Inspector's
 *  Context tab, the context modal and the Term header's chip (which rounds it),
 *  so none of them can print a second number for one fact. */
export function contextFill(agent: AgentNodeData): { used: number; limit: number; pct: number } {
  const used = agent.context?.currentContextTokens ?? 0;
  const limit = effectiveContextWindow(agent.contextWindow, agent.model);
  return { used, limit, pct: contextPct(used, limit) };
}

/** "129k / 200k · 64%"; with no window known, the used part alone, "129k". */
export function contextFigure(used: number, window?: number | null): string {
  const { lead, pct } = contextFigureParts(used, window);
  return pct == null ? lead : `${lead}${pct}`;
}

/** The figure in two pieces, so a narrow header can say the percent alone:
 *  "129k / 200k · " and "64%"; with no window known, "129k" and null. */
export function contextFigureParts(used: number, window?: number | null): { lead: string; pct: string | null } {
  if (!window || window <= 0) return { lead: contextTokens(used), pct: null };
  return { lead: `${contextTokens(used)} / ${contextTokens(window)} · `, pct: `${contextPercent(used, window)}%` };
}
