// A FAMILY PREFIX MAY ONLY PRICE THE IDS IT HAS READ A NUMBER FOR.
//
// pricing.ts states that rule at its o-series block and answers it there with
// rows — those siblings have published numbers, and refusing to price them
// would invent a gap. The two newest bare rows had neither: `\b` is satisfied
// by the `-` of any suffix, so gpt-5.6's row priced -pro, -mini and -nano at
// sol's rate, and gpt-5.5's priced -cyber and -mini at its own.
//
// The 5.4 generation is the measured precedent for how far that can be off:
// -nano is $0.20/$1.25 against -pro's $30/$180, a 150x spread under one prefix.
// So a gpt-5.6-pro at the pro tier would have reported roughly a sixth of the
// real spend, and a -nano many times too much — as a confident dollar figure,
// because falling through to a family row is indistinguishable from a match.
// `unrecognised-model-version.test.ts` pins version siblings (gpt-5.7, 5.10,
// 5.60, gpt-6) and no named one, which is why this survived.
import { describe, it, expect } from "vitest";
import { ratesForModel } from "../pricing";

describe("a named sibling nobody has read a rate for", () => {
  for (const id of ["gpt-5.6-pro", "gpt-5.6-mini", "gpt-5.6-nano", "gpt-5.5-cyber", "gpt-5.5-mini"]) {
    it(`${id} is not priced, rather than priced as its family`, () => {
      expect(ratesForModel(id), id).toBeNull();
    });
  }

  it("still prices the ids the rows were actually quoted for", () => {
    // The guard must not eat the family row's own job. The bare id and the
    // alias the row's comment names are both it.
    expect(ratesForModel("gpt-5.6")).toBeDefined();
    expect(ratesForModel("gpt-5.6-sol")).toBeDefined();
    expect(ratesForModel("gpt-5.6-sol")).toEqual(ratesForModel("gpt-5.6"));
    expect(ratesForModel("gpt-5.5")).toBeDefined();
  });

  it("leaves the named siblings that DO have rows alone", () => {
    // These sit above the family row and must still reach it first.
    expect(ratesForModel("gpt-5.6-cyber")!.output).toBe(75);
    expect(ratesForModel("gpt-5.6-luna")!.output).toBe(1.20);
    expect(ratesForModel("gpt-5.6-terra")!.output).toBe(12);
    expect(ratesForModel("gpt-5.5-pro")!.output).toBe(180);
  });

  it("leaves the generations whose sibling set is complete alone", () => {
    // 5.4 carries explicit -pro, -mini and -nano rows above it, so its bare row
    // is quoted for what reaches it. The guard is scoped to the two newest for
    // that reason, not applied to every family on principle.
    expect(ratesForModel("gpt-5.4")!.output).toBe(15);
    expect(ratesForModel("gpt-5.4-nano")!.output).toBe(1.25);
    expect(ratesForModel("gpt-5.4-pro")!.output).toBe(180);
  });

  it("keeps refusing the version siblings the older guard already refused", () => {
    // Belt and braces: `\b` does not match between 6 and 0, so gpt-5.60 never
    // reached the row and must not start to.
    expect(ratesForModel("gpt-5.60")).toBeNull();
    expect(ratesForModel("gpt-5.7")).toBeNull();
  });
});
