// The usage-history modal's reading of /api/ccusage: the rows it draws, the
// one place they are made safe to draw, and the colour each model is drawn in.
//
// Lifted out of UsageHistoryModal.tsx with the types they fill, so the rule
// that a row whose shape moved upstream reads as empty rather than throwing is
// a function the suite can call instead of a copy of one.

import { dayAgentSummary } from "./usage-agents";

// ── ccusage data shapes (subset we use) ────────────────────────────────────
export interface ModelBreakdown {
  modelName: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
/**
 * One CLI's share of a day, out of ccusage's `--by-agent` (#431).
 *
 * Optional on the day below, and every reader here treats its absence as "this
 * range has no split to show" rather than as an error: a ccusage too old to
 * know the flag makes the server fall back to the flagless run (see
 * ccusage.mjs), and those days arrive exactly as they always did.
 */
export interface AgentEntry {
  agent: string;             // ccusage's lowercase id — "claude", "codex", …
  totalCost: number;
  totalTokens: number;
}
export interface DayEntry {
  period: string;            // YYYY-MM-DD
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
  agents?: AgentEntry[];
  metadata?: { agents?: string[] };
}
/**
 * What the route really hands back, before anything here trusts it.
 *
 * usage-from-ccusage.ts — reading the SAME body for the usage panel — says why
 * this is necessary, and the modal did not: "this is parsed from a subprocess's
 * stdout two hops away, and a field that moved upstream must read as absent
 * rather than throw inside a render."
 *
 * The server passes `daily` through whole (`ccusage.mjs:1071`, "Passed through
 * whole.") and never inspects an element, and ccusage is resolved as
 * `ccusage@latest` through npx — an unpinned external dependency whose surface
 * has already moved under this deck twice, which is what `_sectionsUnsupported`
 * and `_byAgentUnsupported` are. A `daily` row arriving without
 * `modelBreakdowns` threw a TypeError inside a React render, and src/web has no
 * error boundary: main.tsx is a bare `root.render(<App />)`. So the whole deck
 * went blank — not just this modal — while the usage panel, reading the
 * identical payload, carried on.
 *
 * Normalised once at the boundary rather than guarded at each of the six
 * dereference sites, so a seventh reader added later cannot miss the rule.
 */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);

function asBreakdown(v: unknown): ModelBreakdown {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    modelName: str(o.modelName),
    cost: num(o.cost),
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
    cacheCreationTokens: num(o.cacheCreationTokens),
    cacheReadTokens: num(o.cacheReadTokens),
  };
}

export function asDay(v: unknown): DayEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const agents = Array.isArray(o.agents)
    ? o.agents.map(a => {
        const e = (a ?? {}) as Record<string, unknown>;
        return { agent: str(e.agent), totalCost: num(e.totalCost), totalTokens: num(e.totalTokens) };
      })
    : undefined;
  return {
    period: str(o.period),
    totalCost: num(o.totalCost),
    totalTokens: num(o.totalTokens),
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
    cacheCreationTokens: num(o.cacheCreationTokens),
    cacheReadTokens: num(o.cacheReadTokens),
    modelsUsed: strs(o.modelsUsed),
    modelBreakdowns: Array.isArray(o.modelBreakdowns) ? o.modelBreakdowns.map(asBreakdown) : [],
    ...(agents ? { agents } : {}),
    ...(o.metadata && typeof o.metadata === "object"
      ? { metadata: { agents: strs((o.metadata as Record<string, unknown>).agents) } }
      : {}),
  };
}

/** The reply, with every row made safe to render. Fields the modal only reads
 *  for a message (`reason`, `error`) keep their own optionality. */
export function asResp(v: unknown): CcusageResp {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    ...o,
    ok: o.ok === true,
    days: Array.isArray(o.days) ? o.days.map(asDay) : undefined,
  } as CcusageResp;
}

export interface CcusageResp {
  ok: boolean;
  days?: DayEntry[];
  totals?: Record<string, number> | null;
  since?: string;
  reason?: string;
  error?: string;
  fetchedAt?: number;
}

// ── helpers ─────────────────────────────────────────────────────────────────
/**
 * Stable per-model colour. Family-based so opus/sonnet/haiku/gpt read
 * consistently.
 *
 * A `var(--…)` string and not a hex, which is the whole of #583's first half.
 * These were eight literals chosen against the dark canvas — four of them
 * byte-identical to the dark theme's --accent, --ok, --warn and --err — and
 * because they are written into an inline `style` there is no selector the
 * stylesheet could add that would reach them: an inline style outranks the
 * cascade. On white they measured 1.40:1 to 2.56:1 against the modal's --panel,
 * every one under the 3:1 a bar in a bar chart owes SC 1.4.11.
 *
 * The boundary #330 drew for the session hues is the one that applies: this
 * function knows which model family a band is, the cascade knows which canvas
 * it is drawn on, and only one of those two should be deciding a lightness. So
 * the mapping stays here and the values live at :root, per theme, where a test
 * can compute them and a theme switch can answer them — which is exactly what
 * #357 did for --edge-transition, and legal in an inline style for the same
 * reason: `background: var(--usage-blue)` resolves against the element's own
 * computed custom properties.
 */
export function modelColor(m: string): string {
  const s = m.toLowerCase();
  if (s.includes("opus")) return "var(--usage-purple)";
  if (s.includes("sonnet")) return "var(--usage-blue)";
  if (s.includes("haiku")) return "var(--usage-green)";
  if (s.includes("gpt-5") || s.includes("gpt5")) return "var(--usage-amber)";
  if (s.includes("gpt")) return "var(--usage-red)";
  if (s.includes("gemini")) return "var(--usage-indigo)";
  if (s.includes("codex")) return "var(--usage-orange)";
  return "var(--usage-zinc)";
}

// ── the range, rolled up ────────────────────────────────────────────────────

/** A range's totals strip, and what each model cost across the range. */
export interface HistoryTotals {
  totalCost: number;
  totalTok: number;
  inOut: number;
  cacheRead: number;
  modelCosts: Map<string, number>;
}

/** Aggregate totals + per-model cost across the range. */
export function historyTotals(days: readonly DayEntry[]): HistoryTotals {
  let totalCost = 0, totalTok = 0, inOut = 0, cacheRead = 0;
  const modelCosts = new Map<string, number>();
  for (const d of days) {
    totalCost += d.totalCost;
    totalTok  += d.totalTokens;
    inOut     += d.inputTokens + d.outputTokens;
    cacheRead += d.cacheReadTokens;
    for (const mb of d.modelBreakdowns) {
      modelCosts.set(mb.modelName, (modelCosts.get(mb.modelName) ?? 0) + mb.cost);
    }
  }
  return { totalCost, totalTok, inOut, cacheRead, modelCosts };
}

/** The legend under the chart: every model the range ran, dearest first. */
export function legendOf(modelCosts: ReadonlyMap<string, number>): [string, number][] {
  return Array.from(modelCosts.entries()).sort((a, b) => b[1] - a[1]);
}

/** A day's models dearest first — the order its bar stacks them in and its
 *  breakdown lists them in, which were two copies of this sort. A copy, so the
 *  row keeps ccusage's own order. */
export function byCost(breakdowns: readonly ModelBreakdown[]): ModelBreakdown[] {
  return breakdowns.slice().sort((a, b) => b.cost - a.cost);
}

/** `part` as a percentage of `whole`, and 0 of nothing — the height of a day's
 *  bar against the dearest day, a model's band and row against its day, and a
 *  CLI's share of the range, which each wrote the guard out for themselves. */
export function percentOf(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** Which CLIs ran on a selected day, for the line in its header.
 *
 *  Priced when this day ran more than one CLI, and the bare id list it has
 *  always shown otherwise. The fallback is not dead weight: `metadata.agents`
 *  arrives with or without `--by-agent`, so it is the only thing a ccusage too
 *  old for the flag can put here, and it is what a single-CLI day keeps — see
 *  dayAgentSummary for why one CLI gets no figure. */
export function dayAgentsLine(day: DayEntry): string | null {
  const priced = dayAgentSummary(day.agents);
  return priced ?? (day.metadata?.agents?.length
    ? day.metadata.agents.join(" · ")
    : null);
}
