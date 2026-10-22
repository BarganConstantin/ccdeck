import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UsageSessionBreakdown from "../components/UsageSessionBreakdown";
import { boardSessionTable, type BoardSessionRow } from "../board-usage";
import { fmtCost, UNPRICED_LABEL } from "../pricing";
import { modelRows, sessionRows, type SessionCostRow, type UsageRange } from "../usage-from-ccusage";
import { anyUnpriced } from "../usage-panel-rules";

// The usage panel's BY SESSION rows say a cost only when the deck knows it.
// Two sources, two rules:
// - a board row is priced from rates, so a cost of zero is shown when every
//   share has a rate (a known zero), and "not priced" only when one has none;
// - a ccusage row carries ccusage's reported figure and no pricing flag of its
//   own. Its zero is known when every model it ran on was priced over the range
//   (the days' per-model flags, read the way the BY MODEL table reads them), and
//   "not priced" otherwise.

const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
const root = { kind: "root", state: "done" as const };
// A proven ChatGPT auto-review share: its rate is known, and it is zero.
const freeReview = {
  ...root, sessionId: "free", label: "free",
  model: "codex-auto-review", usage: usage(1000),
  usageByModel: { "codex-auto-review": { ...usage(1000), bySpeed: { "chatgpt-auto-review-free": usage(1000) } } },
};
// A model this build has no rate for.
const unknown = { ...root, sessionId: "unknown", label: "unknown", model: "no-such-model-1", usage: usage(1000) };

function costCells(html: string): string[] {
  return [...html.matchAll(/<span class="up-session-cost[^"]*"[^>]*>([^<]*)/g)].map(m => m[1]);
}
function render(props: { fromRange: boolean; rangeSessionRows?: SessionCostRow[]; boardSessionRows?: BoardSessionRow[] }) {
  return renderToStaticMarkup(createElement(UsageSessionBreakdown, {
    rangeSessionRows: [], boardSessionRows: [], ...props,
    boardStates: new Map(), sessionsOpen: true, setSessionsOpen: () => {}, periodNoun: "today",
    sessionScale: { sum: 0, total: 0, over: false },
  }));
}
const rangeRow = (sessionId: string, cost: number, priced = false): SessionCostRow =>
  ({ sessionId, label: sessionId, agent: "claude", cost, priced, tokens: 1000, models: ["claude-sonnet-5"], lastActivityMs: null });

/** A ccusage range in the shape the route returns: one day's per-model
 *  breakdowns, and the session rows, in cost order. */
const breakdown = (modelName: string, cost: number, extra = {}) =>
  ({ modelName, cost, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, ...extra });
const session = (n: number, totalCost: number, modelsUsed: string[]) =>
  ({ period: `8d0e2c41-5a8f-4c1e-9b7a-1c2d3e4f5a${String(n).padStart(2, "0")}`, agent: "claude", totalCost, totalTokens: 1000, modelsUsed });
const ccusage = (breakdowns: object[], sessions: object[]): UsageRange =>
  ({ ok: true, days: [{ period: "2026-10-22", modelBreakdowns: breakdowns }], sessions });

describe("the cost a session row shows", () => {
  it("shows a board session's known zero cost, not 'not priced'", () => {
    const [row] = boardSessionTable([freeReview]);
    expect(row).toMatchObject({ cost: 0, priced: true, unpricedTokens: 0 });
    expect(costCells(render({ fromRange: false, boardSessionRows: [row] }))).toEqual([fmtCost(0)]);
  });

  it("still says 'not priced' for a board session with no rate", () => {
    const [row] = boardSessionTable([unknown]);
    expect(row.cost).toBe(0);
    expect(costCells(render({ fromRange: false, boardSessionRows: [row] }))).toEqual([UNPRICED_LABEL]);
  });

  it("shows a ccusage session's reported cost only when it is above zero", () => {
    const html = render({ fromRange: true, rangeSessionRows: [rangeRow("paid", 1.5), rangeRow("zero", 0)] });
    expect(costCells(html)).toEqual([fmtCost(1.5), UNPRICED_LABEL]);
  });

  it("shows a ccusage session's known zero on a priced model, not 'not priced'", () => {
    // Sonnet 5 has a price, and ccusage used it: a session on it that cost
    // nothing cost a known nothing. "not priced" there contradicted the note
    // under the list, which says it means a model with no published rate.
    const range = ccusage([breakdown("claude-sonnet-5", 4.2)], [session(1, 5.2, ["claude-sonnet-5"]), session(2, 0, ["claude-sonnet-5"])]);
    const rows = sessionRows(range);
    expect(rows.map(r => [r.cost, r.priced])).toEqual([[5.2, true], [0, true]]);
    expect(costCells(render({ fromRange: true, rangeSessionRows: rows }))).toEqual([fmtCost(5.2), fmtCost(0)]);
    // Nothing on the panel is unpriced, so the note does not show either.
    expect(anyUnpriced(true, modelRows(range), [])).toBe(false);
  });

  it("reads a known zero the same way from a ccusage that sends no pricing flag", () => {
    // Before ccusage 20.0.35 nothing says a price is missing; the BY MODEL
    // table then calls a model with tokens and no cost unpriced, and so does
    // a session that ran on it.
    const range = ccusage(
      [breakdown("claude-sonnet-5", 4.2), breakdown("no-such-model-1", 0)],
      [session(1, 0, ["claude-sonnet-5"]), session(2, 0, ["no-such-model-1"])],
    );
    expect(costCells(render({ fromRange: true, rangeSessionRows: sessionRows(range) }))).toEqual([fmtCost(0), UNPRICED_LABEL]);
  });

  it("still says 'not priced' for a ccusage session whose zero is not known", () => {
    const range = ccusage([
      breakdown("claude-sonnet-5", 4.2),
      // No price at all, and a price for only some of its usage.
      breakdown("no-such-model-1", 0, { missingPricing: true }),
      breakdown("gpt-6.1-sol", 1.1, { missingPricing: true }),
    ], [
      session(1, 0, ["no-such-model-1"]),
      session(2, 0, ["gpt-6.1-sol"]),
      // One unpriced model is enough.
      session(3, 0, ["claude-sonnet-5", "no-such-model-1"]),
      // Nothing to judge it by: no model named, or a model the days never mention.
      session(4, 0, []),
      session(5, 0, ["claude-opus-5"]),
    ]);
    const rows = sessionRows(range);
    expect(rows.every(r => !r.priced)).toBe(true);
    expect(costCells(render({ fromRange: true, rangeSessionRows: rows }))).toEqual(Array(5).fill(UNPRICED_LABEL));
  });
});
