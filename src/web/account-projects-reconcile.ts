// The dollars behind the Projects report, reconciled to ccusage.
//
// Kept out of the component so the invariant can be tested without a DOM. The
// rule the whole file exists to guarantee:
//
//   every dollar is reconciled on the DAY it was spent, then summed —
//   so Σ project totals === Σ daily totals === the period's attributed total,
//   and attributed + unattributed === the window's ccusage total.
//
// ccusage is the one cost authority on the machine; pricing.ts (costForUsage)
// only decides how a day-and-model's ccusage cost SPLITS between the projects
// active in it — a ratio, robust even when its absolute rates have drifted.
// Codex never enters: the caller passes a Claude-only ccByDayModel.
import { costForUsage } from "./pricing";
import { bareModelId } from "./model-id";
import type { TokenUsage } from "./types";

/** The compact per-model token counters the server sends. */
export interface Counters { i: number; o: number; cr: number; cc: number; c1h: number; c5m: number }
export interface DayInput {
  day: string;
  projects: Array<{ path: string; models: Record<string, Counters> }>;
  unattributed: Record<string, Counters> | null;
}

export interface Reconciled {
  projects: Array<{ path: string; cost: number; tokens: number }>;   // descending cost
  totalCost: number;                                                 // attributed total
  totalTokens: number;
  perDay: Array<{ day: string; total: number; byPath: Map<string, number> }>;
  unattributed: { cost: number; tokens: number } | null;
  reconciled: boolean;                                               // false = pricing.ts fallback
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

function pricedModel(models: Record<string, Counters>, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [m, c] of Object.entries(models)) out.set(m, (out.get(m) ?? 0) + costForUsage(toUsage(c), m, now).total);
  return out;
}

/**
 * @param daily            per-day, per-project (and per-day unattributed) token counters, the window's attributed days.
 * @param unattributedWin  the window's unattributed token sum (for the token count and the pricing.ts fallback).
 * @param ccByDayModel     ccusage cost keyed `${day}|${model}`, CLAUDE ONLY.
 * @param ccWindowTotal    ccusage's total cost over the window, Claude only.
 */
export function reconcile(
  daily: DayInput[],
  unattributedWin: Record<string, Counters> | null,
  ccByDayModel: Map<string, number>,
  ccWindowTotal: number,
  now: number = Date.now(),
): Reconciled {
  const reconciled = ccByDayModel.size > 0;

  // One scale per (day, model): ccusage cost over our pricing cost for the whole
  // day (attributed + that day's unattributed), so the denominator is complete.
  const scaleByDay = new Map<string, Map<string, number>>();
  for (const d of daily) {
    const our = pricedModel(d.projects.reduce((acc, p) => mergeCounters(acc, p.models), d.unattributed ? { ...d.unattributed } : {}), now);
    const sc = new Map<string, number>();
    for (const [m, ourTotal] of our) {
      const cc = ccByDayModel.get(`${d.day}|${m}`) ?? ccByDayModel.get(`${d.day}|${bareModelId(m)}`);
      sc.set(m, cc != null && ourTotal > 0 ? cc / ourTotal : 1);
    }
    scaleByDay.set(d.day, sc);
  }

  const costOnDay = (models: Record<string, Counters>, sc: Map<string, number>): number => {
    let cost = 0;
    for (const [m, c] of Object.entries(models)) cost += costForUsage(toUsage(c), m, now).total * (sc.get(m) ?? 1);
    return cost;
  };

  const byPath = new Map<string, { path: string; cost: number; tokens: number }>();
  const perDay: Reconciled["perDay"] = [];
  for (const d of daily) {
    const sc = scaleByDay.get(d.day) ?? new Map();
    const dayByPath = new Map<string, number>();
    let dayTotal = 0;
    for (const p of d.projects) {
      const cost = costOnDay(p.models, sc);
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

  // Unattributed = what ccusage counted that no project took, so attributed +
  // unattributed is the machine's real spend and days of only-unattributed work
  // are never lost. With no ccusage, price the window sum with pricing.ts.
  const unTokens = unattributedWin ? tokensOf(unattributedWin) : 0;
  let unCost = 0;
  if (reconciled) unCost = Math.max(0, ccWindowTotal - totalCost);
  else if (unattributedWin) for (const c of pricedModel(unattributedWin, now).values()) unCost += c;
  const unattributed = (unCost > 0 || unTokens > 0) ? { cost: unCost, tokens: unTokens } : null;

  return { projects, totalCost, totalTokens, perDay, unattributed, reconciled };
}

/** Add every model's counters of `src` into a copy of `into`. */
function mergeCounters(into: Record<string, Counters>, src: Record<string, Counters>): Record<string, Counters> {
  for (const [m, c] of Object.entries(src)) {
    const d = into[m] ?? (into[m] = { i: 0, o: 0, cr: 0, cc: 0, c1h: 0, c5m: 0 });
    d.i += c.i; d.o += c.o; d.cr += c.cr; d.cc += c.cc; d.c1h += c.c1h; d.c5m += c.c5m;
  }
  return into;
}
