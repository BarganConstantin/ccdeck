// #987: the $/min pill counted a session's whole prior history as spend in the
// last ten minutes.
//
// The rate was the rise of `boardTotals(...).cost.total` across a trailing
// window, and the board gains a session's ENTIRE accumulated cost the moment
// that session first reaches the canvas. Sessions arrive carrying history for
// several ordinary reasons: a Claude session that started before the deck whose
// first hook event lands now, a rollout the Codex watcher picks up mid-flight,
// a Stop-evicted session returning under the same id — which reducer.ts records
// as something that happens. The only thing between that and the headline was
// one flat threshold, SPEND_JUMP_USD, and an hour-old session's accumulated
// cost is routinely well under it.
//
// MEASURED against the shipped module before the fix. Ten minutes of honest
// spending, $1.00 to $3.00 on the board — a true $0.20/min — then a session
// carrying $15 of history joins:
//
//   TRUE RATE   spent=2.00   span=605s  ->  $0.20/min
//   AFTER JOIN  spent=16.98  span=600s  ->  $1.70/min
//   ratio: 8.56x
//
// held for the full window, with the tooltip "Spend on this board over the last
// 10 min" vouching for it — the same eightfold swing #821 was filed to remove.
//
// The rule is the one live-delta.ts states and this module could not follow
// while it sampled one board-wide number: this may only ever add work it has
// WATCHED happen, never work it has merely learned about.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  recordSpend, spendRate, NO_SPEND_HISTORY, SPEND_JUMP_USD,
  type SpendHistory, type SpendBySession,
} from "../spend-rate";

/** Ten minutes of one session spending $0.20/min, sampled every five seconds. */
function tenHonestMinutes(): { h: SpendHistory; t: number } {
  let h = NO_SPEND_HISTORY, t = 0;
  for (let i = 0; i <= 120; i++) {
    h = recordSpend(h, t, new Map([["live", { cost: 1 + (2 * i) / 120 }]]));
    t += 5_000;
  }
  return { h, t };
}
const rateOf = (h: SpendHistory, t: number, now: SpendBySession) => {
  const r = spendRate(h, t, now)!;
  return r.spent / (r.spanSec / 60);
};

describe("a session that joins with history is not spending (#987)", () => {
  it("contributes nothing to the rate on the sample it arrives in", () => {
    const { h, t } = tenHonestMinutes();
    const before = rateOf(h, t, new Map([["live", { cost: 3 }]]));
    expect(before).toBeCloseTo(0.2, 2);

    // $15 of accumulated history walks onto the canvas. Board total goes to $18.
    const joined: SpendBySession = new Map([["live", { cost: 3 }], ["old", { cost: 15 }]]);
    const after = recordSpend(h, t + 5_000, joined);
    expect(rateOf(after, t + 5_000, joined), "the newcomer's history was read as spend")
      .toBeCloseTo(0.2, 2);
  });

  it("counts it from its second sample on, which is the first the deck watched", () => {
    // The correction's whole cost: a genuinely new session's spend waits one
    // sample. That is five seconds, it is the direction to be wrong in, and it
    // is what liveDelta already trades for the same guarantee.
    const { h, t } = tenHonestMinutes();
    const joined = recordSpend(h, t + 5_000, new Map([["live", { cost: 3 }], ["old", { cost: 15 }]]));
    // Two futures from the same history, so the window trims identically in
    // both and the only difference between them is the newcomer's dollar.
    const still: SpendBySession = new Map([["live", { cost: 3 }], ["old", { cost: 15 }]]);
    const grown: SpendBySession = new Map([["live", { cost: 3 }], ["old", { cost: 16 }]]);
    const idle = spendRate(recordSpend(joined, t + 10_000, still), t + 10_000, still)!;
    const spent = spendRate(recordSpend(joined, t + 10_000, grown), t + 10_000, grown)!;
    expect(spent.spent - idle.spent, "the watched dollar was not counted").toBeCloseTo(1, 5);
    // And nothing anywhere near the $15 it walked in with.
    expect(spent.spent).toBeLessThan(4);
  });

  it("is not saved by the old threshold, which is why the threshold was not the fix", () => {
    // $15 of history is 75% of SPEND_JUMP_USD and sails under it. Raising the
    // number cannot work either: to be safe against a board-wide total it would
    // have to exceed any single session's lifetime cost, and then it would stop
    // catching the corrections it exists for.
    expect(SPEND_JUMP_USD).toBe(20);
    const { h, t } = tenHonestMinutes();
    const joined: SpendBySession = new Map([["live", { cost: 3 }], ["old", { cost: 15 }]]);
    const after = recordSpend(h, t + 5_000, joined);
    // The window is intact — nothing was reset — and the figure is still true.
    expect(after.samples.length).toBeGreaterThan(100);
    expect(rateOf(after, t + 5_000, joined)).toBeCloseTo(0.2, 2);
  });

  it("holds when a whole replay lands at once, which is the unbounded case", () => {
    // liveDelta's own measurement: a deck four seconds old, ccusage answering
    // $450.28 for today and the panel printing $1,006, because the board was
    // still replaying and every session that appeared was added again in full.
    // Twelve sessions arriving together, each with history, must move nothing.
    const { h, t } = tenHonestMinutes();
    const flood: SpendBySession = new Map([["live", { cost: 3 }]]);
    for (let i = 0; i < 12; i++) flood.set(`replayed-${i}`, { cost: 37.5 });
    const after = recordSpend(h, t + 5_000, flood);
    expect(rateOf(after, t + 5_000, flood)).toBeCloseTo(0.2, 2);
  });
});

describe("the per-session key is the fix, not the threshold (#987)", () => {
  it("reproduces the old figure when the board is fed to it as one session", () => {
    // WHY THIS CASE EXISTS. The fix changed this module's signature, so
    // reverting it does not produce a behavioural red — it produces a type
    // error, which proves nothing about the defect. This drives the FIXED
    // module the old way instead: one synthetic key standing in for the board's
    // single total. Every session's history then arrives as a rise of that one
    // key, there is nobody to attribute it to, and the 8.56x comes straight
    // back — which is the point. The defect was never in the window, the
    // arithmetic or the threshold. It was in counting one number that cannot
    // distinguish money spent from money learned about.
    let h = NO_SPEND_HISTORY, t = 0;
    for (let i = 0; i <= 120; i++) {
      h = recordSpend(h, t, new Map([["board", { cost: 1 + (2 * i) / 120 }]]));
      t += 5_000;
    }
    const honest = rateOf(h, t, new Map([["board", { cost: 3 }]]));
    expect(honest).toBeCloseTo(0.2, 2);

    // The same $15 of history, now indistinguishable from spending.
    const asOneTotal: SpendBySession = new Map([["board", { cost: 18 }]]);
    const after = recordSpend(h, t + 5_000, asOneTotal);
    const wrong = rateOf(after, t + 5_000, asOneTotal);
    expect(wrong).toBeGreaterThan(honest * 8);
    expect(wrong).toBeCloseTo(1.7, 1);
  });
});

describe("the panel samples what the rule needs (#987)", () => {
  const panel = readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");

  it("hands the rate per-session costs, not the board's one total", () => {
    // The same map the live delta below it is built on — one shape, one place,
    // so the two cannot drift apart.
    expect(panel).toMatch(/const bySession = boardBySession\(state\.agents\.values\(\), now\);/);
    expect(panel).toMatch(/recordSpend\(spendSamples\.current, now, bySession\)/);
    expect(panel).toMatch(/spendRate\(spendSamples\.current, now, bySession\)/);
    expect(panel).not.toMatch(/recordSpend\([^)]*board\.cost\.total/);
    expect(panel).not.toMatch(/spendRate\([^)]*board\.cost\.total/);
  });
});
