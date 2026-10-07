// GPT-6 Sol, GPT-6.1 Sol and GPT-6 Luna get rows, read from OpenAI's own pages
// (#1885).
//
// WHERE THE GROUND TRUTH COMES FROM. Read 2026-10-07:
//
//   developers.openai.com/api/docs/pricing, Standard, short context
//   (input, cached input, cache writes, output):
//     gpt-6.1-sol | $2.00 | $0.10 | $2.50  | $10.00
//     gpt-6-luna  | $0.10 | $0.01 | $0.125 | $0.50
//     gpt-6-sol   | $2.00 | $0.20 | $2.50  | $10.00   (under "All models")
//   developers.openai.com/api/docs/models/gpt-6-sol, .../gpt-6.1-sol and
//     .../gpt-6-luna — the same four numbers in each "Text tokens" panel, and
//     "1,050,000 context window" on all three.
//
// Before this, none of the three reached a row: a Codex session on any of them
// printed "not priced" and added nothing to the board's cost, and drew its
// context donut against the 200,000 default until Codex reported its own.
// gpt-6-sol is the one seen in rollouts here. Pinned with arithmetic on a
// session rather than by reading the row back, because a table proved against
// itself proves nothing.

import { describe, it, expect } from "vitest";
import { contextWindowForModel } from "../context-window";
import { costForUsage, ratesForModel, type TokenUsage } from "../pricing";

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...u,
} as TokenUsage);

/** One Codex session: two million input tokens of which 1.5M were cache hits,
 *  200K cache writes, 150K output. */
const SESSION = usage({
  inputTokens: 2_000_000,
  cacheReadTokens: 1_500_000,
  cacheCreateTokens: 200_000,
  outputTokens: 150_000,
});

describe("gpt-6-sol", () => {
  it("prices a session at the sheet's short-context rates", () => {
    const c = costForUsage(SESSION, "gpt-6-sol");
    // 300,000 uncached x $2 + 1,500,000 x $0.20 + 200,000 x $2.50 + 150,000 x $10
    expect(c.input).toBeCloseTo(0.60, 6);
    expect(c.cacheRead).toBeCloseTo(0.30, 6);
    expect(c.cacheWrite).toBeCloseTo(0.50, 6);
    expect(c.output).toBeCloseTo(1.50, 6);
    expect(c.total).toBeCloseTo(2.90, 6);
  });

  it("draws its donut against the model page's 1,050,000 window", () => {
    expect(contextWindowForModel("gpt-6-sol")).toBe(1_050_000);
  });
});

describe("gpt-6.1-sol", () => {
  it("prices a session at the sheet's short-context rates, its cache hits at half gpt-6-sol's", () => {
    const c = costForUsage(SESSION, "gpt-6.1-sol");
    // 300,000 uncached x $2 + 1,500,000 x $0.10 + 200,000 x $2.50 + 150,000 x $10
    expect(c.input).toBeCloseTo(0.60, 6);
    expect(c.cacheRead).toBeCloseTo(0.15, 6);
    expect(c.cacheWrite).toBeCloseTo(0.50, 6);
    expect(c.output).toBeCloseTo(1.50, 6);
    expect(c.total).toBeCloseTo(2.75, 6);
  });

  it("draws its donut against the model page's 1,050,000 window", () => {
    expect(contextWindowForModel("gpt-6.1-sol")).toBe(1_050_000);
  });
});

describe("gpt-6-luna", () => {
  it("prices a session at the sheet's short-context rates", () => {
    const c = costForUsage(SESSION, "gpt-6-luna");
    // 300,000 uncached x $0.10 + 1,500,000 x $0.01 + 200,000 x $0.125 + 150,000 x $0.50
    expect(c.input).toBeCloseTo(0.030, 6);
    expect(c.cacheRead).toBeCloseTo(0.015, 6);
    expect(c.cacheWrite).toBeCloseTo(0.025, 6);
    expect(c.output).toBeCloseTo(0.075, 6);
    expect(c.total).toBeCloseTo(0.145, 6);
  });

  it("draws its donut against the model page's 1,050,000 window", () => {
    expect(contextWindowForModel("gpt-6-luna")).toBe(1_050_000);
  });
});

describe("the three new rows", () => {
  it("price the spellings they claim to cover", () => {
    const outputs: Array<[string, number]> = [
      ["gpt-6-sol", 10], ["GPT-6-Sol", 10], ["gpt_6_sol", 10], ["gpt-6-sol-2026-04-20", 10],
      ["gpt-6.1-sol", 10], ["gpt_6_1_sol", 10], ["gpt-6.1-sol-2026-04-30", 10],
      ["gpt-6-luna", 0.5], ["gpt_6_luna", 0.5], ["gpt-6-luna-2026-05-18", 0.5],
    ];
    for (const [id, output] of outputs) expect(ratesForModel(id)?.output, id).toBe(output);
    expect(ratesForModel("gpt-6.1-sol")?.cacheRead).toBe(0.10);
    expect(ratesForModel("gpt-6-sol")?.cacheRead).toBe(0.20);
  });

  it("refuse a sibling nobody has read a rate for, rather than pricing it as its family", () => {
    for (const id of [
      "gpt-6-sol-mini", "gpt-6-sol-pro", "gpt-6-luna-nano", "gpt-6-luna_mini", "gpt-6.1-sol-pro",
      "gpt-6.1", "gpt-6.1-luna", "gpt-6.2-sol", "gpt-6",
    ]) {
      expect(ratesForModel(id), id).toBeNull();
    }
  });
});
