// Sonnet 5 is $2 / $10, and the scheduled increase that never happened.
//
// The history matters, because this file used to prove the opposite and the
// code used to implement it.
//
// Sonnet 5 launched on introductory pricing "through August 31, 2026", with an
// increase to $3 / $15 announced for September 1. The rate table resolved that
// per call rather than pinning it, deliberately: the deck is built for tabs
// that stay open for days, and a rate resolved once at module load would have
// kept quoting the intro price long after the cutover. That was correct, and
// this file proved it on both sides of the date.
//
// THEN ANTHROPIC CANCELLED THE INCREASE. The pricing page now says so outright:
// "The $2/$10 per million input/output token pricing for Claude Sonnet 5 … is
// now the standard price. The previously scheduled increase to $3/$15 per
// million input/output tokens on September 1, 2026 will not occur."
//
// So from 2026-09-01 until this was noticed, every Sonnet 5 session on every
// deck was costed fifty per cent high — not because the code was wrong, but
// because the schedule it faithfully implemented was withdrawn. That is the
// failure mode worth a test file of its own: a rate table is a claim about
// somebody's money, and a scheduled change nobody re-checks fails silently and
// in the expensive direction.
//
// What is pinned now is the absence of a cutover. One rate, on both sides of a
// date that no longer means anything, so nobody restores the schedule from the
// comment history without also changing this.
import { describe, it, expect } from "vitest";
import { ratesForModel, costForUsage } from "../pricing";
import type { TokenUsage } from "../types";

/** The date the increase was to have taken effect, kept only so the two sides
 *  of it can be shown to be the same. */
const WOULD_HAVE_BEEN = Date.UTC(2026, 8, 1);   // 2026-09-01
const BEFORE = Date.UTC(2026, 7, 30);           // 2026-08-30
const AFTER = Date.UTC(2026, 8, 5);             // 2026-09-05

/** The published rate. platform.claude.com/docs/en/about-claude/pricing. */
const SONNET_5 = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 };

/** The rate the deck quoted for four days in September, and must never quote
 *  again. Named rather than inlined so a reader sees what is being excluded. */
const WITHDRAWN = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 };

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, ...u,
});

describe("Sonnet 5 costs the same on every date", () => {
  it("quotes $2 / $10 before the withdrawn cutover", () => {
    expect(ratesForModel("claude-sonnet-5", BEFORE)).toEqual(SONNET_5);
  });

  it("quotes $2 / $10 after it, which is the whole correction", () => {
    expect(ratesForModel("claude-sonnet-5", AFTER)).toEqual(SONNET_5);
  });

  it("does not step at the instant it used to", () => {
    expect(ratesForModel("claude-sonnet-5", WOULD_HAVE_BEEN - 1)).toEqual(SONNET_5);
    expect(ratesForModel("claude-sonnet-5", WOULD_HAVE_BEEN)).toEqual(SONNET_5);
  });

  it("never quotes the withdrawn rate, at any date this deck can be run on", () => {
    // A year either side, sampled monthly. The point is not the sampling — it
    // is that no clock reaches the number that was overcharging.
    for (let m = -12; m <= 12; m++) {
      const t = Date.UTC(2026, 8 + m, 15);
      expect(ratesForModel("claude-sonnet-5", t)).not.toEqual(WITHDRAWN);
    }
  });

  it("prices a whole session identically on both sides", () => {
    const u = usage({
      inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000, cacheCreateTokens: 1_000_000,
    });
    const before = costForUsage(u, "claude-sonnet-5", BEFORE);
    const after = costForUsage(u, "claude-sonnet-5", AFTER);
    expect(after.total).toBeCloseTo(before.total, 10);
    expect(before.input).toBeCloseTo(2, 10);
    expect(before.output).toBeCloseTo(10, 10);
    expect(before.cacheRead).toBeCloseTo(0.2, 10);
    expect(before.cacheWrite).toBeCloseTo(2.5, 10);
  });

  it("answers the same with no clock passed at all", () => {
    // The wall clock is past the withdrawn date, so this is the case a user is
    // actually in, and it must not differ from either fixed date above.
    expect(ratesForModel("claude-sonnet-5")).toEqual(SONNET_5);
  });

  it("leaves every other model identical on both sides, as it always did", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-4.5", "claude-fable-5-1", "gpt-5.6"]) {
      expect(ratesForModel(model, BEFORE)).toEqual(ratesForModel(model, AFTER));
    }
  });
});

describe("Fable 5.1 and Mythos 5.1, whose cache read is the release", () => {
  it("prices a cache hit at 0.025x the input rate, not the usual 0.1x", () => {
    // These two are the only models Anthropic prices this way — $0.25 rather
    // than $1, a 75% cut — and an agentic session is mostly cache reads, so
    // inheriting Fable 5's number would overstate a long session badly.
    for (const id of ["claude-fable-5-1", "claude-mythos-5-1"]) {
      expect(ratesForModel(id)).toEqual(
        { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 });
    }
  });

  it("leaves Fable 5 and Mythos 5 where they were", () => {
    for (const id of ["claude-fable-5", "claude-mythos-5"]) {
      expect(ratesForModel(id)!.cacheRead).toBe(1);
    }
  });

  it("takes a dated snapshot of 5.1 but not a different minor", () => {
    expect(ratesForModel("claude-fable-5-1-20260101")!.cacheRead).toBe(0.25);
    // 5.11 is not 5.1, and a 5.2 nobody has quoted is not priced at all —
    // the guard every Claude row carries, doing its job on a new row.
    expect(ratesForModel("claude-fable-5-11")).toBeNull();
    expect(ratesForModel("claude-fable-5-2")).toBeNull();
  });
});
