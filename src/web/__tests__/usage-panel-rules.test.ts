// The usage panel's small decisions, called rather than matched.
//
// Each was an expression inside UsagePanel's render, and the row rule was
// written there twice — once per board table — so the suite pinned both
// spellings as text and could not say whether they agreed. They are
// usage-panel-rules.ts's now, and what each answers can be asked directly.
import { describe, it, expect } from "vitest";
import type { BoardModelRow, BoardSessionRow } from "../board-usage";
import type { ModelRow } from "../usage-from-ccusage";
import { anyUnpriced, quotaRefreshLabel, worthALine } from "../usage-panel-rules";

const cost = (total: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total });

function modelRow(dollars: number, input: number, output: number, priced = dollars > 0): BoardModelRow {
  return {
    model: "m", inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0,
    cost: cost(dollars), agentCount: 1, priced,
  } as BoardModelRow;
}

function sessionRow(dollars: number, input: number, output: number): BoardSessionRow {
  return {
    sessionId: "s", label: "vcrm-core", state: "active", cost: dollars,
    inputTokens: input, outputTokens: output, unpricedTokens: 0,
  } as BoardSessionRow;
}

function rangeRow(dollars: number, tokens: number): ModelRow {
  return {
    model: "m", cost: dollars, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    get tokens() { return this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheCreateTokens; },
  };
}

describe("which board rows are worth a line", () => {
  it("keeps a row whose dollars are unknown but whose tokens are not (#400)", () => {
    // The Codex row on a deck that also holds a priced Claude session: its
    // tokens are in the strip above, so it has to be in the table too.
    expect(worthALine(modelRow(0, 4_000_000, 200_000, false))).toBe(true);
    expect(worthALine(sessionRow(0, 4_000_000, 200_000))).toBe(true);
  });

  it("keeps a priced row", () => {
    expect(worthALine(modelRow(1.25, 10, 20))).toBe(true);
    expect(worthALine(sessionRow(1.25, 10, 20))).toBe(true);
  });

  it("keeps a row with dollars and no input or output — cache-only spend is still spend", () => {
    expect(worthALine(modelRow(0.4, 0, 0))).toBe(true);
    expect(worthALine(sessionRow(0.4, 0, 0))).toBe(true);
  });

  it("drops a row with neither", () => {
    expect(worthALine(modelRow(0, 0, 0))).toBe(false);
    expect(worthALine(sessionRow(0, 0, 0))).toBe(false);
  });

  it("answers a model row and a session row the same way for the same figures", () => {
    // The two tables share one rule, which is the point of having one: the
    // model row carries its dollars as a breakdown and the session row as a
    // number, and neither shape may change the answer.
    for (const [d, i, o] of [[0, 0, 0], [0, 1, 0], [0, 0, 1], [2, 0, 0], [2, 3, 4]] as const) {
      expect(worthALine(modelRow(d, i, o)), `${d}/${i}/${o}`).toBe(worthALine(sessionRow(d, i, o)));
    }
  });
});

describe("whether the unpriced note is owed", () => {
  it("asks ccusage's rows when the figures are ccusage's: tokens with no dollars", () => {
    expect(anyUnpriced(true, [rangeRow(3, 100), rangeRow(0, 50)], [])).toBe(true);
    expect(anyUnpriced(true, [rangeRow(3, 100)], [])).toBe(false);
    // Nothing spent at all is not unpriced — it is nothing.
    expect(anyUnpriced(true, [rangeRow(0, 0)], [])).toBe(false);
  });

  it("asks the board's own `priced` flag when the figures are the board's", () => {
    expect(anyUnpriced(false, [], [modelRow(1, 10, 10), modelRow(0, 10, 10, false)])).toBe(true);
    expect(anyUnpriced(false, [], [modelRow(1, 10, 10)])).toBe(false);
  });

  it("never reads the other source's rows", () => {
    // A board full of unpriced rows under a ccusage headline is not the note's
    // business, and neither is an unpriced ccusage row under the board's.
    expect(anyUnpriced(true, [rangeRow(3, 100)], [modelRow(0, 10, 10, false)])).toBe(false);
    expect(anyUnpriced(false, [rangeRow(0, 100)], [modelRow(1, 10, 10)])).toBe(false);
  });
});

describe("what the header's ↻ is called", () => {
  const providers = (claude: boolean, codex: boolean) => ({ kind: "reported" as const, claude, codex });

  it("names both quota sections only when both are drawn", () => {
    expect(quotaRefreshLabel(providers(true, true))).toBe("Refresh Claude + Codex quota");
  });

  it("names only the section that is there on a one-CLI deck", () => {
    expect(quotaRefreshLabel(providers(false, true))).toBe("Refresh Codex quota");
    expect(quotaRefreshLabel(providers(true, false))).toBe("Refresh Claude quota");
  });
});
