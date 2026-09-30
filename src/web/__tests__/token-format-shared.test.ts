// One token count, three formatters, two answers. App.tsx and UsagePanel.tsx
// each carried a byte-identical private `fmtTokens` that stopped at millions,
// and UsageHistoryModal.tsx carried `fmtN` — the same function plus a billions
// tier (#257). Below 1e9 all three agreed, which is why the split lasted; above
// it the usage panel printed "2300.00M" for a cache-read total the modal beside
// it printed as "2.30B".
//
// The four-tier copy won, so the only value that moves is one past a billion.
// This file pins both halves of that claim: the tier boundaries, and a sweep
// against the retired three-tier formula proving nothing below 1e9 changed but
// the rounding carries at the top of a tier, which #1807 hands to the next one. It also
// pins the two unrelated `fmtN` helpers that a blind rename would have eaten.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { usageSurface } from "./usage-surface";
import { usageHistorySurface } from "./usage-history-surface";
import { fmtTokens } from "../token-format";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** What App.tsx and UsagePanel.tsx rendered before this was shared. */
function threeTier(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

describe("the shared token formatter", () => {
  it("prints a count below a thousand as itself", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(7)).toBe("7");
    expect(fmtTokens(999)).toBe("999");
  });

  it("switches to thousands at exactly a thousand", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(87_400)).toBe("87.4k");
  });

  it("switches to millions at exactly a million", () => {
    expect(fmtTokens(1_000_000)).toBe("1.00M");
    expect(fmtTokens(1_234_567)).toBe("1.23M");
  });

  it("names a billion instead of printing four digits of millions", () => {
    // The whole of the divergence: these four read 1000.00M, 2300.00M,
    // 12000.00M and 1000000.00M in the usage panel and the toolbar chip.
    expect(fmtTokens(1_000_000_000)).toBe("1.00B");
    expect(fmtTokens(2_300_000_000)).toBe("2.30B");
    expect(fmtTokens(12_000_000_000)).toBe("12.00B");
    expect(fmtTokens(1_000_000_000_000)).toBe("1000.00B");
  });

  it("hands a count that rounds up to the next tier over to that tier (#1807)", () => {
    // All three copies shared a rounding carry at the top of each tier —
    // 999_950 printed "1000.0k" and 999_999_999 "1000.00M" — so unifying them
    // was never a choice between two renderings, and this case pinned it so a
    // change would be deliberate. #1807 is that change: each tier is judged on
    // the figure it prints, the way fmtCost's are, and passes a carry on.
    expect(fmtTokens(999_949)).toBe("999.9k");
    expect(fmtTokens(999_950)).toBe("1.00M");
    expect(fmtTokens(999_999)).toBe("1.00M");
    expect(fmtTokens(999_994_999)).toBe("999.99M");
    expect(fmtTokens(999_999_999)).toBe("1.00B");
  });

  it("renders nothing a browser's locale can move", () => {
    // Built from toFixed and an ASCII suffix, never toLocaleString: a host set
    // to de-DE would otherwise print "1.234.567" into a padded table cell and
    // take the column width with it.
    expect(fmtTokens.toString()).not.toMatch(/toLocaleString/);
    for (const n of [0, 999, 1000, 999_999, 1_000_000, 2_300_000_000, 1e12]) {
      expect(fmtTokens(n)).toMatch(/^\d+(\.\d+)?[kMB]?$/);
    }
  });

  it("prints a whole count for a fraction, in every tier", () => {
    // The panel's headline strip is animated, and a tween interpolates: the
    // frames between 389,700 and 112 include 594.3268260610639 and
    // 113.99999952241691. Every tier above 1000 was already fixed to one or two
    // decimals by `toFixed`, so only the bottom one leaked — and it leaked the
    // whole float, which is what a reader saw for a fifth of a second every
    // time they moved from `month` to `today`.
    //
    // The sweep above could not catch it: its shape `^\d+(\.\d+)?[kMB]?$`
    // ADMITS "594.3268260610639", and it was only ever handed integers anyway.
    // This one is quantified over the fractions the count actually produces.
    expect(fmtTokens(594.3268260610639)).toBe("594");
    expect(fmtTokens(113.99999952241691)).toBe("114");
    expect(fmtTokens(0.4)).toBe("0");
    expect(fmtTokens(0.6)).toBe("1");
    // Rounded before the tiers, not inside the bottom one: 999.6 is a thousand
    // tokens and reads as one, rather than falling out of the tier as "1000".
    expect(fmtTokens(999.6)).toBe("1.0k");
    expect(fmtTokens(999.4)).toBe("999");
    for (const n of [12.5, 594.3268260610639, 1234.5678, 1_234_567.89, 2_300_000_000.5]) {
      expect(fmtTokens(n), `${n} printed a fraction`).toMatch(/^-?\d+(\.\d{1,2})?[kMB]?$/);
      // No tier may print more decimals than its own toFixed allows, which is
      // the property the sweep above was reaching for and did not state.
      const decimals = /\.(\d+)/.exec(fmtTokens(n))?.[1].length ?? 0;
      expect(decimals, `${n} printed ${decimals} decimals`).toBeLessThanOrEqual(2);
    }
  });

  it("hands back a count that is not a real number rather than dressing it up", () => {
    // No caller can produce these, and every copy rendered them this way. A
    // guard would turn a broken count into a plausible-looking one.
    expect(fmtTokens(-1)).toBe("-1");
    expect(fmtTokens(-1_000_000)).toBe("-1000000");
    expect(fmtTokens(-Infinity)).toBe("-Infinity");
    expect(fmtTokens(NaN)).toBe("NaNB");
    expect(fmtTokens(Infinity)).toBe("InfinityB");
  });

  it("agrees with the retired three-tier copies everywhere below a billion but the carries", () => {
    // Collected rather than asserted per step: an expect() per iteration would
    // dominate the suite's runtime, and the list names every value that moved.
    // The only ones are the carries #1807 hands to the next tier, which the
    // old copies printed with four digits before the point.
    const moved: Array<{ n: number; was: string; now: string }> = [];
    const check = (n: number) => {
      const now = fmtTokens(n), was = threeTier(n);
      if (now !== was) moved.push({ n, was, now });
    };
    for (let n = 0; n <= 3000; n++) check(n);
    for (let n = 0; n < 1_000_000_000; n += 9973) check(n);
    for (const n of [999, 1000, 1001, 999_999, 1_000_000, 1_000_001, 999_999_998, 999_999_999]) check(n);
    expect(moved).toEqual([
      { n: 999_999, was: "1000.0k", now: "1.00M" },
      { n: 999_999_998, was: "1000.00M", now: "1.00B" },
      { n: 999_999_999, was: "1000.00M", now: "1.00B" },
    ]);
  });
});

describe("the panels that show abbreviated token counts", () => {
  const app = src("../App.tsx");
  const panel = src("../components/UsagePanel.tsx");
  const modal = src("../components/UsageHistoryModal.tsx");

  it("take their counts from the shared formatter", () => {
    // Three surfaces, until the topbar's board-token chip was dropped. App.tsx
    // is still checked below — it must not grow a formatter of its own — but it
    // no longer ABBREVIATES anything: the only token figures left in it are the
    // detail panel's four, and those print exact counts through
    // `toLocaleString()` because a panel with room for the digits should show
    // the digits. An import assertion on a file with nothing to format would be
    // pinning a dependency rather than a behaviour.
    expect(panel).toMatch(/import \{ fmtTokens \} from "\.\.\/token-format";/);
    expect(modal).toMatch(/import \{ fmtTokens \} from "\.\.\/token-format";/);
    // Conditional rather than a flat ban, because the point is the SOURCE of
    // the abbreviation and not whether App.tsx ever abbreviates again: a token
    // count coming back to the topbar is a product decision, and a second
    // rounding rule for it is the defect this file is about.
    if (/\bfmtTokens\s*\(/.test(app)) {
      expect(app, "App.tsx abbreviates without the shared formatter")
        .toMatch(/import \{[^}]*\bfmtTokens\b[^}]*\} from "\.\/token-format";/);
    }
  });

  it("declare no second token formatter of their own", () => {
    // The usage panel as a whole: the component and every file lifted out of it.
    // The usage panel and the history modal each with every file lifted out of it.
    for (const file of [app, usageSurface(), usageHistorySurface()]) {
      expect(file).not.toMatch(/function fmtTokens\b/);
      expect(file).not.toMatch(/function fmtN\b/);
    }
  });
});

describe("the two unrelated fmtN helpers", () => {
  it("keep formatting their own tooltip and context rows", () => {
    // Same name, different job: these group digits for a monospaced table and
    // have no tiers at all, so folding them in would have changed real output.
    // The card's is its cost tooltip's, which moved to card-cost.ts.
    expect(src("../card-cost.ts")).toMatch(/const fmtN = \(n: number\) => n\.toLocaleString\(\);/);
    expect(src("../components/ContextModal.tsx")).toMatch(/function fmtN\(n: number\): string \{ return n\.toLocaleString\(\); \}/);
  });
});
