// The usage-history modal's arithmetic and colours, run rather than read.
//
// The range's totals, the legend's order, a day's models dearest first, the
// percentage every bar and band is drawn at and the line of CLIs over a
// selected day were written inline in UsageHistoryModal.tsx — two copies of
// the sort and four of the zero guard among them. They are usage-history.ts's
// now, beside the rows they read, and these are their answers.
import { describe, expect, it } from "vitest";

import { asDay, byCost, dayAgentsLine, historyTotals, legendOf, modelColor, percentOf, type ModelBreakdown } from "../usage-history";

const mb = (modelName: string, cost: number): ModelBreakdown =>
  ({ modelName, cost, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });

const DAYS = [
  asDay({ period: "2026-09-26", totalCost: 3, totalTokens: 1000, inputTokens: 100, outputTokens: 200, cacheReadTokens: 600,
    modelBreakdowns: [mb("claude-sonnet-5", 1), mb("claude-opus-5", 2)] }),
  asDay({ period: "2026-09-27", totalCost: 0, totalTokens: 0 }),
  asDay({ period: "2026-09-28", totalCost: 5.5, totalTokens: 4000, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2500,
    modelBreakdowns: [mb("claude-opus-5", 4), mb("gpt-5.4-codex", 1.5)] }),
];

describe("a range, rolled up", () => {
  it("adds up the strip over every day, a day with nothing on it included", () => {
    const t = historyTotals(DAYS);
    expect([t.totalCost, t.totalTok, t.inOut, t.cacheRead]).toEqual([8.5, 5000, 1800, 3100]);
  });

  it("costs each model across the range, once per model however many days ran it", () => {
    expect([...historyTotals(DAYS).modelCosts]).toEqual([["claude-sonnet-5", 1], ["claude-opus-5", 6], ["gpt-5.4-codex", 1.5]]);
  });

  it("answers an empty range with zeros and no models", () => {
    const t = historyTotals([]);
    expect([t.totalCost, t.totalTok, t.inOut, t.cacheRead, t.modelCosts.size]).toEqual([0, 0, 0, 0, 0]);
  });

  it("orders the legend dearest first", () => {
    expect(legendOf(historyTotals(DAYS).modelCosts).map(([m]) => m)).toEqual(["claude-opus-5", "gpt-5.4-codex", "claude-sonnet-5"]);
  });
});

describe("a day's models", () => {
  it("come dearest first, and the row keeps ccusage's own order", () => {
    const row = [mb("a", 1), mb("b", 3), mb("c", 2)];
    expect(byCost(row).map(b => b.modelName)).toEqual(["b", "c", "a"]);
    expect(row.map(b => b.modelName)).toEqual(["a", "b", "c"]);
  });
});

describe("the percentage a bar is drawn at", () => {
  it("is the part over the whole, and 0 of nothing rather than NaN or Infinity", () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(4, 4)).toBe(100);
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(3, 0)).toBe(0);
  });
});

describe("the line of CLIs over a selected day", () => {
  it("prices the split when the day ran two", () => {
    const day = asDay({ period: "2026-09-28", agents: [
      { agent: "claude", totalCost: 579, totalTokens: 1 }, { agent: "codex", totalCost: 0.004, totalTokens: 1 },
    ] });
    expect(dayAgentsLine(day)).toBe("Claude Code $579 · Codex <1¢");
  });

  it("falls back to the bare id list a ccusage too old for --by-agent still sends", () => {
    expect(dayAgentsLine(asDay({ period: "2026-09-28", metadata: { agents: ["claude", "codex"] } }))).toBe("claude · codex");
    // A single-CLI day gets no figure, and keeps the list.
    const one = asDay({ period: "2026-09-28", agents: [{ agent: "claude", totalCost: 5, totalTokens: 1 }], metadata: { agents: ["claude"] } });
    expect(dayAgentsLine(one)).toBe("claude");
  });

  it("says nothing when the day names no CLI at all", () => {
    expect(dayAgentsLine(asDay({ period: "2026-09-28" }))).toBeNull();
    expect(dayAgentsLine(asDay({ period: "2026-09-28", metadata: { agents: [] } }))).toBeNull();
  });
});

describe("the colour a model is drawn in", () => {
  it("is its family's token, whatever the case of the id", () => {
    expect(modelColor("claude-opus-5")).toBe("var(--model-opus)");
    expect(modelColor("Claude-Sonnet-5")).toBe("var(--model-sonnet)");
    expect(modelColor("claude-haiku-4-5")).toBe("var(--model-haiku)");
    expect(modelColor("gemini-2.5-pro")).toBe("var(--model-gemini)");
    expect(modelColor("codex-mini-latest")).toBe("var(--model-codex)");
    expect(modelColor("mystery-model-x")).toBe("var(--model-other)");
  });

  it("tells GPT-5 from the GPTs before it, and a GPT codex id by its GPT", () => {
    expect(modelColor("gpt-5.4")).toBe("var(--model-gpt5)");
    expect(modelColor("gpt5-mini")).toBe("var(--model-gpt5)");
    expect(modelColor("gpt-4.1")).toBe("var(--model-gpt)");
    expect(modelColor("gpt-5.4-codex")).toBe("var(--model-gpt5)");
  });
});
