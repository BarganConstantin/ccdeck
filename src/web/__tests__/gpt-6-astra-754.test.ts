// GPT-6 Astra gets a row, read from OpenAI's own pages rather than from the
// aggregators that quoted it first (#754).
//
// WHERE THE GROUND TRUTH COMES FROM. Read 2026-09-15:
//
//   developers.openai.com/api/docs/pricing — the only gpt-6 id on the sheet:
//     gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00
//     (short-context input, cached input, cache writes, output, then the same
//     four once a request's input passes 272K).
//   developers.openai.com/api/docs/models/gpt-6-astra — "1,050,000 context
//     window", one snapshot, and "Fast mode is priced at 2x the applicable
//     rates."
//
// Before this, the id reached no row: a Codex session on the model added
// nothing to the board's cost and drew its context donut against the 200,000
// default. Pinned here with arithmetic on a session rather than by reading the
// row back, because a table proved against itself proves nothing
// (rate-sheet-2026-09 makes the same argument).

import { describe, it, expect } from "vitest";
import {
  billedInputTokens,
  contextWindowForModel,
  costForUsage,
  ratesForModel,
  type TokenUsage,
} from "../pricing";

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...u,
} as TokenUsage);

describe("gpt-6-astra", () => {
  it("prices a session at the sheet's short-context rates", () => {
    const c = costForUsage(
      usage({
        inputTokens: 2_000_000,
        cacheReadTokens: 1_500_000,
        cacheCreateTokens: 200_000,
        outputTokens: 150_000,
      }),
      "gpt-6-astra",
    );
    // 300,000 uncached x $10 + 1,500,000 x $1 + 200,000 x $12.50 + 150,000 x $50
    expect(c.input).toBeCloseTo(3.00, 6);
    expect(c.cacheRead).toBeCloseTo(1.50, 6);
    expect(c.cacheWrite).toBeCloseTo(2.50, 6);
    expect(c.output).toBeCloseTo(7.50, 6);
    expect(c.total).toBeCloseTo(14.50, 6);
  });

  it("bills a cache write on its own line, at the sheet's $12.50", () => {
    // A zero cacheWrite would leave the written tokens on the input line and
    // render the cache-write line as "-" — see the gpt-5.6-cyber case in
    // rate-sheet-2026-09. The sheet publishes a write rate, so it is a line.
    const u = usage({ inputTokens: 1_000_000, cacheCreateTokens: 1_000_000 });
    expect(billedInputTokens(u, "gpt-6-astra")).toBe(0);
    expect(costForUsage(u, "gpt-6-astra").cacheWrite).toBeCloseTo(12.5, 6);
  });

  it("is not surcharged past 272K, the file's rule for every OpenAI row", () => {
    // The usage held for a Codex agent is the session's running total, and a
    // total crosses 272K on almost any multi-turn session while each request
    // stays below it. So five million input tokens are five million at $10,
    // not at the long-context $20.
    expect(costForUsage(usage({ inputTokens: 5_000_000 }), "gpt-6-astra").input).toBeCloseTo(50, 6);
  });

  it("prices the spellings the row claims to cover", () => {
    for (const id of ["gpt-6-astra", "GPT-6-Astra", "gpt_6_astra", "gpt-6-astra-2026-05-01"]) {
      expect(ratesForModel(id)?.output, id).toBe(50);
    }
  });

  it("refuses a named sibling nobody has read a rate for, rather than pricing it as Astra", () => {
    for (const id of ["gpt-6-astra-mini", "gpt-6-astra-pro", "gpt-6-astra_nano", "gpt-6"]) {
      expect(ratesForModel(id), id).toBeNull();
    }
  });

  it("draws its donut against the model page's 1,050,000 window, not the 200K default", () => {
    expect(contextWindowForModel("gpt-6-astra")).toBe(1_050_000);
  });
});
