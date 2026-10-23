// The usage panel's headline total, in the four states a total can be in, on
// both of its sources. Under ccusage it read "$5.30 today" while the table
// beside it said "$1.10+" and "not priced" and History said "$5.30+" for the
// same day; a deck where nothing could be priced, or where everything cost a
// known nothing, had no headline at all. The rule, the one History's total and
// the model table's rows already print with:
// - every cost known: an exact figure, with no "+" — a known $0 row included;
// - some cost unknown: the known part as a floor, "$X+";
// - no cost and some unknown: "not priced", never a bare or fake zero;
// - no cost, all of it known: a known zero, "—", the rows' own spelling.
// "not priced" is a state, not an amount: it takes the rows' muted italic
// (.up-unpriced), never the money green the figures are painted in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fmtCost, UNPRICED_LABEL } from "../pricing";

const reading = vi.hoisted(() => ({ data: null as unknown }));

// What ccusage answered — or null, which is a ccusage that failed or is absent,
// and leaves the panel on the board's live figures.
vi.mock("../use-usage-range", () => ({
  useUsageRange: () => ({ data: reading.data, shown: "today", stale: false, loading: false, baseline: null }),
}));

const { default: UsagePanel } = await import("../components/UsagePanel");
const { initialState } = await import("../reducer");
const { ASSUMED } = await import("../providers");

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

/** The headline as the reader sees it: the value, the label beside it, and
 *  whether the value is painted as a state (muted) rather than as money. */
function headline(agents: object[] = []): { value: string; label: string | null; muted: boolean } | null {
  const state = initialState();
  for (const a of agents) state.agents.set((a as { id: string }).id, a as never);
  const html = renderToStaticMarkup(createElement(UsagePanel, {
    state, now: 0, providers: { ...ASSUMED, claude: false, codex: false }, onClose: () => {},
  })).replace(/<!-- -->/g, "");
  const m = /<div class="up-total"[^>]*>(.*?)<\/div>/s.exec(html);
  if (!m) return null;
  const v = /<span class="(up-total-value[^"]*)">(.*?)<\/span>/s.exec(m[1]);
  const label = /<span class="up-total-label">(.*?)<\/span>/s.exec(m[1])?.[1] ?? null;
  return { value: v?.[2].trim() ?? "", label, muted: v?.[1].split(" ").includes("up-unpriced") ?? false };
}

const css = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");

describe("the usage headline under ccusage", () => {
  beforeEach(() => { reading.data = null; });

  it("is exact, with no '+', when every cost is known — a known $0 row included", () => {
    reading.data = ccusage([{ model: "claude-sonnet-5", cost: 4.2, missingPricing: false }, { model: "claude-haiku-5", cost: 0, missingPricing: false }]);
    expect(headline()).toEqual({ value: fmtCost(4.2), label: "today", muted: false });
  });

  it("is a floor, '$X+', when some cost is unknown", () => {
    reading.data = ccusage([
      { model: "claude-sonnet-5", cost: 4.2 },
      { model: "gpt-6.1-sol", cost: 1.1, missingPricing: true },
      { model: "no-such-model-1", cost: 0, missingPricing: true },
    ]);
    expect(headline()).toEqual({ value: `${fmtCost(5.3)}+`, label: "today", muted: false });
  });

  it("says 'not priced', not a bare zero, when no cost is known", () => {
    reading.data = ccusage([{ model: "no-such-model-1", cost: 0, missingPricing: true }]);
    expect(headline()).toEqual({ value: UNPRICED_LABEL, label: null, muted: true });
  });

  it("says the same of a ccusage that sends no pricing flag, by the table's own test", () => {
    // Before ccusage 20.0.35 nothing says a price is missing; tokens with no
    // cost are what the BY MODEL table calls unpriced.
    reading.data = ccusage([{ model: "no-such-model-1", cost: 0 }]);
    expect(headline()).toEqual({ value: UNPRICED_LABEL, label: null, muted: true });
  });

  it("shows a known zero as a known zero, not as unknown", () => {
    reading.data = ccusage([{ model: "claude-sonnet-5", cost: 0, missingPricing: false }]);
    expect(headline()?.value).toBe(fmtCost(0));
    expect(headline()?.value).not.toBe(UNPRICED_LABEL);
    expect(headline()?.muted).toBe(false);
  });
});

describe("the usage headline on the live board (ccusage failing)", () => {
  beforeEach(() => { reading.data = null; });

  it("is exact, with no '+', when every cost is known — a known $0 session included", () => {
    expect(headline([paid, free])).toEqual({ value: fmtCost(2), label: "spend on this board", muted: false });
  });

  it("is a floor, '$X+', when some session's model has no rate", () => {
    expect(headline([paid, unknown])).toEqual({ value: `${fmtCost(2)}+`, label: "spend on this board", muted: false });
  });

  it("says 'not priced', not a bare zero, when nothing on the board can be priced", () => {
    expect(headline([unknown])).toEqual({ value: UNPRICED_LABEL, label: null, muted: true });
  });

  it("shows a known zero as a known zero, not as unknown", () => {
    expect(headline([free])).toEqual({ value: fmtCost(0), label: null, muted: false });
  });

  it("prints no figure at all when there is no usage to total", () => {
    // ccusage failing and nothing on the board: the empty state, and no $0.
    expect(headline()).toBeNull();
  });
});

describe("the usage headline's 'not priced' paint", () => {
  it("takes the rows' muted italic over the money green, in every theme", () => {
    // .up-unpriced shares .up-total-value's specificity, so it wins the colour
    // only by coming later; gruvbox repaints the figure and must spare the state.
    const panel = css("usage-panel.css");
    expect(panel.indexOf(".up-unpriced {")).toBeGreaterThan(panel.indexOf(".up-total-value {"));
    expect(css("gruvbox.css")).toContain(':root[data-theme^="gruvbox-"] .up-total-value:not(.up-unpriced),');
  });
});
