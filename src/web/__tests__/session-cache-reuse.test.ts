import { describe, expect, it } from "vitest";
// @ts-expect-error — server ES module
import { sessionCacheReuse, sessionDetail } from "../../server/ccusage-session.mjs";
const row = { inputTokens: 20, cacheReadTokens: 60, cacheCreationTokens: 20, outputTokens: 10000, reasoningOutputTokens: 500 };
describe("ccusage normalized cached input reuse", () => {
  it.each(["claude", "codex"])("includes cache creation in input and excludes output for %s", agent => {
    expect(sessionCacheReuse([row], agent)).toMatchObject({ pct: 60, inputTokens: 100, cachedTokens: 60, measured: 1, total: 1 });
  });
  it("distinguishes a measured zero, missing counters and no input", () => {
    expect(sessionCacheReuse([{ ...row, cacheReadTokens: 0 }], "claude").pct).toBe(0);
    expect(sessionCacheReuse([{ inputTokens: 20 }], "claude")).toMatchObject({ pct: null, measured: 0 });
    expect(sessionCacheReuse([{ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }], "claude")).toMatchObject({ pct: null, measured: 1 });
  });
  it("weights measured records and reports incomplete coverage instead of converting missing to zero", () => {
    const rows = [row, { inputTokens: 10 }, { ...row, inputTokens: NaN }, { ...row, cacheReadTokens: -1 }];
    expect(sessionCacheReuse(rows, "claude")).toMatchObject({ pct: 60, measured: 1, total: 4 });
    const detail = sessionDetail({ sessionId: "test-session", totalTokens: 200, totalCost: 1, entries: rows }, "claude", "test-session");
    expect(detail.cacheReuse).toMatchObject({ pct: 60, measured: 1, total: 4 });
  });
});
