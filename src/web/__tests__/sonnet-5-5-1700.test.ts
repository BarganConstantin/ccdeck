// #1700: Claude Sonnet 5.5 shipped on 2026-09-28 and the deck had no rate for
// it. Sonnet 5's version guard refused `claude-sonnet-5-5`, as #688 means it
// to, so its cards read "not priced" and the Projects report counted its tokens
// as unpriced. The rate rows are pinned in bedrock-model-ids.test.ts and
// unrecognised-model-version.test.ts with every other model; this pins what
// the rest of the deck shows for the new id.
import { describe, it, expect } from "vitest";
import { costForUsage, ratesForModel } from "../pricing";
import { contextWindowForModel } from "../context-window";
import { shortModel } from "../model-label";

describe("Claude Sonnet 5.5", () => {
  it("is priced at the published rate, not left unpriced", () => {
    expect(ratesForModel("claude-sonnet-5-5")).toEqual(
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
    );
    // A million of each, so every term is its rate in dollars: $2 input, $10
    // output, $0.20 cache reads, and $2.50 + $4 for a million 5-minute and a
    // million 1-hour cache writes.
    const c = costForUsage({
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000,
      cacheCreateTokens: 2_000_000, cacheCreate5mTokens: 1_000_000, cacheCreate1hTokens: 1_000_000,
    }, "claude-sonnet-5-5");
    expect(c.input).toBeCloseTo(2);
    expect(c.output).toBeCloseTo(10);
    expect(c.cacheRead).toBeCloseTo(0.2);
    expect(c.cacheWrite).toBeCloseTo(6.5);
    expect(c.total).toBeCloseTo(18.7);
  });

  it("leaves Sonnet 5 exactly as it was", () => {
    expect(ratesForModel("claude-sonnet-5")).toEqual(ratesForModel("claude-sonnet-5-5"));
    expect(ratesForModel("claude-sonnet-5-6")).toBeNull();
  });

  it("has the 1M window and a label a chip can hold", () => {
    expect(contextWindowForModel("claude-sonnet-5-5")).toBe(1_000_000);
    expect(shortModel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(shortModel("us.anthropic.claude-sonnet-5-5")).toBe("Sonnet 5.5");
  });
});
