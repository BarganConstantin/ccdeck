// Two rate-sheet defects found in one sweep, pinned here with the arithmetic
// that makes each wrong number visible rather than with the table's own
// literals — a table proved against itself proves nothing (bedrock-model-ids
// makes the same argument at its PINNED block, and holds the literals).
//
// WHERE THE GROUND TRUTH COMES FROM. Read 2026-09-15 from the vendors' own
// pages, not inferred:
//
//   gpt-5.6-sol     developers.openai.com/api/docs/models/gpt-5.6-sol
//                   "$4 per million input tokens", "$0.4 per million"
//                   cached, "billed at 1.25x the uncached input token rate"
//                   for writes ($5), "$20 per million output tokens".
//                   Context window 1,050,000 — which is what
//                   CODEX_CONTEXT_DEFAULTS already says, so the row and the
//                   page are about the same model.
//   gpt-5.6-cyber   .../models/gpt-5.6-cyber — same 1.25x sentence, on a
//                   $12.50 base: $15.625.
//   Opus 4.5        platform.claude.com/docs/en/build-with-claude/context-
//                   windows — the 1M list is Fable 5.1, Mythos 5.1, Fable 5,
//                   Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5,
//                   Sonnet 4.6, Mythos Preview. "Other Claude models,
//                   including Claude Sonnet 4.5, have a 200k-token context
//                   window." Opus 4.5 is one of the others.
//
// WHY EACH ONE SURVIVED. Sol's price was cut after this file's 2026-08-12
// sweep and nothing re-reads a rate sheet on a schedule. Opus 4.5 was written
// into the pattern as `(?:5|6|7|8)` when 4.5 was the newest Opus and the 1M
// window was assumed to arrive with it; it arrived one generation later.
// Neither is the kind of mistake a test that reads the table can catch, so
// these read the published numbers instead.
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

describe("gpt-5.6-sol, the default Codex model", () => {
  // The session from the report, priced end to end. At the old $5/$30 this
  // came to $8.00 — 37.9% over — and it is the whole reason the row matters:
  // sol is what a Codex session runs as unless somebody changed it.
  it("prices a real session at the published rate, not 38% over", () => {
    const c = costForUsage(
      usage({
        inputTokens: 2_000_000,
        cacheReadTokens: 1_500_000,
        cacheCreateTokens: 200_000,
        outputTokens: 150_000,
      }),
      "gpt-5.6-sol",
    );
    // 300,000 uncached x $4 + 1,500,000 x $0.40 + 200,000 x $5 + 150,000 x $20
    expect(c.input).toBeCloseTo(1.20, 6);
    expect(c.cacheRead).toBeCloseTo(0.60, 6);
    expect(c.cacheWrite).toBeCloseTo(1.00, 6);
    expect(c.output).toBeCloseTo(3.00, 6);
    expect(c.total).toBeCloseTo(5.80, 6);
  });

  it("charges a million output tokens $20, the figure on the model page", () => {
    expect(costForUsage(usage({ outputTokens: 1_000_000 }), "gpt-5.6-sol").output).toBeCloseTo(20, 6);
    // Bare `gpt-5.6` is documented in the row above as an alias for sol, so it
    // must not drift away from it.
    expect(costForUsage(usage({ outputTokens: 1_000_000 }), "gpt-5.6").output).toBeCloseTo(20, 6);
  });

  it("leaves its siblings where the same sweep found them correct", () => {
    expect(ratesForModel("gpt-5.6-terra")!.output).toBe(12);
    expect(ratesForModel("gpt-5.6-luna")!.output).toBe(1.20);
    expect(ratesForModel("gpt-5.6-cyber")!.output).toBe(75);
  });
});

describe("gpt-5.6-cyber's cache writes", () => {
  // A zero cacheWrite is not a missing price, it is a second behaviour:
  // billedInputTokens keys on the rate being non-zero, so a zero leaves the
  // written tokens on the input line AND renders the cache-write line as "-".
  it("bills a written token at 1.25x input instead of hiding it inside input", () => {
    const u = usage({ inputTokens: 1_000_000, cacheCreateTokens: 1_000_000 });
    expect(billedInputTokens(u, "gpt-5.6-cyber")).toBe(0);
    expect(costForUsage(u, "gpt-5.6-cyber").cacheWrite).toBeCloseTo(15.625, 6);
  });

  it("still leaves the older families at zero, where no rate is published", () => {
    // gpt-5.1-codex-max's page carries no cache-write line at all, so a zero
    // is the right answer there and this fix must not become a blanket rule.
    expect(ratesForModel("gpt-5.1-codex-max")?.cacheWrite ?? 0).toBe(0);
  });
});

describe("the 1M context window begins at Opus 4.6", () => {
  it("gives Opus 4.5 the 200K window the docs give it", () => {
    expect(contextWindowForModel("claude-opus-4-5")).toBe(200_000);
    expect(contextWindowForModel("claude-opus-4-5-20251101")).toBe(200_000);
  });

  it("keeps 1M for every model the docs actually list", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5-1",
      "claude-mythos-5",
    ]) {
      expect(contextWindowForModel(id), id).toBe(1_000_000);
    }
  });

  it("still honours an explicit [1m] suffix on a 200K model", () => {
    // The suffix is CC's own banner spelling and overrides the family rule, so
    // a 4.5 session actually granted the long window still draws correctly.
    expect(contextWindowForModel("claude-opus-4-5[1m]")).toBe(1_000_000);
  });
});
