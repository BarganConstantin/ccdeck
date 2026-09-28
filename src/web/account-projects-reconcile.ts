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
// supplies the calibration. Codex never enters: ccCellsFrom keeps Claude's
// breakdowns alone.
//
// A MODEL PRICING.TS HAS NO ROW FOR IS NOT $0 (#1330). costForUsage answers an
// unpriced model with a breakdown of zeros, and this file used to add those
// zeros up like any other price: Opus 5.5 carried 282M of one project's 326M
// tokens and the report printed the Sonnet remainder, $11.19, as that project's
// whole cost, with nothing on screen to say most of it was missing. The drift
// cannot rescue it either, because a drift multiplies pricing.ts's figure and
// that figure is the zero. So the tokens no row reaches are counted apart —
// per project, per day, and for the window — and every figure they belong to
// is marked as the floor it is. They are not priced from ccusage's cost for the
// day instead: that is a whole day's spend across every token type, and
// spreading it over our tokens by count is the guess the paragraph above
// refuses for a partial day, made worse by a mix nobody has checked.
import { costForUsage, fmtCost, ratesForModel, UNPRICED_LABEL } from "./pricing";
import { bareModelId } from "./model-id";
import { fmtTokens } from "./token-format";
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
  /** Descending cost. `cost` is the priced part only; `unpricedTokens` is the
   *  share of `tokens` on a model pricing.ts has no row for. */
  projects: Array<{ path: string; cost: number; tokens: number; unpricedTokens: number }>;
  totalCost: number;                                                 // attributed total, priced part
  totalTokens: number;
  /** Attributed tokens with no rate. Non-zero makes totalCost a floor. */
  unpricedTokens: number;
  perDay: Array<{ day: string; total: number; byPath: Map<string, number>; unpricedByPath: Map<string, number> }>;
  unattributed: { cost: number; tokens: number; unpricedTokens: number } | null;
  /** Every model in the window, attributed or not, that has tokens and no rate. */
  unpricedModels: string[];
  /** ccusage answered with at least one cell it could price. */
  calibrated: boolean;
  /** Calibrated, and every attributed token priced: the total is ccusage's
   *  dollars in full. False is pricing.ts alone, or a total with a hole in it. */
  reconciled: boolean;
}

export function toUsage(c: Counters): TokenUsage {
  return {
    inputTokens: c.i, outputTokens: c.o,
    cacheReadTokens: c.cr, cacheCreateTokens: c.cc,
    cacheCreate1hTokens: c.c1h, cacheCreate5mTokens: c.c5m,
  };
}

/** Billed tokens of one counter set. c1h/c5m are a split OF cc, not extra. */
function billedOf(c: Counters): number {
  return c.i + c.o + c.cr + c.cc;
}

/** Billed tokens of a model spread. */
export function tokensOf(models: Record<string, Counters>): number {
  let t = 0;
  for (const c of Object.values(models)) t += billedOf(c);
  return t;
}

/**
 * ccusage's range body as its cost and tokens per (day, model), keyed
 * `${day}|${model}` — the dollar authority reconcile() is calibrated against.
 * Empty for no body, which is what leaves the report on pricing.ts alone.
 *
 * Only Claude model breakdowns are read, so Codex cost never reconciles into a
 * project nor into the window total.
 *
 * Nor is a breakdown ccusage could not price. It says so with `missingPricing`
 * and a cost of 0 — its embedded catalog is what it falls back to when the
 * LiteLLM fetch fails, and 20.0.24's has no Opus 5.5 — and a cell of $0 over
 * real tokens would calibrate our tokens to $0 through a drift of zero, the
 * #1330 hole from the other side. Left out, the day and model are priced by
 * pricing.ts alone, which is what a model ccusage never saw gets anyway.
 */
export function ccCellsFrom(range: unknown): Map<string, CcCell> {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cells = new Map<string, CcCell>();
  const days = range && Array.isArray((range as { days?: unknown }).days) ? (range as { days: Array<Record<string, unknown>> }).days : [];
  for (const d of days) {
    const period = typeof d.period === "string" ? d.period : "";
    const mbs = Array.isArray(d.modelBreakdowns) ? (d.modelBreakdowns as Array<Record<string, unknown>>) : [];
    for (const b of mbs) {
      const mn = typeof b.modelName === "string" ? b.modelName : "";
      if (!period || !/claude/i.test(mn)) continue;
      if (b.missingPricing === true) continue;
      const key = `${period}|${mn}`;
      const cur = cells.get(key);
      const u = cur ? cur.usage : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cacheCreate1hTokens: 0, cacheCreate5mTokens: 0 };
      u.inputTokens += num(b.inputTokens);
      u.outputTokens += num(b.outputTokens);
      u.cacheReadTokens += num(b.cacheReadTokens);
      u.cacheCreateTokens += num(b.cacheCreationTokens);
      if (cur) cur.cost += num(b.cost);
      else cells.set(key, { cost: num(b.cost), usage: u });
    }
  }
  return cells;
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
  // The drift factor per (day, model): ccusage's cost over pricing.ts's price of
  // ccusage's OWN tokens. Near 1; 1 when a day/model is not in ccusage. A cell
  // is a calibration only when BOTH sides priced it: pricing.ts's zero is a
  // model it has no row for, and ccusage's zero is one it could not price, and
  // neither is a rate to scale anything by.
  const driftByDay = new Map<string, Map<string, number>>();
  let winCost = 0, winPriced = 0;
  for (const [key, cell] of ccByDayModel) {
    const bar = key.indexOf("|");
    const day = key.slice(0, bar);
    const model = key.slice(bar + 1);
    const priced = costForUsage(cell.usage, model, now).total;
    if (!(priced > 0 && cell.cost > 0)) continue;
    // The window's average drift, for Unattributed below, is summed over the
    // same cells and no others. A cost pricing.ts cannot match with a price of
    // its own used to go into the numerator alone: #1330's $95.82 of Opus 5.5
    // beside $13.20 of Sonnet put the window drift at about eight, and every
    // priced Unattributed token was multiplied by it.
    winCost += cell.cost;
    winPriced += priced;
    let m = driftByDay.get(day);
    if (!m) { m = new Map(); driftByDay.set(day, m); }
    m.set(model, cell.cost / priced);
  }
  const calibrated = winPriced > 0;
  const driftFor = (day: string, model: string): number => {
    const m = driftByDay.get(day);
    return (m?.get(model) ?? m?.get(bareModelId(model))) ?? 1;
  };

  const unpricedModels = new Set<string>();
  /** A spread's priced dollars at the given drift, and the tokens no row reached. */
  const priceSpread = (models: Record<string, Counters>, drift: (model: string) => number) => {
    let cost = 0, unpriced = 0;
    for (const [m, c] of Object.entries(models)) {
      if (ratesForModel(m, now)) { cost += costForUsage(toUsage(c), m, now).total * drift(m); continue; }
      const t = billedOf(c);
      if (t > 0) { unpriced += t; unpricedModels.add(m); }
    }
    return { cost, unpriced };
  };

  const byPath = new Map<string, { path: string; cost: number; tokens: number; unpricedTokens: number }>();
  const perDay: Reconciled["perDay"] = [];
  for (const d of daily) {
    const dayByPath = new Map<string, number>();
    const dayUnpriced = new Map<string, number>();
    let dayTotal = 0;
    for (const p of d.projects) {
      const { cost, unpriced } = priceSpread(p.models, m => driftFor(d.day, m));
      dayByPath.set(p.path, (dayByPath.get(p.path) ?? 0) + cost);
      if (unpriced > 0) dayUnpriced.set(p.path, (dayUnpriced.get(p.path) ?? 0) + unpriced);
      dayTotal += cost;
      let a = byPath.get(p.path);
      if (!a) { a = { path: p.path, cost: 0, tokens: 0, unpricedTokens: 0 }; byPath.set(p.path, a); }
      a.cost += cost;
      a.tokens += tokensOf(p.models);
      a.unpricedTokens += unpriced;
    }
    perDay.push({ day: d.day, total: dayTotal, byPath: dayByPath, unpricedByPath: dayUnpriced });
  }

  const projects = [...byPath.values()].sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens));
  const totalCost = projects.reduce((s, p) => s + p.cost, 0);
  const totalTokens = projects.reduce((s, p) => s + p.tokens, 0);
  const unpricedTokens = projects.reduce((s, p) => s + p.unpricedTokens, 0);

  // Unattributed is only what WE folded and could not tie to a project — never
  // ccusage's pre-tracking spend. Priced by pricing.ts, nudged by the window's
  // average drift so it reads in ccusage terms too. Zero ⇒ no row, which is what
  // a fresh install (or a reset) shows until work happens.
  const winDrift = calibrated ? winCost / winPriced : 1;
  const unTokens = unattributedWin ? tokensOf(unattributedWin) : 0;
  const un = unattributedWin ? priceSpread(unattributedWin, () => winDrift) : { cost: 0, unpriced: 0 };
  const unattributed = (un.cost > 0 || unTokens > 0) ? { cost: un.cost, tokens: unTokens, unpricedTokens: un.unpriced } : null;

  return {
    projects, totalCost, totalTokens, unpricedTokens, perDay, unattributed,
    unpricedModels: [...unpricedModels].sort(),
    calibrated,
    reconciled: calibrated && unpricedTokens === 0,
  };
}

/**
 * What a Projects cost cell prints. The dollars when every token under them is
 * priced; the dollars and a `+` when some are on a model this build has no row
 * for, because then the figure is a floor; UNPRICED_LABEL when none of them is.
 * The `+` is the one the Usage panel's session rows and the canvas cards
 * already print for a mixed session (#400), so a reader who has learned it
 * there reads it the same way here.
 *
 * `fmt` is the formatter the cell would otherwise use, so the grouped
 * Unattributed figure keeps its grouping.
 */
export function projectCostLabel(usd: number, unpricedTokens: number, fmt: (usd: number) => string = fmtCost): string {
  if (!(unpricedTokens > 0)) return fmt(usd);
  return usd > 0 ? `${fmt(usd)}+` : UNPRICED_LABEL;
}

/** The hover text on a figure that is a floor, in the Usage panel's words for
 *  the same thing. Undefined when the figure is whole, so no title is set. */
export function unpricedTitle(unpricedTokens: number): string | undefined {
  return unpricedTokens > 0
    ? `${fmtTokens(unpricedTokens)} of these tokens are on an unpriced model, so this is a floor`
    : undefined;
}

/** The sentence under the totals that names what the `+` leaves out. Null when
 *  every model in the window is priced. */
export function unpricedNote(models: string[]): string | null {
  if (models.length === 0) return null;
  const one = models.length === 1;
  const list = one ? models[0]
    : `${models.slice(0, -1).join(", ")} and ${models[models.length - 1]}`;
  return one
    ? `${list} is ${UNPRICED_LABEL}: this build holds no published rate for it, so its tokens are counted and its dollars are not.`
    : `${list} are ${UNPRICED_LABEL}: this build holds no published rate for them, so their tokens are counted and their dollars are not.`;
}
