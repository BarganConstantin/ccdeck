// #1773. The Projects report says its dollars come from ccusage, and on a day
// with 1-hour cache writes it printed more than ccusage did for the same tokens.
//
// ccusage's `modelBreakdowns` carry one flat `cacheCreationTokens` and no TTL
// split, so the drift reconcile() takes from a cell — ccusage's cost over
// pricing.ts's price of ccusage's tokens — was computed with every write at the
// 5-minute rate. Our own counters DO carry the split (the server reads
// `ephemeral_1h_input_tokens` off each transcript line), and they were priced
// with it: the 1-hour premium went in once through pricing.ts and again
// through the drift. ccusage 20.0.26 bills the day below at $19.10 (measured:
// a transcript with these tokens, the writes marked 1-hour, run through its
// `daily --json`; unmarked, the same tokens bill at $16.85), and the report
// showed $21.65 — 1.1335× for this mix, growing with the cache-write share.
//
// Every case asserts against ccusage's own figure for the day, at both of the
// rates ccusage has been seen to bill, because the promise in the header is
// that a day the deck tracked in full reads what ccusage reads — whichever
// rate ccusage applied.
import { describe, expect, it } from "vitest";
import { ccCellsFrom, reconcile, type Counters, type DayInput } from "../account-projects-reconcile";
import { costForUsage } from "../pricing";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const MODEL = "claude-opus-4-5-20251101";
const DAY = "2026-09-22";

/** One day's tokens, every write a 1-hour one — as a CC transcript has them. */
const COUNTERS: Counters = { i: 20_000, o: 400_000, cr: 6_000_000, cc: 600_000, c1h: 600_000, c5m: 0 };
const FLAT = { inputTokens: 20_000, outputTokens: 400_000, cacheReadTokens: 6_000_000, cacheCreateTokens: 600_000, cacheCreate1hTokens: 0, cacheCreate5mTokens: 0 };
const SPLIT_1H = { ...FLAT, cacheCreate1hTokens: 600_000 };

/** ccusage's range body for that day at `cost`, in the shape it prints. */
const cellsAt = (cost: number) => ccCellsFrom({
  days: [{
    period: DAY,
    modelBreakdowns: [{
      modelName: MODEL, cost,
      inputTokens: 20_000, outputTokens: 400_000, cacheReadTokens: 6_000_000, cacheCreationTokens: 600_000,
    }],
  }],
});

const daily: DayInput[] = [{ day: DAY, projects: [{ path: "/u/p", models: { [MODEL]: COUNTERS } }], unattributed: null }];

const RATES = [
  { name: "the 1-hour rate, which ccusage 20.0.26 bills", usd: costForUsage(SPLIT_1H, MODEL, NOW).total },
  { name: "the 5-minute rate, which a ccusage without the split bills", usd: costForUsage(FLAT, MODEL, NOW).total },
];

describe("a day the deck tracked in full costs what ccusage says it cost (#1773)", () => {
  it("prices the two rates the way ccusage printed them", () => {
    // The measurement the file header quotes, so a rate-table change that
    // moves these is seen here first rather than as a puzzling drift below.
    expect(RATES[0].usd).toBeCloseTo(19.10, 6);
    expect(RATES[1].usd).toBeCloseTo(16.85, 6);
  });

  for (const { name, usd } of RATES) {
    it(`matches ccusage at ${name}: project, day and window`, () => {
      const rec = reconcile(daily, null, cellsAt(usd), NOW);
      expect(rec.calibrated).toBe(true);
      expect(rec.totalCost).toBeCloseTo(usd, 6);
      expect(rec.perDay[0].total).toBeCloseTo(usd, 6);
      expect(rec.projects[0].cost).toBeCloseTo(usd, 6);
    });

    it(`prices Unattributed at ccusage's rate too, at ${name}`, () => {
      const rec = reconcile([], { [MODEL]: COUNTERS }, cellsAt(usd), NOW);
      expect(rec.unattributed?.cost).toBeCloseTo(usd, 6);
    });
  }

  it("keeps the 1-hour rate where ccusage has not answered, since nothing calibrates it then", () => {
    const rec = reconcile(daily, { [MODEL]: COUNTERS }, new Map(), NOW);
    expect(rec.calibrated).toBe(false);
    expect(rec.totalCost).toBeCloseTo(RATES[0].usd, 6);
    expect(rec.unattributed?.cost).toBeCloseTo(RATES[0].usd, 6);
  });

  it("keeps the 1-hour rate on a day ccusage has no cell for, beside one it has", () => {
    // A calibrated window is not a calibrated day: the other day's tokens meet
    // no ccusage figure, so pricing.ts's own split stands for them.
    const two: DayInput[] = [
      ...daily,
      { day: "2026-09-21", projects: [{ path: "/u/p", models: { [MODEL]: COUNTERS } }], unattributed: null },
    ];
    const rec = reconcile(two, null, cellsAt(RATES[0].usd), NOW);
    const other = rec.perDay.find(d => d.day === "2026-09-21")!;
    expect(other.total).toBeCloseTo(RATES[0].usd, 6);
    expect(rec.totalCost).toBeCloseTo(2 * RATES[0].usd, 6);
  });
});
