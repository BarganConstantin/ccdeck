// Shaping ccusage's answer into the rows the Usage panel draws.
//
// The panel used to sum the agents on the canvas, which is an honest figure
// with an unusual scope — the canvas evicts finished sessions on a timer, so
// the total went DOWN while nothing had happened and nothing had been refunded
// (#737). ccusage reads the transcripts themselves and forgets nothing.
//
// It also keeps its own rate table, which is the second reason to prefer it and
// the one this repo learned the hard way: this deck shipped Sonnet 5 at fifty
// per cent over for four days after an announced increase was cancelled, and
// shipped Fable 5.1 as "not priced" until somebody noticed. On the same machine
// on the same day, ccusage had both right.
//
// Fixtures are the real shapes, taken from a live run against this machine's
// own transcripts — including the two field names that are easy to guess wrong.
import { describe, it, expect } from "vitest";
import { PERIODS, sinceFor, modelRows, sessionRows, rangeTotals } from "../usage-from-ccusage";

/** What `/api/ccusage` really returns for one day. */
const RANGE = {
  ok: true,
  since: "20260904",
  totals: {
    totalCost: 803.58, totalTokens: 1_115_675_828,
    inputTokens: 7959, outputTokens: 3_321_205,
    cacheReadTokens: 1_091_540_917, cacheCreationTokens: 20_805_747,
  },
  days: [{
    period: "2026-09-04", agent: "all", totalCost: 803.58,
    modelBreakdowns: [
      { modelName: "claude-opus-5", cost: 723.56, inputTokens: 6490, outputTokens: 2_730_028,
        cacheReadTokens: 1_016_674_127, cacheCreationTokens: 16_150_266 },
      { modelName: "claude-fable-5-1", cost: 52.27, inputTokens: 447, outputTokens: 400_000,
        cacheReadTokens: 8_733_600, cacheCreationTokens: 2_407_219 },
      { modelName: "claude-sonnet-5", cost: 24.37, inputTokens: 1022, outputTokens: 191_177,
        cacheReadTokens: 66_133_190, cacheCreationTokens: 2_248_262 },
    ],
  }],
  sessions: [
    { period: "07ac7b2b-7ee2-4633-a3cf-c0b1c193a65c", agent: "claude", totalCost: 376.88,
      totalTokens: 500_000_000, modelsUsed: ["claude-opus-5", "claude-sonnet-5"],
      metadata: { lastActivity: "2026-09-04T16:13:34.983Z" } },
    { period: "093cb8a9-0000-4000-8000-000000000000", agent: "claude", totalCost: 88.0,
      totalTokens: 120_000_000, modelsUsed: ["claude-opus-5"], metadata: {} },
    { period: "11a28d21-0000-4000-8000-000000000000", agent: "codex", totalCost: 0.72,
      totalTokens: 1_000_000, modelsUsed: ["gpt-5.3-codex"] },
  ],
};

describe("which span the panel asks for", () => {
  // Fixed clock: 2026-09-04 is a Friday, and the 4th of the month.
  const now = new Date(2026, 8, 4, 13, 45);

  it("asks for today, in local calendar time", () => {
    expect(sinceFor("today", now)).toBe("20260904");
  });

  it("asks for the first of the month, whichever day it is", () => {
    expect(sinceFor("month", now)).toBe("20260901");
    expect(sinceFor("month", new Date(2026, 8, 1, 0, 5))).toBe("20260901");
    expect(sinceFor("month", new Date(2026, 8, 30, 23, 55))).toBe("20260901");
  });

  it("uses local fields, not UTC, which is the trap presetSince exists for", () => {
    // Late evening west of UTC is already tomorrow's UTC date. A "today" built
    // from toISOString would ask for the wrong day for part of every day.
    const late = new Date(2026, 8, 4, 23, 30);
    expect(sinceFor("today", late)).toBe("20260904");
  });

  it("spells all-time as a date rather than leaving it out", () => {
    // /api/ccusage refuses a range whose ends are not YYYYMMDD, which is what
    // keeps a user-supplied string out of an argv.
    expect(sinceFor("all", now)).toMatch(/^\d{8}$/);
    expect(Number(sinceFor("all", now))).toBeLessThan(20210101);
  });

  it("offers three spans, each with a word for it", () => {
    expect(PERIODS.map(p => p.key)).toEqual(["today", "month", "all"]);
    for (const p of PERIODS) expect(p.noun.length).toBeGreaterThan(0);
  });
});

describe("BY MODEL", () => {
  it("reads the breakdown ccusage sends, costliest first", () => {
    const rows = modelRows(RANGE);
    expect(rows.map(r => r.model)).toEqual(["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5"]);
    expect(rows[0].cost).toBeCloseTo(723.56, 6);
  });

  it("folds a month of days into one row per model", () => {
    // ccusage gives one breakdown per day, so thirty days is thirty lists.
    // Concatenating instead of summing shows Opus thirty times.
    const threeDays = {
      days: [1, 2, 3].map(() => ({
        modelBreakdowns: [{ modelName: "claude-opus-5", cost: 10, inputTokens: 100, outputTokens: 200 }],
      })),
    };
    const rows = modelRows(threeDays);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBeCloseTo(30, 6);
    expect(rows[0].inputTokens).toBe(300);
  });

  it("counts cache tokens into the row's total, under ccusage's own spelling", () => {
    // `cacheCreationTokens` there, `cacheCreateTokens` in the deck's own types.
    // Reading the wrong one loses the larger half of an agentic session.
    const [opus] = modelRows(RANGE);
    expect(opus.cacheCreateTokens).toBe(16_150_266);
    expect(opus.tokens).toBe(6490 + 2_730_028 + 1_016_674_127 + 16_150_266);
  });

  it("keeps a model with tokens and no price", () => {
    // One this ccusage does not know. The tokens were really spent, and hiding
    // the row would make the totals look complete when they are not.
    const rows = modelRows({ days: [{ modelBreakdowns: [{ modelName: "gpt-6-astra", inputTokens: 5_000 }] }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "gpt-6-astra", cost: 0 });
    expect(rows[0].tokens).toBe(5_000);
  });

  it("answers with nothing for every shape that is not a range", () => {
    for (const junk of [null, undefined, {}, { days: null }, { days: [{}] }, { days: [{ modelBreakdowns: "no" }] }]) {
      expect(modelRows(junk as never)).toEqual([]);
    }
  });
});

describe("BY SESSION", () => {
  it("takes the session id out of `period`, which is where ccusage puts it", () => {
    // The join key. It is the same uuid Claude Code writes into every hook
    // payload, and the key the canvas files its agents under.
    expect(sessionRows(RANGE).map(r => r.sessionId)).toEqual([
      "07ac7b2b-7ee2-4633-a3cf-c0b1c193a65c",
      "093cb8a9-0000-4000-8000-000000000000",
      "11a28d21-0000-4000-8000-000000000000",
    ]);
  });

  it("names a row the board knows, and leaves the rest unnamed", () => {
    // A uuid is not a label. What to draw for an unnamed row is the panel's
    // decision, so this layer says null rather than inventing one.
    const names = new Map([["07ac7b2b-7ee2-4633-a3cf-c0b1c193a65c", "agents-deck"]]);
    const rows = sessionRows(RANGE, names);
    expect(rows[0].label).toBe("agents-deck");
    expect(rows[1].label).toBeNull();
  });

  it("keeps which CLI spent it", () => {
    // The range covers both, and a Codex row beside a Claude row with no way to
    // tell them apart is the panel losing something ccusage already knew.
    expect(sessionRows(RANGE).map(r => r.agent)).toEqual(["claude", "claude", "codex"]);
  });

  it("orders by cost, so the row worth seeing is the one on top", () => {
    expect(sessionRows(RANGE).map(r => r.cost)).toEqual([376.88, 88.0, 0.72]);
  });

  it("reads lastActivity when it is there and says nothing when it is not", () => {
    const rows = sessionRows(RANGE);
    expect(rows[0].lastActivityMs).toBe(Date.parse("2026-09-04T16:13:34.983Z"));
    expect(rows[1].lastActivityMs).toBeNull();   // metadata present, field absent
    expect(rows[2].lastActivityMs).toBeNull();   // no metadata at all
  });

  it("drops a row with no id, which cannot be joined or identified", () => {
    expect(sessionRows({ sessions: [{ totalCost: 5 }, { period: "", totalCost: 5 }] })).toEqual([]);
  });

  it("survives the array being named the way a reader would guess", () => {
    // ccusage names it after the COMMAND — `session`, singular. The server
    // already normalises this; the client must not fall over if it ever sees
    // the other spelling.
    expect(sessionRows({ sessions: undefined } as never)).toEqual([]);
  });
});

describe("the headline", () => {
  it("uses the totals ccusage sent", () => {
    const t = rangeTotals(RANGE);
    expect(t.cost).toBeCloseTo(803.58, 6);
    expect(t.tokens).toBe(1_115_675_828);
    expect(t.cacheReadTokens).toBe(1_091_540_917);
  });

  it("folds the days when there is no totals block", () => {
    // A headline of zero above a populated table is the worse of the two
    // answers, so an absent totals block is summed rather than trusted.
    const t = rangeTotals({ days: RANGE.days });
    expect(t.cost).toBeCloseTo(723.56 + 52.27 + 24.37, 6);
    expect(t.tokens).toBeGreaterThan(0);
  });

  it("is all zeroes for a range with nothing in it, not a crash", () => {
    // The first of the month, or a machine that has not run an agent today.
    // Zero is information; blank is a fault.
    for (const empty of [null, undefined, {}, { days: [] }]) {
      expect(rangeTotals(empty as never)).toMatchObject({ cost: 0, tokens: 0 });
    }
  });
});
