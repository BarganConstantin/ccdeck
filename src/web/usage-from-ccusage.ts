// The Usage panel's numbers, from ccusage rather than from the canvas.
//
// The panel used to sum the agents drawn on the board. Those are honest figures
// with an unusual scope, and the scope was the problem: the canvas evicts
// finished sessions on a timer, so the total went DOWN while nothing had
// happened and nothing had been refunded. #737 is the whole argument; this is
// the data layer of the answer.
//
// ccusage reads Claude Code's and Codex's own transcripts, so it knows every
// session that ever ran and forgets none of them. It also keeps its own rate
// table, which is a second reason to prefer it: this deck shipped Sonnet 5 at
// fifty per cent over for four days after Anthropic cancelled an announced
// increase, and shipped Fable 5.1 as "not priced" until somebody noticed. On
// the same machine, on the same day, ccusage had both right.
//
// Everything here is pure. The fetch, the caching and the two child processes
// live on the server; what a component needs is the shaping, and shaping is the
// part worth pinning in a test.
import { presetSince } from "./usage-range";

/** One row of the BY MODEL table. */
export interface ModelRow {
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  get tokens(): number;
}

/** One row of the BY SESSION table, after the join to the canvas. */
export interface SessionCostRow {
  sessionId: string;
  /** The project name the board knows this session by, or null when the board
   *  has never drawn it — a session from last week, or from another machine's
   *  transcripts. A uuid is not a label, so the component decides what to show
   *  and this layer does not invent one. */
  label: string | null;
  agent: string;
  cost: number;
  tokens: number;
  models: string[];
  lastActivityMs: number | null;
}

/** What the panel totals across the chosen period. */
export interface RangeTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  tokens: number;
}

/**
 * The three spans the panel offers, and the words for them.
 *
 * "all" is spelled as a date rather than as an absent one because ccusage's
 * `--since` is required by the deck's own route — `/api/ccusage` refuses a
 * range whose ends are not YYYYMMDD, which is what keeps a user-supplied string
 * out of an argv. 2020 predates every coding CLI this reads.
 */
export type PeriodKey = "today" | "month" | "all";

export const PERIODS: ReadonlyArray<{ key: PeriodKey; label: string; noun: string }> = [
  { key: "today", label: "today", noun: "today" },
  { key: "month", label: "month", noun: "this month" },
  { key: "all", label: "all", noun: "all time" },
];

/**
 * The `since` a period asks ccusage for, against a given clock.
 *
 * LOCAL calendar dates, never UTC — `presetSince` carries the whole argument
 * and the bug it was written for, and "today" is exactly its one-day preset, so
 * that is where today comes from rather than from a second implementation of
 * the same rule.
 *
 * The month start cannot be spelled as an N-day preset, because N is 28 to 31
 * depending on where in the month you ask. It is built from the same local
 * calendar fields for the same reason: a month that began at 03:00 on the 1st
 * because the reader is in UTC+3 is a month missing its first morning.
 */
export function sinceFor(key: PeriodKey, now = new Date()): string {
  if (key === "today") return presetSince(1, now);
  if (key === "month") return presetSince(now.getDate(), now);
  // Before every coding CLI this reads. Spelled as a date rather than left out
  // because /api/ccusage refuses a range whose ends are not YYYYMMDD, which is
  // what keeps a user-supplied string out of an argv.
  return "20200101";
}

/** The shapes the route returns, named so the reader can see what is optional.
 *  Everything here is `unknown`-tolerant: this is parsed from a subprocess's
 *  stdout two hops away, and a field that moved upstream must read as absent
 *  rather than throw inside a render. */
interface RawModelBreakdown {
  modelName?: unknown; cost?: unknown;
  inputTokens?: unknown; outputTokens?: unknown;
  cacheReadTokens?: unknown; cacheCreationTokens?: unknown;
}
interface RawDay { modelBreakdowns?: unknown }
interface RawSession {
  period?: unknown; agent?: unknown; totalCost?: unknown; totalTokens?: unknown;
  modelsUsed?: unknown; metadata?: unknown;
}
export interface UsageRange {
  ok?: unknown;
  days?: unknown;
  sessions?: unknown;
  totals?: unknown;
  fetchedAt?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * BY MODEL, summed across every day in the range.
 *
 * ccusage gives one breakdown per day, so a month is thirty lists that have to
 * be folded into one — summing rather than concatenating is the whole of this
 * function, and getting it wrong shows Opus five times instead of once.
 *
 * Sorted by cost, then by tokens. A model with tokens and no price — one this
 * ccusage does not know — still earns its row: the tokens were really spent,
 * and hiding the row would make the totals look complete when they are not.
 */
export function modelRows(range: UsageRange | null | undefined): ModelRow[] {
  const days = Array.isArray(range?.days) ? (range.days as RawDay[]) : [];
  const by = new Map<string, ModelRow>();
  for (const day of days) {
    const breakdowns = Array.isArray(day?.modelBreakdowns) ? (day.modelBreakdowns as RawModelBreakdown[]) : [];
    for (const b of breakdowns) {
      const model = str(b?.modelName);
      if (!model) continue;
      let row = by.get(model);
      if (!row) {
        row = {
          model, cost: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheCreateTokens: 0,
          get tokens() {
            return this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheCreateTokens;
          },
        };
        by.set(model, row);
      }
      row.cost += num(b?.cost);
      row.inputTokens += num(b?.inputTokens);
      row.outputTokens += num(b?.outputTokens);
      row.cacheReadTokens += num(b?.cacheReadTokens);
      row.cacheCreateTokens += num(b?.cacheCreationTokens);
    }
  }
  return [...by.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/**
 * BY SESSION, joined to whatever the board can name.
 *
 * `period` on a session row is the session id — the same uuid Claude Code puts
 * in every hook payload, and the key the canvas files its agents under. That is
 * the join, and it is why this list can say "agents-deck" where ccusage alone
 * would say "07ac7b2b".
 *
 * `names` is a lookup rather than the graph itself so this stays pure and the
 * component decides where names come from.
 */
export function sessionRows(
  range: UsageRange | null | undefined,
  names: ReadonlyMap<string, string> = new Map(),
): SessionCostRow[] {
  const raw = Array.isArray(range?.sessions) ? (range.sessions as RawSession[]) : [];
  const rows: SessionCostRow[] = [];
  for (const s of raw) {
    const sessionId = str(s?.period);
    if (!sessionId) continue;
    const meta = s?.metadata as { lastActivity?: unknown } | undefined;
    const last = typeof meta?.lastActivity === "string" ? Date.parse(meta.lastActivity) : NaN;
    rows.push({
      sessionId,
      label: names.get(sessionId) ?? null,
      agent: str(s?.agent) || "claude",
      cost: num(s?.totalCost),
      tokens: num(s?.totalTokens),
      models: Array.isArray(s?.modelsUsed) ? (s.modelsUsed as unknown[]).map(str).filter(Boolean) : [],
      lastActivityMs: Number.isFinite(last) ? last : null,
    });
  }
  return rows.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/**
 * The headline figures.
 *
 * Taken from `totals` when ccusage sent one and folded from the days when it
 * did not — a range with one day and no totals block is a shape this has to
 * survive, and a headline of zero above a populated table is the worst of the
 * two answers.
 */
export function rangeTotals(range: UsageRange | null | undefined): RangeTotals {
  const t = range?.totals as Record<string, unknown> | null | undefined;
  if (t && typeof t === "object") {
    const cache = num(t.cacheReadTokens);
    const create = num(t.cacheCreationTokens);
    const input = num(t.inputTokens);
    const output = num(t.outputTokens);
    return {
      cost: num(t.totalCost),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cache,
      cacheCreateTokens: create,
      tokens: num(t.totalTokens) || input + output + cache + create,
    };
  }
  const rows = modelRows(range);
  const sum = (pick: (r: ModelRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const input = sum(r => r.inputTokens);
  const output = sum(r => r.outputTokens);
  const cache = sum(r => r.cacheReadTokens);
  const create = sum(r => r.cacheCreateTokens);
  return {
    cost: sum(r => r.cost),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cache,
    cacheCreateTokens: create,
    tokens: input + output + cache + create,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam between the two sources, as functions rather than as ternaries in
// the middle of a 1,200-line component.
//
// #737 gave the panel two sources — ccusage for a period, the canvas for right
// now — and every figure on screen has to come from ONE of them. That is not a
// property a reader can check by looking at the JSX, and it was not a property
// anything could check at all: `usage-panel-source-737.test.ts` asserted the
// panel's SOURCE TEXT, twenty-three string matches deep, because the suite has
// no DOM. A string match cannot tell a correct pairing from a plausible one, and
// it fails on every harmless rename.
//
// So the decisions moved here, where they can be called. What is left in the
// component is markup reading their answers.

/** One reading, and the period it answers — what the fetch hands back. */
export interface Landed { period: PeriodKey; data: UsageRange }

/** What the panel is currently showing, as opposed to what was last pressed. */
export interface RangeView {
  /** The reading on screen, or null for a deck with no ccusage answer yet. */
  data: UsageRange | null;
  /** Which period that reading is OF. Null before the first one lands. */
  shown: PeriodKey | null;
  /** A slower period was pressed and has not answered; the figures are the
   *  previous period's and are dimmed rather than blanked. */
  stale: boolean;
}

/**
 * What to show, given what has landed and what is pressed.
 *
 * The subtlety this exists for: `period` moves on the press and the answer
 * arrives seconds later, so a panel that labelled its figures with the PRESSED
 * period would print "$4.20 all time" over today's money and rewrite itself a
 * moment later. It shows "$4.20 today", dimmed, until `all` answers.
 */
export function rangeView(landed: Landed | null, pressed: PeriodKey): RangeView {
  return {
    data: landed?.data ?? null,
    shown: landed?.period ?? null,
    stale: landed != null && landed.period !== pressed,
  };
}

/**
 * The word printed over the figures: the noun of the period they came FROM.
 *
 * Falls back to the pressed period before anything has landed, and to "today"
 * for a key no longer in PERIODS — a stored preference from an older build must
 * not leave the headline with no noun at all.
 */
export function nounFor(shown: PeriodKey | null, pressed: PeriodKey): string {
  return PERIODS.find(p => p.key === (shown ?? pressed))?.noun ?? "today";
}

/** Everything the canvas can add to a reading between two of them. Structurally
 *  `LiveDelta` from live-delta.ts, spelled here so the shaping layer does not
 *  depend on the graph's types. */
export interface Delta {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/** Whatever the canvas currently sums to. `BoardTotals` from board-usage.ts,
 *  again spelled structurally. */
export interface Board {
  cost: { total: number };
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  sum: number;
}

/** Every headline figure, and where each one came from. */
export interface PanelFigures {
  /** True when ccusage answered. Every field below follows it — that is the
   *  whole contract, and the reason they are computed together. */
  fromRange: boolean;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Gates the money block: a deck where nothing is priced shows tokens only. */
  hasCost: boolean;
  /** Gates the whole body. Under ccusage this is the RANGE's token count, so an
   *  empty period is empty rather than falling back to the board's figure. */
  tokenSum: number;
  /** The stacked input/output/cache bar, which only the board can support:
   *  ccusage publishes one cost per model and not that split, so drawing it
   *  under a ccusage headline would derive the shares from THIS deck's rate
   *  table and hang them beneath a figure measured somewhere else. */
  showCostBar: boolean;
}

/**
 * Pair every figure with its source, once.
 *
 * THE DELTA IS ADDED TO THE READING AND NEVER TO THE BOARD. It is the work the
 * canvas has seen since the reading landed — the gap ccusage's one-minute
 * cadence leaves — so adding it to a board total, which already counts that
 * work, would report it twice. Under the board there is no gap to fill: the
 * board IS the canvas.
 */
export function panelFigures(range: UsageRange | null, board: Board, delta: Delta): PanelFigures {
  const fromRange = range != null;
  const sum = rangeTotals(range);
  return {
    fromRange,
    cost: fromRange ? sum.cost + delta.cost : board.cost.total,
    inputTokens: fromRange ? sum.inputTokens + delta.inputTokens : board.inputTokens,
    outputTokens: fromRange ? sum.outputTokens + delta.outputTokens : board.outputTokens,
    cacheReadTokens: fromRange ? sum.cacheReadTokens + delta.cacheReadTokens : board.cacheReadTokens,
    cacheCreateTokens: fromRange ? sum.cacheCreateTokens + delta.cacheCreateTokens : board.cacheCreateTokens,
    hasCost: fromRange ? sum.cost > 0 : board.cost.total > 0,
    tokenSum: fromRange ? sum.tokens : board.sum,
    showCostBar: !fromRange,
  };
}
