// The context figure (context-figure.ts): "129k / 200k · 64%", whole thousands,
// a million as "1M". Owner answer 17; the Term header's chip and the
// Inspector's Context tab both say it.
import { describe, expect, it } from "vitest";
import { contextFigure, contextPercent, contextTokens } from "../context-figure";

describe("the context figure", () => {
  it("says the used part, the window and the percent", () => {
    expect(contextFigure(128_400, 200_000)).toBe("128k / 200k · 64%");
    expect(contextFigure(129_000, 200_000)).toBe("129k / 200k · 65%");
    expect(contextFigure(0, 200_000)).toBe("0 / 200k · 0%");
    expect(contextFigure(850, 200_000)).toBe("850 / 200k · 0%");
  });

  it("says the used part alone when no window is known", () => {
    expect(contextFigure(129_000)).toBe("129k");
    expect(contextFigure(129_000, 0)).toBe("129k");
    expect(contextFigure(129_000, undefined)).toBe("129k");
    expect(contextFigure(129_000, null)).toBe("129k");
    expect(contextFigure(0)).toBe("0");
  });

  it("keeps a number under a thousand as it is, and whole thousands up to the million", () => {
    expect(contextTokens(0)).toBe("0");
    expect(contextTokens(850)).toBe("850");
    expect(contextTokens(999)).toBe("999");
    expect(contextTokens(1_000)).toBe("1k");
    expect(contextTokens(1_499)).toBe("1k");
    expect(contextTokens(1_500)).toBe("2k");
    expect(contextTokens(61_400)).toBe("61k");
    expect(contextTokens(999_499)).toBe("999k");
  });

  it("says a million as 1M, and past it with at most one decimal and no trailing .0", () => {
    // 999,500 would round to "1000k"; it is a million.
    expect(contextTokens(999_500)).toBe("1M");
    expect(contextTokens(1_000_000)).toBe("1M");
    expect(contextTokens(1_040_000)).toBe("1M");
    expect(contextTokens(1_200_000)).toBe("1.2M");
    expect(contextTokens(1_250_000)).toBe("1.3M");
    expect(contextTokens(2_000_000)).toBe("2M");
  });

  it("rounds the percent to a whole number and holds it to 0..999", () => {
    expect(contextPercent(129_000, 200_000)).toBe(65);
    expect(contextPercent(1, 200_000)).toBe(0);
    expect(contextPercent(-5, 200_000)).toBe(0);
    expect(contextPercent(10_000_000, 200_000)).toBe(999);
    expect(contextPercent(100, 0)).toBe(0);
    expect(contextFigure(400_000, 200_000)).toBe("400k / 200k · 200%");
  });
});
