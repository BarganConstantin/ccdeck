// #688: a version this build has never heard of must reach NO rate row.
//
// The bug was one optional group. `^claude[-_]opus[-_]4(?:[-_.]1)?\b` reads
// `claude-opus-4-9` by taking the empty branch of its `.1` and finding a word
// boundary between the `4` and the `-`, so an Opus 4.9 fell through the current
// tier's row and landed on the RETIRED Opus 4 row — $15/$75 where the tier it
// belongs to charges $5/$25. Three times the real spend, printed as a plausible
// figure, with nothing on screen to say it was invented. `claude-opus-4-10` got
// there by backtracking: it tries `-1`, fails the boundary between `1` and `0`,
// and settles on the bare `4`. The bare Sonnet 4 row swallowed `claude-sonnet-4-7`
// and everything above it the same way — free today only because Sonnet 4 and
// 4.5/4.6 happen to share a price.
//
// The file already argued the principle for the other provider, on the gpt-5 row:
// a context window is a coarse capability worth guessing, a PRICE is the number a
// user checks their bill against, and `not priced` is the honest answer to a model
// this build has never heard of. This file pins that answer for the Claude half.
//
// WHY THE OBVIOUS FIX IS WRONG, which is the other half of what is pinned here.
// `(?![-_.]?\d)` — refuse any digit after the version — also refuses the commonest
// tail a Claude id has. `claude-opus-4-20250514` is Bedrock's Opus 4 and
// `claude-opus-4-1-20250805` is first-party Opus 4.1; both are live ids and both
// would have stopped pricing altogether. Unpricing a real model is a worse bug
// than the one being closed, so `SPELLINGS_THAT_MUST_KEEP_PRICING` below is not
// decoration: it is the constraint the fix had to satisfy.
//
// Plain node — ratesForModel is pure arithmetic over a string, so this suite is
// identical on Linux, macOS and Windows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ratesForModel, type ModelRates } from "../pricing";

// Fixed clock. Sonnet 5's row is a function of the date, and a suite reading the
// wall clock would pin a different number in September than in August.
const NOW = Date.UTC(2026, 7, 26);

const A = (
  input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number,
): ModelRates => ({ input, output, cacheRead, cacheWrite, cacheWrite1h });

const OPUS_TIER_NEW    = A(5, 25, 0.5, 6.25, 10);
const OPUS_TIER_OLD    = A(15, 75, 1.5, 18.75, 30);
const SONNET_4         = A(3, 15, 0.3, 3.75, 6);
const SONNET_5_INTRO   = A(2, 10, 0.2, 2.5, 4);   // NOW is inside the intro window
const HAIKU_4_5        = A(1, 5, 0.1, 1.25, 2);
const HAIKU_3_5        = A(0.8, 4, 0.08, 1, 1.6);
const FABLE_MYTHOS_5   = A(10, 50, 1, 12.5, 20);
const FABLE_MYTHOS_5_1 = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 };

/** One row per family: what it prices today, and what a plausible next version
 *  of it spells. Adding a family to RATES is one row here — both halves of the
 *  claim in one place, because they are one claim: this row knows these ids and
 *  refuses to guess about the rest. */
const FAMILIES: Array<{
  family: string;
  priced: Array<[string, ModelRates]>;
  unrecognised: string[];
}> = [
  {
    family: "Opus 4.5 - 4.8 (the current Opus tier)",
    priced: [
      ["claude-opus-4-5", OPUS_TIER_NEW],
      ["claude-opus-4-6", OPUS_TIER_NEW],
      ["claude-opus-4-7", OPUS_TIER_NEW],
      ["claude-opus-4-8", OPUS_TIER_NEW],
    ],
    // The issue's own case. Before the fix each of these read $15/$75 — the
    // retired tier, three times the current one.
    unrecognised: ["claude-opus-4-9", "claude-opus-4-10", "claude-opus-4-11", "claude-opus-4-5-1"],
  },
  {
    family: "Opus 4 / 4.1 (retired)",
    priced: [
      ["claude-opus-4", OPUS_TIER_OLD],
      ["claude-opus-4-1", OPUS_TIER_OLD],
    ],
    unrecognised: ["claude-opus-4-2", "claude-opus-4-3", "claude-opus-4-4", "claude-opus-4-0"],
  },
  {
    family: "Opus 5",
    priced: [["claude-opus-5", OPUS_TIER_NEW]],
    unrecognised: ["claude-opus-5-1", "claude-opus-6", "claude-opus-5-2"],
  },
  {
    family: "Sonnet 5 (introductory rate — the worst one to inherit by accident)",
    priced: [["claude-sonnet-5", SONNET_5_INTRO]],
    unrecognised: ["claude-sonnet-5-1", "claude-sonnet-6"],
  },
  {
    family: "Sonnet 4.5 / 4.6",
    priced: [
      ["claude-sonnet-4-5", SONNET_4],
      ["claude-sonnet-4-6", SONNET_4],
    ],
    unrecognised: ["claude-sonnet-4-7", "claude-sonnet-4-8", "claude-sonnet-4-9", "claude-sonnet-4-10"],
  },
  {
    family: "Sonnet 4 (retired)",
    priced: [["claude-sonnet-4", SONNET_4]],
    unrecognised: ["claude-sonnet-4-1", "claude-sonnet-4-2"],
  },
  {
    family: "Haiku 4.5",
    priced: [["claude-haiku-4-5", HAIKU_4_5]],
    unrecognised: ["claude-haiku-4-6", "claude-haiku-4-7", "claude-haiku-4-5-1"],
  },
  {
    family: "Haiku 3.5",
    priced: [["claude-haiku-3-5", HAIKU_3_5]],
    unrecognised: ["claude-haiku-3-6", "claude-haiku-3-7", "claude-haiku-3-5-1"],
  },
  {
    // 5.1 was in the `unrecognised` list here until Anthropic published its
    // price, which is exactly the lifecycle this file is about: a minor stays
    // unpriced until somebody quotes it, and then it gets a row of its own
    // rather than inheriting the one below. Its cache read is $0.25 against
    // Fable 5's $1, so inheriting would have been wrong by four times on the
    // half of an agentic session that is cache reads.
    family: "Fable 5.1 / Mythos 5.1",
    priced: [
      ["claude-fable-5-1", FABLE_MYTHOS_5_1],
      ["claude-mythos-5-1", FABLE_MYTHOS_5_1],
    ],
    unrecognised: ["claude-fable-5-2", "claude-mythos-5-2", "claude-fable-5-11"],
  },
  {
    family: "Fable 5 / Mythos 5",
    priced: [
      ["claude-fable-5", FABLE_MYTHOS_5],
      ["claude-mythos-5", FABLE_MYTHOS_5],
    ],
    unrecognised: ["claude-fable-6", "claude-mythos-6"],
  },
  {
    family: "gpt-5 (already guarded before #688 — pinned so it stays that way)",
    priced: [
      ["gpt-5", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }],
      ["gpt-5.1", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }],
      ["gpt-5.6", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }],
    ],
    unrecognised: ["gpt-5.7", "gpt-5.10", "gpt-5.60", "gpt-6"],
  },
];

describe("every id this build knows still prices at exactly its published rate", () => {
  for (const { family, priced } of FAMILIES) {
    for (const [id, rates] of priced) {
      it(`${family}: ${id} is $${rates.input}/$${rates.output}`, () => {
        expect(ratesForModel(id, NOW), id).toEqual(rates);
      });
    }
  }
});

describe("a version this build has never heard of reaches no row at all", () => {
  for (const { family, unrecognised } of FAMILIES) {
    for (const id of unrecognised) {
      it(`${family}: ${id} answers "not priced"`, () => {
        // A failure here prints the rate that was invented for it, which is the
        // whole point: the number is plausible and the user has no way to know
        // it was guessed.
        expect(
          ratesForModel(id, NOW),
          `${id} inherited a price it was never quoted`,
        ).toBeNull();
      });
    }
  }
});

/** The spellings a live Claude id actually arrives in. Every one of these ends
 *  in something the naive guard would have read as "another version", and every
 *  one of them must keep pricing — this is the list that rules out the fix the
 *  issue suggested. */
const SPELLINGS_THAT_MUST_KEEP_PRICING: Array<[string, ModelRates]> = [
  // First-party dated snapshots: an 8-digit release date behind the version.
  ["claude-opus-4-20250514", OPUS_TIER_OLD],
  ["claude-opus-4-1-20250805", OPUS_TIER_OLD],
  ["claude-opus-4-5-20251101", OPUS_TIER_NEW],
  ["claude-sonnet-4-20250514", SONNET_4],
  ["claude-sonnet-4-5-20250929", SONNET_4],
  ["claude-haiku-4-5-20251001", HAIKU_4_5],
  ["claude-haiku-3-5-20241022", HAIKU_3_5],
  // Bedrock / Mantle: the same date, behind a provider namespace and in front of
  // a deployment revision.
  ["us.anthropic.claude-opus-4-20250514-v1:0", OPUS_TIER_OLD],
  ["us.anthropic.claude-opus-4-1-20250805-v1:0", OPUS_TIER_OLD],
  ["us.anthropic.claude-opus-4-5-20251101-v1:0", OPUS_TIER_NEW],
  ["anthropic.claude-sonnet-4-20250514-v1:0", SONNET_4],
  // Vertex's `@date`, CC's `[1m]` context banner, the `.` version separator and
  // the `_` spelling every `[-_]` in the table exists to accept.
  ["claude-opus-4@20250514", OPUS_TIER_OLD],
  ["claude-opus-4-1@20250805", OPUS_TIER_OLD],
  ["claude-opus-4-5@20251101", OPUS_TIER_NEW],
  ["claude-opus-5[1m]", OPUS_TIER_NEW],
  ["claude-opus-4-5[1m]", OPUS_TIER_NEW],
  ["claude-opus-4.1", OPUS_TIER_OLD],
  ["claude_opus_4_1", OPUS_TIER_OLD],
  ["claude_opus_5", OPUS_TIER_NEW],
  ["claude_haiku_4_5", HAIKU_4_5],
];

describe("the tail a real Claude id carries is not mistaken for a version", () => {
  for (const [id, rates] of SPELLINGS_THAT_MUST_KEEP_PRICING) {
    it(`still prices ${id}`, () => {
      expect(ratesForModel(id, NOW), `${id} stopped pricing`).toEqual(rates);
    });
  }
});

describe("the guard is on every Claude row, not just the one the issue named", () => {
  it("carries the version lookahead in each `^claude` pattern", () => {
    // Read out of the source rather than off the exported function, for the
    // reason bedrock-model-ids.test.ts reads RATES the same way: a family added
    // tomorrow without the guard has no id in the table above to fail on, so the
    // only thing that can catch it is the shape of the row itself.
    const text = readFileSync(fileURLToPath(new URL("../pricing.ts", import.meta.url)), "utf8");
    const start = text.indexOf("const RATES");
    const end = text.indexOf("\n];", start);
    expect(start, "RATES declaration").toBeGreaterThan(-1);
    expect(end, "end of RATES").toBeGreaterThan(start);

    const claudeRows = [...text.slice(start, end).matchAll(/match:\s*(\/\^claude[^\n]*?\/i)\s*,/g)]
      .map(m => m[1]);
    expect(claudeRows.length, "Claude rows found in RATES").toBeGreaterThanOrEqual(9);

    const unguarded = claudeRows.filter(r => !r.includes(String.raw`(?![-_.]\d{1,7}(?!\d))`));
    expect(unguarded, "Claude rate rows missing the version guard").toEqual([]);
  });
});
