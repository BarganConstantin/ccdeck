// #1330. The Projects report printed $11.19 for a day on which one project had
// 326M tokens, 282M of them on Claude Opus 5.5. pricing.ts had no row for Opus
// 5.5 — Opus 5's version guard refuses it, as #688 means it to — so
// costForUsage answered that bucket with zeros, the reconciliation added the
// zeros up like any other price, and the modal printed the Sonnet remainder as
// the whole cost with nothing on screen to say most of it was missing.
//
// Two fixes, pinned here in that order.
//
// THE RATE. Read 2026-09-28 from platform.claude.com/docs/en/about-claude/
// pricing: "Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok |
// $20 / MTok" (base input, 5-minute writes, 1-hour writes, cache hits, output),
// and "Cache hits and refreshes on Claude Opus 5.5 are priced at 0.05x the base
// input price." LiteLLM's `claude-opus-5-5` entry — the catalog ccusage prices
// from — carries the same five numbers. Pinned with arithmetic on the issue's
// own bucket, and against ccusage's own cost for two days of this machine's
// Opus 5.5 work, rather than by reading the row back: a table proved against
// itself proves nothing (rate-sheet-2026-09 makes the same argument).
//
// THE HOLE. The rate closes this model and not the next one. A Claude id this
// build has never heard of still reaches no row, correctly, and the report must
// then say its total is a floor instead of presenting what it could price as
// what was spent. So the shape of the issue is rebuilt below with an id nobody
// has priced, and the report is held to the `+` and `not priced` every other
// money surface in the deck already prints for it (#400).
import { describe, it, expect } from "vitest";
import {
  ccCellsFrom, projectCostLabel, reconcile, toUsage, unpricedNote, unpricedTitle,
  type CcCell, type Counters, type DayInput,
} from "../account-projects-reconcile";
import { costForUsage, fmtCost, ratesForModel, UNPRICED_LABEL } from "../pricing";
import { sourceOf } from "./client-source";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const DAY = "2026-09-28";
const PATH = "/home/u/vcrm-core";
const SONNET = "claude-sonnet-5";
const OPUS_5_5 = "claude-opus-5-5";
/** An id in the shape a next release would carry, which no row prices. */
const NEXT = "claude-opus-5-6";

const c = (i: number, o: number, cr = 0, cc = 0): Counters => ({ i, o, cr, cc, c1h: 0, c5m: 0 });
const tokens = (x: Counters) => x.i + x.o + x.cr + x.cc;
const price = (x: Counters, m: string) => costForUsage(toUsage(x), m, NOW).total;

/** The issue's Opus 5.5 bucket for slot 8 / vcrm-core, as it printed them. */
const ISSUE_OPUS: Counters = c(1_456, 698_596, 277_656_599, 3_462_650);
/** A Sonnet bucket sized to the rest of the issue's day: $11.19 and 44.3M
 *  tokens, which with the bucket above is the report's 326.12M. */
const ISSUE_SONNET: Counters = c(1_000, 120_000, 43_680_000, 500_000);

/** One project, one day, the two models the issue had. */
const issueDay = (big: string): DayInput[] => [{
  day: DAY,
  projects: [{ path: PATH, models: { [SONNET]: ISSUE_SONNET, [big]: ISSUE_OPUS } }],
  unattributed: null,
}];

/** One project, one day, one model. */
const oneModel = (model: string, x: Counters): DayInput[] =>
  [{ day: DAY, projects: [{ path: PATH, models: { [model]: x } }], unattributed: null }];

/** ccusage saw exactly our tokens for DAY and model, and priced them at `cost`. */
const ccExact = (model: string, x: Counters, cost: number): [string, CcCell] =>
  [`${DAY}|${model}`, { cost, usage: toUsage(x) }];

describe("Opus 5.5 is priced at the published rate", () => {
  it("has the five numbers on Anthropic's sheet", () => {
    expect(ratesForModel(OPUS_5_5, NOW)).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
  });

  it("prices the issue's bucket to the cent", () => {
    const b = costForUsage(toUsage(ISSUE_OPUS), OPUS_5_5, NOW);
    // 1,456 x $4 + 698,596 x $20 + 277,656,599 x $0.20 + 3,462,650 x $5 (no TTL
    // split on the issue's figures, so every write is billed at 5 minutes).
    expect(b.input).toBeCloseTo(0.005824, 9);
    expect(b.output).toBeCloseTo(13.97192, 9);
    expect(b.cacheRead).toBeCloseTo(55.5313198, 9);
    expect(b.cacheWrite).toBeCloseTo(17.31325, 9);
    expect(b.total).toBeCloseTo(86.8223138, 7);
  });

  it("bills a 1-hour write at $8 and a hit at 0.05x input", () => {
    const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreateTokens: 1_000_000, cacheCreate1hTokens: 1_000_000, cacheCreate5mTokens: 0 };
    const b = costForUsage(u, OPUS_5_5, NOW);
    expect(b.cacheWrite).toBeCloseTo(8, 9);
    expect(b.cacheRead).toBeCloseTo(4 * 0.05, 9);
  });

  it("is not Opus 5's price, which would be about twice the bill here", () => {
    expect(price(ISSUE_OPUS, "claude-opus-5") / price(ISSUE_OPUS, OPUS_5_5)).toBeGreaterThan(2);
  });

  // ccusage 20.0.24's `daily --json` on this machine, pricing from LiteLLM.
  // Its breakdowns carry no TTL split, so pricing.ts can only bracket them:
  // every write at the 5-minute rate below, every write at the 1-hour rate
  // above. A wrong rate lands outside — Opus 5's is over ccusage's figure
  // before a single write is counted.
  const CCUSAGE_DAYS: Array<{ day: string; u: Counters; cost: number }> = [
    { day: "2026-09-27", u: c(1_236, 881_039, 112_099_488, 4_323_497), cost: 68.26944559999993 },
    { day: "2026-09-28", u: c(4_148, 1_766_832, 653_795_718, 6_226_809), cost: 203.9018846000003 },
  ];
  for (const { day, u, cost } of CCUSAGE_DAYS) {
    it(`agrees with ccusage's own cost for ${day}`, () => {
      const at5m = price(u, OPUS_5_5);
      const at1h = costForUsage({ ...toUsage(u), cacheCreate1hTokens: u.cc, cacheCreate5mTokens: 0 }, OPUS_5_5, NOW).total;
      expect(cost).toBeGreaterThan(at5m);
      expect(cost).toBeLessThan(at1h);
      const opus5WithoutWrites = costForUsage({ ...toUsage(u), cacheCreateTokens: 0 }, "claude-opus-5", NOW).total;
      expect(opus5WithoutWrites).toBeGreaterThan(cost);
    });
  }
});

describe("the issue's day, priced", () => {
  it("counts Opus 5.5 in the total instead of printing the Sonnet part as all of it", () => {
    const r = reconcile(issueDay(OPUS_5_5), null, new Map(), NOW);
    const sonnet = price(ISSUE_SONNET, SONNET);
    expect(sonnet).toBeCloseTo(11.188, 6);                        // the $11.19 on screen
    expect(r.totalCost).toBeCloseTo(sonnet + 86.8223138, 6);       // was 11.188
    expect(r.projects[0].cost).toBeCloseTo(r.totalCost, 9);
    expect(r.perDay[0].total).toBeCloseTo(r.totalCost, 9);
    expect(r.unpricedTokens).toBe(0);
    expect(projectCostLabel(r.totalCost, r.unpricedTokens)).toBe("$98.01");
  });

  it("takes ccusage's calibration for Opus 5.5 like any priced model", () => {
    const opus = price(ISSUE_OPUS, OPUS_5_5);
    const sonnet = price(ISSUE_SONNET, SONNET);
    const cc = new Map<string, CcCell>([
      ccExact(OPUS_5_5, ISSUE_OPUS, opus * 1.1),
      ccExact(SONNET, ISSUE_SONNET, sonnet),
    ]);
    const r = reconcile(issueDay(OPUS_5_5), null, cc, NOW);
    expect(r.totalCost).toBeCloseTo(opus * 1.1 + sonnet, 6);
    expect(r.calibrated).toBe(true);
    expect(r.reconciled).toBe(true);
  });
});

describe("a model with no rate is never summed as $0 (#1330)", () => {
  // The issue's shape exactly: one priced Sonnet bucket, and a model this build
  // cannot price carrying nearly nine tokens in ten.
  const cc = new Map<string, CcCell>([
    ccExact(SONNET, ISSUE_SONNET, price(ISSUE_SONNET, SONNET)),
    // ccusage CAN price the new model — LiteLLM has it first — and its dollars
    // must still not be passed off as a price for our tokens.
    ccExact(NEXT, ISSUE_OPUS, 95.8173),
  ]);
  const r = reconcile(issueDay(NEXT), null, cc, NOW);

  it("reaches no row, which is the premise", () => {
    expect(ratesForModel(NEXT, NOW)).toBeNull();
  });

  it("keeps every token, priced or not", () => {
    expect(r.totalTokens).toBe(tokens(ISSUE_SONNET) + tokens(ISSUE_OPUS));
    expect(r.totalTokens).toBe(326_120_301);
    expect(r.projects[0].tokens).toBe(r.totalTokens);
  });

  it("carries the unpriced tokens on the project, the day and the window", () => {
    expect(r.unpricedTokens).toBe(tokens(ISSUE_OPUS));
    expect(r.projects[0].unpricedTokens).toBe(tokens(ISSUE_OPUS));
    expect(r.perDay[0].unpricedByPath.get(PATH)).toBe(tokens(ISSUE_OPUS));
    expect(r.unpricedModels).toEqual([NEXT]);
  });

  it("prints the priced part as a floor, never as the whole", () => {
    expect(r.totalCost).toBeCloseTo(11.188, 6);
    expect(projectCostLabel(r.totalCost, r.unpricedTokens)).toBe("$11.19+");
    expect(projectCostLabel(r.projects[0].cost, r.projects[0].unpricedTokens)).toBe("$11.19+");
    expect(unpricedTitle(r.unpricedTokens)).toBe("281.82M of these tokens are on an unpriced model, so this is a floor");
  });

  it("does not call a total with a hole in it reconciled", () => {
    expect(r.calibrated).toBe(true);
    expect(r.reconciled).toBe(false);
  });

  it("does not borrow ccusage's dollars for the model either", () => {
    // $95.82 is ccusage's whole day for the model. Spreading it over our tokens
    // is a guess, and the report's rule is a floor that says so, not a guess.
    expect(r.totalCost).toBeLessThan(12);
  });

  it("says not priced, not $0 or a dash, for a project that is all unpriced", () => {
    const only = reconcile(oneModel(NEXT, ISSUE_OPUS), null, new Map(), NOW);
    expect(only.projects[0].cost).toBe(0);
    expect(projectCostLabel(only.projects[0].cost, only.projects[0].unpricedTokens)).toBe(UNPRICED_LABEL);
    expect(projectCostLabel(only.totalCost, only.unpricedTokens)).toBe(UNPRICED_LABEL);
    expect(fmtCost(only.totalCost)).toBe("—");   // what it printed before: "nothing was spent"
  });

  it("marks Unattributed the same way", () => {
    const withUn = reconcile(issueDay(SONNET), { [SONNET]: ISSUE_SONNET, [NEXT]: c(0, 10_000, 1_000_000) }, new Map(), NOW);
    expect(withUn.unattributed!.tokens).toBe(tokens(ISSUE_SONNET) + 1_010_000);
    expect(withUn.unattributed!.unpricedTokens).toBe(1_010_000);
    expect(projectCostLabel(withUn.unattributed!.cost, withUn.unattributed!.unpricedTokens)).toBe("$11.19+");
    // Excluded from the project totals, so it does not make them floors.
    expect(withUn.unpricedTokens).toBe(0);
    expect(withUn.unpricedModels).toEqual([NEXT]);
  });

  it("leaves a whole total alone", () => {
    expect(projectCostLabel(11.188, 0)).toBe("$11.19");
    expect(unpricedTitle(0)).toBeUndefined();
    expect(unpricedNote([])).toBeNull();
  });

  it("names what is missing in one sentence", () => {
    expect(unpricedNote([NEXT])).toBe(
      "claude-opus-5-6 is not priced: this build holds no published rate for it, so its tokens are counted and its dollars are not.");
    expect(unpricedNote(["claude-a", "claude-b", "claude-c"])).toMatch(/^claude-a, claude-b and claude-c are not priced: .* for them, so their tokens/);
  });
});

describe("a future Claude model cannot hide inside a confident total", () => {
  // Each a plausible next id in a family the table knows, and each refused by
  // #688's guard. Whatever ships next, until somebody reads its price, the
  // report must print a floor — whichever of these it turns out to be.
  for (const id of ["claude-opus-5-6", "claude-opus-6", "claude-sonnet-5-1", "claude-sonnet-6", "claude-haiku-5", "claude-fable-5-2", "us.anthropic.claude-opus-6"]) {
    it(`${id} makes the total a floor`, () => {
      const r = reconcile(issueDay(id), null, new Map(), NOW);
      expect(ratesForModel(id, NOW), id).toBeNull();
      expect(r.unpricedTokens).toBe(tokens(ISSUE_OPUS));
      expect(projectCostLabel(r.totalCost, r.unpricedTokens)).toMatch(/\+$/);
      expect(r.unpricedModels).toEqual([id]);
    });
  }
});

describe("ccusage stays the authority where it has a price", () => {
  it("still calibrates a fully priced day to ccusage's cost", () => {
    const sonnet = price(ISSUE_SONNET, SONNET);
    const r = reconcile(oneModel(SONNET, ISSUE_SONNET), null, new Map([ccExact(SONNET, ISSUE_SONNET, sonnet * 1.25)]), NOW);
    expect(r.totalCost).toBeCloseTo(sonnet * 1.25, 9);
    expect(r.reconciled).toBe(true);
    expect(r.unpricedTokens).toBe(0);
  });

  it("does not calibrate our tokens to $0 when ccusage could not price the model", () => {
    // What ccusage answers when its LiteLLM fetch fails and its embedded
    // catalog lacks the model: the tokens, `missingPricing`, and a cost of 0.
    // Read as a calibration that is a drift of zero, and a priced bucket
    // printed as nothing.
    const body = {
      ok: true,
      days: [{
        period: DAY,
        modelBreakdowns: [
          { modelName: OPUS_5_5, inputTokens: ISSUE_OPUS.i, outputTokens: ISSUE_OPUS.o, cacheReadTokens: ISSUE_OPUS.cr, cacheCreationTokens: ISSUE_OPUS.cc, cost: 0, missingPricing: true },
        ],
      }],
    };
    const cells = ccCellsFrom(body);
    expect(cells.size).toBe(0);
    const r = reconcile(oneModel(OPUS_5_5, ISSUE_OPUS), null, cells, NOW);
    expect(r.totalCost).toBeCloseTo(86.8223138, 6);
    expect(r.calibrated).toBe(false);
  });

  it("treats a zero-cost cell from an older ccusage the same way", () => {
    // A ccusage that predates `missingPricing` still answers 0 for a model it
    // cannot price, and no Claude token is free.
    const cc = new Map<string, CcCell>([ccExact("claude-opus-5", ISSUE_OPUS, 0)]);
    const r = reconcile(oneModel("claude-opus-5", ISSUE_OPUS), null, cc, NOW);
    expect(r.totalCost).toBeCloseTo(price(ISSUE_OPUS, "claude-opus-5"), 6);
  });

  it("does not let a cost it cannot match inflate Unattributed's drift", () => {
    // ccusage's $95.82 for a model pricing.ts has no row for used to enter the
    // window drift's numerator with nothing in its denominator.
    const un = { [SONNET]: c(1_000, 20_000, 900_000, 90_000) };
    const sonnetCell = ccExact(SONNET, ISSUE_SONNET, price(ISSUE_SONNET, SONNET));
    const plain = reconcile(issueDay(SONNET), un, new Map([sonnetCell]), NOW);
    const withNext = reconcile(issueDay(SONNET), un, new Map([sonnetCell, ccExact(NEXT, ISSUE_OPUS, 95.8173)]), NOW);
    expect(withNext.unattributed!.cost).toBeCloseTo(plain.unattributed!.cost, 9);
    expect(withNext.unattributed!.cost).toBeCloseTo(price(un[SONNET], SONNET), 9);
  });
});

describe("the modal prints the floor wherever it prints a cost", () => {
  const src = sourceOf("components/AccountProjectsModal.tsx");

  it("labels the total, the rows, Other's members, Unattributed and the days", () => {
    expect(src).toContain("{projectCostLabel(view.totalCost, view.unpricedTokens)}");
    expect(src).toContain("{projectCostLabel(r.cost, r.unpricedTokens)}");
    expect(src).toContain("{projectCostLabel(member.cost, member.unpricedTokens)}");
    expect(src).toContain("{projectCostLabel(view.un.cost, view.un.unpricedTokens, fmtCostGrouped)}");
    expect(src).toContain("{projectCostLabel(d.total, d.unpriced)}");
    expect(src).toContain("{projectCostLabel(c, u)}");
    expect(src).toContain("{view.unpricedNote && <div className=\"ap-proj-note\">{view.unpricedNote}</div>}");
  });

  it("prints no cost cell through a bare formatter any more", () => {
    // A bare fmtCost in a cell is the $11.19-as-everything this issue is
    // about: it cannot know the figure is a floor.
    expect(src).not.toMatch(/>\{fmtCost\([^)]*\)\}</);
    expect(src).not.toMatch(/>\{fmtCostGrouped\([^)]*\)\}</);
  });

  it("shares by tokens when the dollars have a hole", () => {
    expect(src).toContain('const basis = totalCost > 0 && rec.unpricedTokens === 0 ? "cost" : "tokens";');
  });

  it("says the dollars cover the priced models, not that they are ccusage's in full", () => {
    expect(src).toMatch(/: view\.reconciled \? "Dollars from ccusage · split by activity"\s*: view\.calibrated \? "Dollars from ccusage for the priced models · split by activity"/);
  });
});
