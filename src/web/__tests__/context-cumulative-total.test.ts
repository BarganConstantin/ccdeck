// "CUMULATIVE TOTAL" IS PRINTED UNDER FOUR ROWS AND TOTALLED THREE OF THEM.
//
// ContextModal renders input / output / cache reads / cache writes and then a
// line labelled "cumulative total". It read `input + cacheRead + cacheCreate`:
// output — one of the rows immediately above it — was left out.
//
// And for a Codex session the three it did add overlap. pricing.ts and
// codex-usage.mjs both record the measured fact that OpenAI's `input_tokens`
// already CONTAINS `cached_input_tokens` and `cache_write_input_tokens`, and
// the reducer stores `total_token_usage` verbatim — so the sum double-counted
// the cached prefix, on the one panel whose job is saying what is in the
// window.
import { describe, it, expect } from "vitest";


/** The rule the component now applies, stated once so the arithmetic below is
 *  about the rule rather than about JSX. Kept in step with ContextModal by the
 *  source assertion at the bottom. */
const cumulativeFor = (
  provider: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
) => (provider === "codex"
  ? u.inputTokens + u.outputTokens
  : u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreateTokens);

describe("the cumulative total under the four rows", () => {
  it("totals the four rows for a Claude session", () => {
    const u = { inputTokens: 200_000, outputTokens: 10_000, cacheReadTokens: 80_000, cacheCreateTokens: 10_000 };
    // Anthropic reports the caches disjoint from input, so all four add.
    expect(cumulativeFor("claude", u)).toBe(300_000);
    // The old rule dropped output and read 290,000 under rows summing to 300,000.
    expect(cumulativeFor("claude", u)).not.toBe(
      u.inputTokens + u.cacheReadTokens + u.cacheCreateTokens);
  });

  it("does not double-count a Codex session's cached prefix", () => {
    // input_tokens already contains both cache figures, so the honest total is
    // input + output — which is `total_tokens`.
    const u = { inputTokens: 300_000, outputTokens: 10_000, cacheReadTokens: 280_000, cacheCreateTokens: 0 };
    expect(cumulativeFor("codex", u)).toBe(310_000);
    // The old rule read 580,000 — nearly double.
    expect(u.inputTokens + u.cacheReadTokens + u.cacheCreateTokens).toBe(580_000);
  });

  it("splits on the provider, which is the fact this line needs", () => {
    // Which CLI reported the numbers, not which model produced them — and
    // isCodexModel is deliberately off pricing.ts's public surface (#383).
    const u = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheCreateTokens: 0 };
    expect(cumulativeFor("codex", u)).toBe(110);
    expect(cumulativeFor("claude", u)).toBe(150);
  });

  it("is the rule the component actually runs", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../components/ContextModal.tsx", import.meta.url)), "utf8");
    expect(src).toContain('const cumulative = agent.provider === "codex"');
    expect(src).toContain("? usage.inputTokens + usage.outputTokens");
    // And the form that dropped output must not come back.
    expect(src).not.toContain(
      "const cumulative = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;");
  });
});
