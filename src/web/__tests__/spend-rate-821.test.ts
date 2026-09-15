// #821: the usage header's $/min swung eightfold with which agents were live.
//
// It divided the live agents' cost by the longest-running one's age, so a tab
// left open read $2.39/min and a fresh tab of the same deck $19.49/min. It is
// the board total's rise over a trailing ten-minute window now, labelled with
// the span it measured, in a neutral colour. spend-rate.ts carries the rule.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordSpend, spendRate, SPEND_WINDOW_MS, NO_SPEND_HISTORY, type SpendHistory, type SpendBySession } from "../spend-rate";

/** One session on the board, at this cost. The rate is per-session since #987;
 *  these #821 cases are about the window and the arithmetic over it, so one
 *  session present throughout is the simplest board that exercises them. */
const one = (cost: number): SpendBySession => new Map([["S1", { cost }]]);

/** A board that spends `perMin` dollars a minute, sampled every second. */
function run(perMin: number, minutes: number, start = 0): { h: SpendHistory; t: number; cost: number } {
  let h = NO_SPEND_HISTORY;
  let t = start, cost = 0;
  for (let s = 0; s <= minutes * 60; s++) {
    t = start + s * 1000;
    cost = perMin * (s / 60);
    h = recordSpend(h, t, one(cost));
  }
  return { h, t, cost };
}

describe("spend over a trailing window (#821)", () => {
  it("reads the board's rise per minute", () => {
    const { h, t, cost } = run(2.4, 5);
    const r = spendRate(h, t, one(cost))!;
    expect(r.spent / (r.spanSec / 60)).toBeCloseTo(2.4, 5);
    expect(r.spanMin).toBe(5);
  });

  it("looks back ten minutes and no further", () => {
    const { h, t } = run(1, 30);
    expect(t - h.samples[0].t).toBeLessThanOrEqual(SPEND_WINDOW_MS);
    expect(spendRate(h, t, one(30))!.spanMin).toBe(10);
  });

  it("says nothing for the first minute, and nothing for a board that spent nothing", () => {
    const early = run(3, 0.5);
    expect(spendRate(early.h, early.t, one(early.cost))).toBeNull();
    const idle = run(0, 5);
    expect(spendRate(idle.h, idle.t, one(idle.cost))).toBeNull();
  });

  it("does not read a prune as a refund — and no longer loses the window to one", () => {
    // WHAT THIS USED TO ASSERT, and why it changed. The rate was the rise of a
    // single board-wide total, so a session leaving made that total fall and the
    // only available repair was to throw the window away:
    //
    //   expect(after).toEqual([{ t: before.t + 1000, cost: before.cost - 5 }]);
    //   expect(spendRate(after, …)).toBeNull();
    //
    // Per-session (#987) the fall cannot happen: a session that has left is not
    // in `now`, so it contributes nothing and drags nothing down. The board's
    // ten honest minutes survive the eviction that used to erase them — which
    // matters, because pruneDoneSessions evicts a finished session about two
    // minutes after it ends, on every board, all day.
    // Five minutes, so the ten-minute window trims nothing and the sample count
    // is the only thing under test. A spends $0.10 every five seconds; B sits
    // at $5 and spends nothing further.
    let h = NO_SPEND_HISTORY, t = 0;
    for (let i = 0; i <= 60; i++) { h = recordSpend(h, t, new Map([["A", { cost: i * 0.1 }], ["B", { cost: 5 }]])); t += 5_000; }
    expect(h.samples.length).toBe(61);
    const onlyA: SpendBySession = new Map([["A", { cost: 6 }]]);
    const after = recordSpend(h, t, onlyA);
    expect(after.samples.length, "the window was thrown away when B left").toBe(62);
    // A's own $6.00, and not a cent of B's departure in either direction.
    expect(spendRate(after, t, onlyA)!.spent).toBeCloseTo(6, 5);
  });

  it("does not read a correction as spend — per session, and per elapsed sample", () => {
    // Measured on the live deck before the original guard: $883/min, from the
    // board filling in rather than from anybody spending. That guard reset the
    // whole window; this one drops the one session's implausible rise and keeps
    // everything else, so one session's correction no longer erases the rate
    // every other session on the board honestly earned.
    let h = NO_SPEND_HISTORY, t = 0;
    for (let i = 0; i <= 60; i++) { h = recordSpend(h, t, new Map([["A", { cost: i * 0.1 }], ["B", { cost: 1 }]])); t += 5_000; }
    const leap: SpendBySession = new Map([["A", { cost: 6.1 }], ["B", { cost: 501 }]]);
    const after = recordSpend(h, t, leap);
    // A's $6.10 counted in full; B's $500 in five seconds did not, and the
    // samples A earned are all still there.
    expect(spendRate(after, t, leap)!.spent).toBeCloseTo(6.1, 5);
    expect(after.samples.length).toBe(62);
  });

  it("scales that ceiling with the gap, so a backgrounded tab loses nothing", () => {
    // The threshold is a RATE — its own comment calls it "$240 a minute" — and
    // two samples are five seconds apart only while the tab is in front. A
    // throttled or suspended tab comes back minutes later, and a flat ceiling
    // would throw away every dollar spent while somebody looked elsewhere.
    let h = NO_SPEND_HISTORY;
    h = recordSpend(h, 0, one(0));
    h = recordSpend(h, 5 * 60_000, one(100));   // five minutes away, $100 spent
    const r = spendRate(h, 5 * 60_000, one(100))!;
    expect(r.spent).toBeCloseTo(100, 5);
    // Still absurd, still refused: $6,000 across the same five minutes.
    let g = NO_SPEND_HISTORY;
    g = recordSpend(g, 0, one(0));
    g = recordSpend(g, 5 * 60_000, one(6_000));
    expect(spendRate(g, 5 * 60_000, one(6_000))).toBeNull();
  });

  it("keeps the sample list short however often the panel recomputes", () => {
    // Four recomputes a second for ten minutes.
    let h = NO_SPEND_HISTORY;
    for (let i = 0; i < 4 * 600; i++) h = recordSpend(h, i * 250, one(i * 0.001));
    expect(h.samples.length).toBeLessThanOrEqual(121);
  });
});

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("the usage header's pill (#821)", () => {
  const panel = read("../components/UsagePanel.tsx");
  const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

  it("no longer divides live agents' cost by the longest one's age", () => {
    expect(panel).not.toMatch(/liveCost|liveSec/);
    expect(panel).toMatch(/recordSpend\(spendSamples\.current, now, bySession\)/);
  });

  it("counts only from the moment the replay landed, and starts again on each one", () => {
    const app = read("../App.tsx");
    expect(app).toMatch(/es\.addEventListener\("replay-end", \(\) => \{[\s\S]*?setLiveSince\(Date\.now\(\)\);/);
    expect(app).toMatch(/es\.addEventListener\("error", \(\) => \{ setLive\(false\); setLiveSince\(null\); \}\);/);
    expect(app).toMatch(/liveSince=\{liveSince\}/);
    expect(panel).toMatch(/if \(spendSince\.current !== liveSince\) \{[\s\S]*?spendSamples\.current = NO_SPEND_HISTORY;/);
    expect(panel).toMatch(/const rate = liveSince == null \? null : spendRate\(/);
  });

  it("says the span it measured, beside the figure and in its title", () => {
    expect(panel).toMatch(/title=\{`Spend on this board over the last \$\{burnRate\.spanMin\} min`\}/);
    expect(panel).toMatch(/<span className="up-rate-span"> · \{burnRate\.spanMin\} min<\/span>/);
  });

  it("is not painted in the colour that means running", () => {
    // The primary tier: the panel's headline figure. --text-secondary is for
    // prose (text-tiers.test.ts), which a rate is not.
    const rule = /^\.up-rate\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
    expect(rule).not.toMatch(/--inflight/);
    expect(rule).toMatch(/color:\s*var\(--text\);/);
  });
});
