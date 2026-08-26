// #690: an o-series sibling with no row of its own inherits the family row's
// price, and the family row is a different model at a different rate.
//
// `/^o1\b/i` finds a word boundary between the `1` and the `-` of `o1-mini` and
// hands it o1's $15/$60 — thirteen times the $1.10/$4.40 o1-mini is billed at.
// `/^o3\b/i` read `o3-deep-research` the same way and quoted $2/$8 against a
// published $10/$40, a fifth of the real spend. Sweeping the rest of the family
// for the same shape turned up a third the issue had not: `/^o4[-_]mini/i` is a
// bare prefix and needed no boundary at all to swallow `o4-mini-deep-research`,
// which is $2/$8 and not o4-mini's $1.10/$4.40.
//
// THE SAME BUG AS #688 WITH THE OPPOSITE ANSWER, which is why this file exists
// beside unrecognised-model-version.test.ts rather than inside it. #688's
// `claude-opus-4-9` is a version nobody has published, so the honest answer is
// to reach no row and print `not priced`. These three are real models with real
// numbers on OpenAI's own pages, so refusing to price them would invent a gap
// instead of a figure. What both halves pin is one rule: a family row may price
// only the ids somebody has read a number for.
//
// EVERY RATE BELOW WAS READ, NOT REMEMBERED. Source: the "Text tokens" panel on
// developers.openai.com/api/docs/models/<id>, one page per id, read 2026-08-26.
// The per-model pages and not developers.openai.com/api/docs/pricing, because
// the summary table is how the hole got here — it lists o1, o1-pro, o3, o3-mini,
// o3-pro and o4-mini and stops, and the three tiers it omits are precisely the
// three ids that had no row. A number in this file that nobody can point at a
// page for is the defect #690 is about, not a fix for it.
//
// Plain node, no fixtures, no filesystem except reading pricing.ts as text —
// identical on Linux, macOS and Windows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ratesForModel, type ModelRates } from "../pricing";

// Fixed clock. Nothing in the o-series is dated, but ratesForModel takes one and
// a suite that reads the wall clock is a suite that can change answer overnight.
const NOW = Date.UTC(2026, 7, 26);

const O = (input: number, output: number, cacheRead: number): ModelRates =>
  ({ input, output, cacheRead, cacheWrite: 0 });

/** One row per o-series / codex id, with the rate OpenAI publishes for it and
 *  the page that rate was read off. `inheritedBefore` is filled in for the three
 *  ids #690 is about: the rate the table gave them before this change, named
 *  here so a regression prints both numbers instead of one. */
interface Published {
  id: string;
  page: string;
  rates: ModelRates;
  /** The sibling row's rate this id used to be given, and the model it belongs to. */
  inheritedBefore?: { from: string; rates: ModelRates };
}

const O1        = O(15, 60, 7.5);
const O3        = O(2, 8, 0.5);
const O4_MINI   = O(1.1, 4.4, 0.275);

const PUBLISHED: Published[] = [
  // ── the three #690 fixes ───────────────────────────────────────────────────
  {
    id: "o1-mini",
    page: "developers.openai.com/api/docs/models/o1-mini",
    rates: O(1.1, 4.4, 0.55),          // Input $1.10 · Cached $0.55 · Output $4.40
    inheritedBefore: { from: "o1", rates: O1 },
  },
  {
    id: "o3-deep-research",
    page: "developers.openai.com/api/docs/models/o3-deep-research",
    rates: O(10, 40, 2.5),             // Input $10.00 · Cached $2.50 · Output $40.00
    inheritedBefore: { from: "o3", rates: O3 },
  },
  {
    id: "o4-mini-deep-research",
    page: "developers.openai.com/api/docs/models/o4-mini-deep-research",
    rates: O(2, 8, 0.5),               // Input $2.00 · Cached $0.50 · Output $8.00
    inheritedBefore: { from: "o4-mini", rates: O4_MINI },
  },

  // ── the siblings that were already right and must stay where they are ──────
  // This half is the constraint the fix had to satisfy, not padding: three new
  // rows inserted above three existing ones is three chances to shadow an id
  // that was pricing correctly, and nothing else in the suite would notice.
  {
    id: "o1",
    page: "developers.openai.com/api/docs/models/o1",
    rates: O1,                         // Input $15.00 · Cached $7.50 · Output $60.00
  },
  {
    // Rides the bare `o1` row and is correct doing so — its own page publishes
    // the same three numbers. Pinned because "correct by coincidence" is a claim
    // with an expiry date, and this is where it gets checked.
    id: "o1-preview",
    page: "developers.openai.com/api/docs/models/o1-preview",
    rates: O1,                         // Input $15.00 · Cached $7.50 · Output $60.00
  },
  {
    id: "o1-pro",
    page: "developers.openai.com/api/docs/models/o1-pro",
    rates: O(150, 600, 150),           // Input $150.00 · Output $600.00 · no cached rate
  },
  {
    id: "o3",
    page: "developers.openai.com/api/docs/models/o3",
    rates: O3,                         // Input $2.00 · Cached $0.50 · Output $8.00
  },
  {
    id: "o3-mini",
    page: "developers.openai.com/api/docs/models/o3-mini",
    rates: O(1.1, 4.4, 0.55),          // Input $1.10 · Cached $0.55 · Output $4.40
  },
  {
    id: "o3-pro",
    page: "developers.openai.com/api/docs/models/o3-pro",
    rates: O(20, 80, 20),              // Input $20.00 · Output $80.00 · no cached rate
  },
  {
    id: "o4-mini",
    page: "developers.openai.com/api/docs/models/o4-mini",
    rates: O4_MINI,                    // Input $1.10 · Cached $0.275 · Output $4.40
  },
  {
    id: "codex-mini-latest",
    page: "developers.openai.com/api/docs/models/codex-mini-latest",
    rates: O(1.5, 6, 0.375),           // Input $1.50 · Cached $0.375 · Output $6.00
  },
];

const money = (r: ModelRates) => `$${r.input}/$${r.output} (cached $${r.cacheRead})`;

describe("every o-series id prices at the rate OpenAI publishes for it", () => {
  for (const { id, page, rates } of PUBLISHED) {
    it(`${id} is ${money(rates)} — ${page}`, () => {
      expect(ratesForModel(id, NOW), `${id} does not match ${page}`).toEqual(rates);
    });
  }
});

describe("a sibling is priced as itself, not as the family row above it", () => {
  for (const { id, rates, inheritedBefore } of PUBLISHED) {
    if (!inheritedBefore) continue;
    it(`${id} is ${money(rates)} and not ${inheritedBefore.from}'s ${money(inheritedBefore.rates)}`, () => {
      const got = ratesForModel(id, NOW);
      // Deleting `${id}`'s row from RATES lands it back on the `${inheritedBefore.from}`
      // row, and this is the assertion that says so in words rather than as a
      // diff between two anonymous objects.
      expect(
        got,
        `${id} inherited ${inheritedBefore.from}'s ${money(inheritedBefore.rates)}; `
          + `its published rate is ${money(rates)}`,
      ).not.toEqual(inheritedBefore.rates);
      expect(got, id).toEqual(rates);
    });
  }
});

/** The spellings a real id arrives in. The dated snapshot of each is the id
 *  OpenAI's own page names, and the `_` forms are the separator every `[-_]` in
 *  the table exists to accept — `o1_mini` reached NO row before this change,
 *  because `\b` after a digit is false against `_`, a word character. */
const SPELLINGS: Array<[string, ModelRates]> = [
  ["o1-mini-2024-09-12", O(1.1, 4.4, 0.55)],
  ["o1_mini", O(1.1, 4.4, 0.55)],
  ["o1-preview-2024-09-12", O1],
  ["o1-2024-12-17", O1],
  ["o3-deep-research-2025-06-26", O(10, 40, 2.5)],
  ["o3_deep_research", O(10, 40, 2.5)],
  ["o3-2025-04-16", O3],
  ["o3-mini-2025-01-31", O(1.1, 4.4, 0.55)],
  ["o4-mini-deep-research-2025-06-26", O(2, 8, 0.5)],
  ["o4_mini_deep_research", O(2, 8, 0.5)],
  ["o4-mini-2025-04-16", O4_MINI],
];

describe("the tail and the separator a real o-series id carries still price", () => {
  for (const [id, rates] of SPELLINGS) {
    it(`${id} is ${money(rates)}`, () => {
      expect(ratesForModel(id, NOW), `${id} stopped pricing, or moved`).toEqual(rates);
    });
  }
});

/** Order in RATES is what makes the three new rows work — first match wins, so
 *  each must sit ABOVE the row that was eating its id. Read out of the source
 *  rather than inferred from behaviour: a reorder that reintroduces the bug is
 *  caught by the tests above too, but only this one says what went wrong. */
describe("each new row sits above the row it was being swallowed by", () => {
  const text = readFileSync(fileURLToPath(new URL("../pricing.ts", import.meta.url)), "utf8");
  const start = text.indexOf("const RATES");
  const end = text.indexOf("\n];", start);
  const block = text.slice(start, end);

  const rows = [...block.matchAll(/match:\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g)].map(m => m[1]);

  const PAIRS: Array<[specific: string, family: string]> = [
    [String.raw`/^o1[-_]mini/i`, String.raw`/^o1\b/i`],
    [String.raw`/^o3[-_]deep[-_]research/i`, String.raw`/^o3\b/i`],
    [String.raw`/^o4[-_]mini[-_]deep[-_]research/i`, String.raw`/^o4[-_]mini/i`],
  ];

  for (const [specific, family] of PAIRS) {
    it(`${specific} precedes ${family}`, () => {
      const i = rows.indexOf(specific);
      const j = rows.indexOf(family);
      expect(i, `${specific} is not in RATES`).toBeGreaterThan(-1);
      expect(j, `${family} is not in RATES`).toBeGreaterThan(-1);
      expect(i, `${specific} must come before ${family} — first match wins`).toBeLessThan(j);
    });
  }
});

/** The verification date beside the rates is the only thing separating a read
 *  number from a remembered one, so it is required to be there. */
describe("the o-series rates say when they were last read off the vendor's page", () => {
  it("carries a dated source note in the o-series block", () => {
    const text = readFileSync(fileURLToPath(new URL("../pricing.ts", import.meta.url)), "utf8");
    const at = text.indexOf("o-series reasoning models");
    expect(at, "the o-series block header").toBeGreaterThan(-1);
    const head = text.slice(at, at + 1200);
    expect(head, "a date beside the o-series rates").toMatch(/verified 20\d\d-\d\d-\d\d/i);
    expect(head, "the page the rates were read from").toMatch(
      /developers\.openai\.com\/api\/docs\/models/,
    );
  });
});
