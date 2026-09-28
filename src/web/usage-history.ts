// The usage-history modal's reading of /api/ccusage: the rows it draws, and
// the one place they are made safe to draw.
//
// Lifted out of UsageHistoryModal.tsx with the types they fill, so the rule
// that a row whose shape moved upstream reads as empty rather than throwing is
// a function the suite can call instead of a copy of one.

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
