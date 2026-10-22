import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UsageSessionBreakdown from "../components/UsageSessionBreakdown";
import { boardSessionTable, type BoardSessionRow } from "../board-usage";
import { fmtCost, UNPRICED_LABEL } from "../pricing";
import type { SessionCostRow } from "../usage-from-ccusage";

// The usage panel's BY SESSION rows say a cost only when the deck knows it.
// Two sources, two rules:
// - a board row is priced from rates, so a cost of zero is shown when every
//   share has a rate (a known zero), and "not priced" only when one has none;
// - a ccusage row carries ccusage's reported figure and no pricing flag, so it
//   keeps showing a cost only above zero, as before.

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
const rangeRow = (sessionId: string, cost: number): SessionCostRow =>
  ({ sessionId, label: sessionId, agent: "claude", cost, tokens: 1000, models: ["claude-sonnet-5"], lastActivityMs: null });

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
});
