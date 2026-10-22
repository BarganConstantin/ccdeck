// The usage headline under ccusage counts the work the board has watched since
// the last reading (live-delta.ts), and prices it with this build's own rate
// table. Tokens on a model that table has no rate for were added to the token
// strip with no dollars beside them, and the headline still read as an exact
// total: "$4.20 today" while some of what it covered had an unknown cost. The
// header's rule says a total with any unknown cost in it is a floor, "$X+",
// until the next reading prices those tokens or says it cannot.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fmtCost } from "../pricing";

const reading = vi.hoisted(() => ({ data: null as unknown, baseline: null as unknown }));

// What ccusage answered, and the board as it stood when that reading landed.
vi.mock("../use-usage-range", () => ({
  useUsageRange: () => ({ data: reading.data, shown: "today", stale: false, loading: false, baseline: reading.baseline }),
}));

const { default: UsagePanel } = await import("../components/UsagePanel");
const { initialState } = await import("../reducer");
const { ASSUMED } = await import("../providers");
const { boardBySession, liveDelta } = await import("../live-delta");
const { anyUnpriced } = await import("../usage-panel-rules");

/** One day of ccusage's daily report on one priced model, every cost known. */
function ccusage(cost: number) {
  return {
    ok: true,
    days: [{ period: "2026-10-22", totalCost: cost, modelBreakdowns: [{
      modelName: "claude-sonnet-5", cost, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0,
      missingPricing: false,
    }] }],
    sessions: [],
    totals: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1100, totalCost: cost },
  };
}

const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
const root = (sessionId: string, extra: object) =>
  ({ id: sessionId, kind: "root", state: "running", sessionId, label: sessionId, ...extra });
/** Sonnet 5 input tokens: priced, and not zero. */
const paid = (n: number) => root("paid", { model: "claude-sonnet-5", usage: usage(n) });
/** A proven ChatGPT auto-review share: its rate is known, and it is zero. */
const free = (n: number) => root("free", {
  provider: "codex", model: "codex-auto-review", usage: usage(n),
  usageByModel: { "codex-auto-review": { ...usage(n), bySpeed: { "chatgpt-auto-review-free": usage(n) } } },
});
/** A model this build has no rate for. */
const unknown = (n: number) => root("unknown", { model: "no-such-model-1", usage: usage(n) });

/** The headline value after the board moved from `before` (when the reading
 *  landed) to `after` (now). */
function headline(before: object[], after: object[]): string | null {
  reading.baseline = boardBySession(before as never, 0);
  const state = initialState();
  for (const a of after) state.agents.set((a as { id: string }).id, a as never);
  const html = renderToStaticMarkup(createElement(UsagePanel, {
    state, now: 0, providers: { ...ASSUMED, claude: false, codex: false }, onClose: () => {},
  })).replace(/<!-- -->/g, "");
  const m = /<div class="up-total"[^>]*>.*?<span class="up-total-value[^"]*">(.*?)<\/span>/s.exec(html);
  return m ? m[1].trim() : null;
}

describe("the usage headline under ccusage, with work since the reading", () => {
  beforeEach(() => { reading.data = ccusage(4.2); reading.baseline = null; });

  it("is a floor, '$X+', when that work is on a model with no rate", () => {
    expect(headline([unknown(500)], [unknown(1500)])).toBe(`${fmtCost(4.2)}+`);
  });

  it("stays exact when that work is priced", () => {
    // 500k more Sonnet 5 input tokens is $1.00 on top of the reading's $4.20.
    expect(headline([paid(500_000)], [paid(1_000_000)])).toBe(fmtCost(5.2));
  });

  it("stays exact when that work is a known zero", () => {
    expect(headline([free(500)], [free(1500)])).toBe(fmtCost(4.2));
  });

  it("stays exact when the unpriced session did nothing since the reading", () => {
    // Its earlier tokens are the reading's business: ccusage priced them here.
    expect(headline([unknown(500), paid(500_000)], [unknown(500), paid(1_000_000)])).toBe(fmtCost(5.2));
  });
});

describe("the unpriced rule with a live delta", () => {
  const row = { model: "claude-sonnet-5", cost: 4.2, tokens: 1100, missingPricing: false } as never;
  it("counts the delta's unpriced tokens under ccusage", () => {
    expect(anyUnpriced(true, [row], [], 1000)).toBe(true);
    expect(anyUnpriced(true, [row], [], 0)).toBe(false);
    expect(anyUnpriced(true, [row], [])).toBe(false);
  });

  it("leaves the board's own answer alone: the board's figures carry no delta", () => {
    expect(anyUnpriced(false, [], [{ priced: true } as never], 1000)).toBe(false);
  });
});

describe("the live delta's unpriced tokens", () => {
  it("counts only the unpriced tokens gained since the baseline", () => {
    const before = boardBySession([unknown(500), paid(500_000)] as never, 0);
    const after = boardBySession([unknown(1500), paid(1_000_000)] as never, 0);
    expect(liveDelta(before, after).unpricedTokens).toBe(1000);
    expect(liveDelta(after, after).unpricedTokens).toBe(0);
  });
});
