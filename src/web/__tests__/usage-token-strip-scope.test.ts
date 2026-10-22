// The caption on the usage panel's token strip names what the strip counts.
//
// It prints only when the headline above has no money to carry a label — every
// model unpriced, or every cost a known zero — and it said "on this board" on
// both sources. Under ccusage that is false: the strip is ccusage's reading for
// the period on screen (today, this month, all time), read from the logs on
// disk, and the canvas is not what it counts. The caption takes the same word
// the headline's label takes when there is money, the period's noun, and keeps
// "on this board" for the board's own figures, where it is true.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const reading = vi.hoisted(() => ({ data: null as unknown, shown: "today" as string }));

// What ccusage answered, and for which period — or null, which is a ccusage
// that failed or is absent, and leaves the panel on the board's live figures.
vi.mock("../use-usage-range", () => ({
  useUsageRange: () => ({ data: reading.data, shown: reading.shown, stale: false, loading: false, baseline: null }),
}));

const { default: UsagePanel } = await import("../components/UsagePanel");
const { initialState } = await import("../reducer");
const { ASSUMED } = await import("../providers");
const { BOARD_SCOPE_LABEL } = await import("../board-usage");

/** One day of ccusage's daily report, its totals the sum of its rows. */
function ccusage(rows: Array<{ model: string; cost: number; missingPricing?: boolean }>) {
  const breakdowns = rows.map(r => ({
    modelName: r.model, cost: r.cost, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0,
    ...(r.missingPricing === undefined ? {} : { missingPricing: r.missingPricing }),
  }));
  const totalCost = rows.reduce((n, r) => n + r.cost, 0);
  return {
    ok: true,
    days: [{ period: "2026-10-22", totalCost, modelBreakdowns: breakdowns }],
    sessions: [],
    totals: { inputTokens: 1000 * rows.length, outputTokens: 100 * rows.length, cacheReadTokens: 0, cacheCreationTokens: 0,
      totalTokens: 1100 * rows.length, totalCost },
  };
}

const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
const root = (sessionId: string, extra: object) =>
  ({ id: sessionId, kind: "root", state: "done", sessionId, label: sessionId, ...extra });
/** A million Sonnet 5 input tokens: priced, and not zero. */
const paid = root("paid", { model: "claude-sonnet-5", usage: usage(1_000_000) });
/** A proven ChatGPT auto-review share: its rate is known, and it is zero. */
const free = root("free", {
  provider: "codex", model: "codex-auto-review", usage: usage(1000),
  usageByModel: { "codex-auto-review": { ...usage(1000), bySpeed: { "chatgpt-auto-review-free": usage(1000) } } },
});
/** A model this build has no rate for. */
const unknown = root("unknown", { model: "no-such-model-1", usage: usage(1000) });

/** The token strip as the reader sees it: whether it rendered, and its caption
 *  (null when the strip has none). */
function strip(agents: object[] = []): { caption: string | null } | null {
  const state = initialState();
  for (const a of agents) state.agents.set((a as { id: string }).id, a as never);
  const html = renderToStaticMarkup(createElement(UsagePanel, {
    state, now: 0, providers: { ...ASSUMED, claude: false, codex: false }, onClose: () => {},
  })).replace(/<!-- -->/g, "");
  const row = /<div class="up-tokens-row"[^>]*>(.*?)<\/div>/s.exec(html);
  if (!row) return null;
  return { caption: /<span class="up-tok up-scope">(.*?)<\/span>/s.exec(row[1])?.[1] ?? null };
}

describe("the token strip's caption under ccusage", () => {
  beforeEach(() => { reading.data = null; reading.shown = "today"; });

  it("names the period, not the board, when nothing is priced", () => {
    reading.data = ccusage([{ model: "no-such-model-1", cost: 0, missingPricing: true }]);
    expect(strip()).toEqual({ caption: "today" });
  });

  it("names the period, not the board, when every cost is a known zero", () => {
    reading.data = ccusage([{ model: "claude-sonnet-5", cost: 0, missingPricing: false }]);
    expect(strip()).toEqual({ caption: "today" });
  });

  it("names the period the figures came from", () => {
    reading.data = ccusage([{ model: "no-such-model-1", cost: 0, missingPricing: true }]);
    reading.shown = "month";
    expect(strip()).toEqual({ caption: "this month" });
    reading.shown = "all";
    expect(strip()).toEqual({ caption: "all time" });
  });

  it("never says 'on this board' over ccusage's figures, whatever the board holds", () => {
    // The canvas has sessions on it here, so a board figure exists — and the
    // strip is still ccusage's, so the board's scope is still the wrong one.
    for (const data of [
      ccusage([{ model: "no-such-model-1", cost: 0, missingPricing: true }]),
      ccusage([{ model: "claude-sonnet-5", cost: 0, missingPricing: false }]),
      ccusage([{ model: "no-such-model-1", cost: 0 }]),
    ]) {
      reading.data = data;
      expect(strip([unknown])?.caption).not.toBe(BOARD_SCOPE_LABEL);
    }
  });

  it("says it once: no caption when the headline above carries the period", () => {
    reading.data = ccusage([{ model: "claude-sonnet-5", cost: 4.2, missingPricing: false }]);
    expect(strip()).toEqual({ caption: null });
  });
});

describe("the token strip's caption on the live board (ccusage failing)", () => {
  beforeEach(() => { reading.data = null; reading.shown = "today"; });

  it("names the board when nothing on it is priced", () => {
    expect(strip([unknown])).toEqual({ caption: BOARD_SCOPE_LABEL });
  });

  it("names the board when every cost on it is a known zero", () => {
    expect(strip([free])).toEqual({ caption: BOARD_SCOPE_LABEL });
  });

  it("says it once: no caption when the headline above carries the board's label", () => {
    expect(strip([paid])).toEqual({ caption: null });
  });
});
