// #821: the usage header's $/min swung eightfold with which agents were live.
//
// It divided the live agents' cost by the longest-running one's age, so a tab
// left open read $2.39/min and a fresh tab of the same deck $19.49/min. It is
// the board total's rise over a trailing ten-minute window now, labelled with
// the span it measured, in a neutral colour. spend-rate.ts carries the rule.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordSpend, spendRate, SPEND_WINDOW_MS, type SpendSample } from "../spend-rate";

const MIN = 60_000;

/** A board that spends `perMin` dollars a minute, sampled every second. */
function run(perMin: number, minutes: number, start = 0): { samples: SpendSample[]; t: number; cost: number } {
  let samples: SpendSample[] = [];
  let t = start, cost = 0;
  for (let s = 0; s <= minutes * 60; s++) {
    t = start + s * 1000;
    cost = perMin * (s / 60);
    samples = recordSpend(samples, t, cost);
  }
  return { samples, t, cost };
}

describe("spend over a trailing window (#821)", () => {
  it("reads the board's rise per minute", () => {
    const { samples, t, cost } = run(2.4, 5);
    const r = spendRate(samples, t, cost)!;
    expect(r.spent / (r.spanSec / 60)).toBeCloseTo(2.4, 5);
    expect(r.spanMin).toBe(5);
  });

  it("looks back ten minutes and no further", () => {
    const { samples, t } = run(1, 30);
    expect(t - samples[0].t).toBeLessThanOrEqual(SPEND_WINDOW_MS);
    expect(spendRate(samples, t, 30)!.spanMin).toBe(10);
  });

  it("says nothing for the first minute, and nothing for a board that spent nothing", () => {
    const early = run(3, 0.5);
    expect(spendRate(early.samples, early.t, early.cost)).toBeNull();
    const idle = run(0, 5);
    expect(spendRate(idle.samples, idle.t, idle.cost)).toBeNull();
  });

  it("starts again when the total drops, instead of reading a prune as a refund", () => {
    const before = run(2, 5);
    const after = recordSpend(before.samples, before.t + 1000, before.cost - 5);
    expect(after).toEqual([{ t: before.t + 1000, cost: before.cost - 5 }]);
    expect(spendRate(after, before.t + 1000, before.cost - 5)).toBeNull();
  });

  it("starts again when the total leaps, instead of reading a correction as spend", () => {
    // Measured on the live deck before this guard: $883/min, from the board
    // filling in rather than from anybody spending.
    const before = run(2, 5);
    const after = recordSpend(before.samples, before.t + 1000, before.cost + 500);
    expect(after).toEqual([{ t: before.t + 1000, cost: before.cost + 500 }]);
  });

  it("keeps the sample list short however often the panel recomputes", () => {
    // Four recomputes a second for ten minutes.
    let samples: SpendSample[] = [];
    for (let i = 0; i < 4 * 600; i++) samples = recordSpend(samples, i * 250, i * 0.001);
    expect(samples.length).toBeLessThanOrEqual(121);
  });
});

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("the usage header's pill (#821)", () => {
  const panel = read("../components/UsagePanel.tsx");
  const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

  it("no longer divides live agents' cost by the longest one's age", () => {
    expect(panel).not.toMatch(/liveCost|liveSec/);
    expect(panel).toMatch(/recordSpend\(spendSamples\.current, now, board\.cost\.total\)/);
  });

  it("counts only from the moment the replay landed, and starts again on each one", () => {
    const app = read("../App.tsx");
    expect(app).toMatch(/es\.addEventListener\("replay-end", \(\) => \{[\s\S]*?setLiveSince\(Date\.now\(\)\);/);
    expect(app).toMatch(/es\.addEventListener\("error", \(\) => \{ setLive\(false\); setLiveSince\(null\); \}\);/);
    expect(app).toMatch(/liveSince=\{liveSince\}/);
    expect(panel).toMatch(/if \(spendSince\.current !== liveSince\) \{[\s\S]*?spendSamples\.current = \[\];/);
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
