// The dollars behind the Projects report, priced at ccusage's rate.
//
// Kept out of the component so the pricing rule can be tested without a DOM.
//
// ccusage is the one cost authority on the machine, but it reports per (day,
// model) TOTALS — for the whole day, including work this deck never tracked
// (before it was installed, or another tool's). So we do NOT force our tokens
// to absorb a day's whole cost; that inflated a partial day badly. Instead we
// take ccusage's own cost-per-token for the day and model — its cost over
// pricing.ts's price of ITS OWN tokens, a drift factor near 1 — and apply it to
// OUR tokens. Our tokens are then priced exactly as ccusage would price them,
// whether we tracked the whole day or a sliver of it. pricing.ts supplies the
// per-token shape (input vs output vs cache each have their own rate); ccusage
// supplies the calibration. Codex never enters: the caller passes a Claude-only
// ccByDayModel.
import { costForUsage } from "./pricing";
import { bareModelId } from "./model-id";
import type { TokenUsage } from "./types";

export interface Counters { i: number; o: number; cr: number; cc: number; c1h: number; c5m: number }
export interface DayInput {
  day: string;
  projects: Array<{ path: string; models: Record<string, Counters> }>;
  unattributed: Record<string, Counters> | null;
}
/** ccusage's own cost and tokens for one (day, model). */
export interface CcCell { cost: number; usage: TokenUsage }

export interface Reconciled {
  projects: Array<{ path: string; cost: number; tokens: number }>;   // descending cost
  totalCost: number;                                                 // attributed total
  totalTokens: number;
  perDay: Array<{ day: string; total: number; byPath: Map<string, number> }>;
  unattributed: { cost: number; tokens: number } | null;
  reconciled: boolean;                                               // false = pricing.ts alone
}

export function toUsage(c: Counters): TokenUsage {
  return {
    inputTokens: c.i, outputTokens: c.o,
    cacheReadTokens: c.cr, cacheCreateTokens: c.cc,
    cacheCreate1hTokens: c.c1h, cacheCreate5mTokens: c.c5m,
  };
}

/** Billed tokens of a model spread. c1h/c5m are a split OF cc, not extra. */
export function tokensOf(models: Record<string, Counters>): number {
  let t = 0;
  for (const c of Object.values(models)) t += c.i + c.o + c.cr + c.cc;
  return t;
}

/**
 * @param daily            per-day, per-project token counters (the attributed days).
 * @param unattributedWin  the window's unattributed token sum, priced apart.
 * @param ccByDayModel     ccusage's cost AND tokens keyed `${day}|${model}`, CLAUDE ONLY.
 */
export function reconcile(
  daily: DayInput[],
  unattributedWin: Record<string, Counters> | null,
  ccByDayModel: Map<string, CcCell>,
  now: number = Date.now(),
): Reconciled {
  const reconciled = ccByDayModel.size > 0;

  // The drift factor per (day, model): ccusage's cost over pricing.ts's price of
  // ccusage's OWN tokens. Near 1; 1 when a day/model is not in ccusage.
  const driftByDay = new Map<string, Map<string, number>>();
  for (const [key, cell] of ccByDayModel) {
    const bar = key.indexOf("|");
    const day = key.slice(0, bar);
    const model = key.slice(bar + 1);
    const priced = costForUsage(cell.usage, model, now).total;
    const drift = priced > 0 ? cell.cost / priced : 1;
    let m = driftByDay.get(day);
    if (!m) { m = new Map(); driftByDay.set(day, m); }
    m.set(model, drift);
  }
  const driftFor = (day: string, model: string): number => {
    const m = driftByDay.get(day);
    return (m?.get(model) ?? m?.get(bareModelId(model))) ?? 1;
  };

  const costOnDay = (models: Record<string, Counters>, day: string): number => {
    let cost = 0;
    for (const [m, c] of Object.entries(models)) cost += costForUsage(toUsage(c), m, now).total * driftFor(day, m);
    return cost;
  };

  const byPath = new Map<string, { path: string; cost: number; tokens: number }>();
  const perDay: Reconciled["perDay"] = [];
  for (const d of daily) {
    const dayByPath = new Map<string, number>();
    let dayTotal = 0;
    for (const p of d.projects) {
      const cost = costOnDay(p.models, d.day);
      dayByPath.set(p.path, (dayByPath.get(p.path) ?? 0) + cost);
      dayTotal += cost;
      let a = byPath.get(p.path);
      if (!a) { a = { path: p.path, cost: 0, tokens: 0 }; byPath.set(p.path, a); }
      a.cost += cost;
      a.tokens += tokensOf(p.models);
    }
    perDay.push({ day: d.day, total: dayTotal, byPath: dayByPath });
  }

  const projects = [...byPath.values()].sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens));
  const totalCost = projects.reduce((s, p) => s + p.cost, 0);
  const totalTokens = projects.reduce((s, p) => s + p.tokens, 0);

  // Unattributed is only what WE folded and could not tie to a project — never
  // ccusage's pre-tracking spend. Priced by pricing.ts, nudged by the window's
  // average drift so it reads in ccusage terms too. Zero ⇒ no row, which is what
  // a fresh install (or a reset) shows until work happens.
  let winCost = 0, winPriced = 0;
  for (const cell of ccByDayModel.values()) { winCost += cell.cost; }
  for (const [key, cell] of ccByDayModel) { winPriced += costForUsage(cell.usage, key.slice(key.indexOf("|") + 1), now).total; }
  const winDrift = winPriced > 0 ? winCost / winPriced : 1;
  const unTokens = unattributedWin ? tokensOf(unattributedWin) : 0;
  let unCost = 0;
  if (unattributedWin) for (const [m, c] of Object.entries(unattributedWin)) unCost += costForUsage(toUsage(c), m, now).total * winDrift;
  const unattributed = (unCost > 0 || unTokens > 0) ? { cost: unCost, tokens: unTokens } : null;

  return { projects, totalCost, totalTokens, perDay, unattributed, reconciled };
}
