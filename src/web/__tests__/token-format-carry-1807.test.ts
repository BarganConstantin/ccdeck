// #1807: a token count just below a tier boundary printed four digits.
//
// fmtTokens picked its tier on the whole count and then rounded inside it, so
// 999,950 tokens — under a million — went to the k tier and `toFixed(1)` carried
// it to "1000.0k"; 999,995,000 did the same one tier up as "1000.00M". Every
// other figure in those columns has at most three digits before the point, and
// fmtCost already hands a rounded figure that reaches the next tier to that
// tier (#1173). This holds fmtTokens to the same rule, at and around each edge.
import { describe, it, expect } from "vitest";
import { fmtTokens } from "../token-format";
import { fmtCost } from "../pricing";

describe("fmtTokens at the top of each tier (#1807)", () => {
  it.each([
    // the k → M edge
    [999_000, "999.0k"],
    [999_949, "999.9k"],
    [999_950, "1.00M"],
    [999_951, "1.00M"],
    [999_999, "1.00M"],
    [1_000_000, "1.00M"],
    [1_004_999, "1.00M"],
    [1_005_000, "1.00M"],
    // the M → B edge
    [999_990_000, "999.99M"],
    [999_994_999, "999.99M"],
    [999_995_000, "1.00B"],
    [999_999_999, "1.00B"],
    [1_000_000_000, "1.00B"],
    // the bottom edge, which rounding already handed up (unchanged)
    [999, "999"],
    [999.4, "999"],
    [999.6, "1.0k"],
    [1000, "1.0k"],
  ])("%d reads %s", (n, text) => {
    expect(fmtTokens(n)).toBe(text);
  });

  it("never prints four digits before the point on either side of a carry", () => {
    // Every count either side of both carry windows, collected and asserted
    // whole so the list names each input that broke the rule.
    const wide: string[] = [];
    const judge = (n: number) => {
      const out = fmtTokens(n);
      if (/^\d{4,}\./.test(out)) wide.push(`fmtTokens(${n}) = ${out}`);
    };
    for (let n = 999_900; n <= 1_000_100; n++) judge(n);
    for (let n = 999_990_000; n <= 1_000_010_000; n += 7) judge(n);
    judge(999_999_999);
    expect(wide).toEqual([]);
  });

  it("carries on the rounded figure, the way fmtCost does", () => {
    // Both formatters judge the string they print rather than the raw value,
    // so a figure that rounds into the next tier is printed by that tier.
    expect(fmtCost(99.995)).toBe("$100");
    expect(fmtTokens(999_950)).toBe(fmtTokens(1_000_000));
    expect(fmtTokens(999_995_000)).toBe(fmtTokens(1_000_000_000));
  });
});
