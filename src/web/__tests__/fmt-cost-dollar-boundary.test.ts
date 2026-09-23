// fmtCost renders sub-dollar totals in cents, but the cents string is rounded
// before it is printed, so for totals in [0.995, 1) the rounding carried into
// three digits and the chip read "100¢" — a unit that does not exist. The
// number is user-visible on agent cards, the session summary, the session list
// and every burn-rate chip, so the cents branch has to hand off to the dollar
// branch whenever rounding reaches a full dollar.
import { describe, it, expect } from "vitest";
import { fmtCost, fmtCostRate } from "../pricing";

describe("fmtCost never prints a three-digit cents value", () => {
  it("renders dollars for totals that round up to a full dollar", () => {
    expect(fmtCost(0.996)).toBe("$1.00");
    expect(fmtCost(0.999)).toBe("$1.00");
    expect(fmtCost(0.9999)).toBe("$1.00");
  });

  it("keeps printing cents right below the carry", () => {
    expect(fmtCost(0.99)).toBe("99¢");
    expect(fmtCost(0.994)).toBe("99¢");
  });

  it("holds across the whole sub-dollar range", () => {
    // Every hundredth of a cent from 0.01¢ to 99.99¢: whenever the result is
    // a cents value it must be under 100, and it must otherwise be dollars.
    //
    // The second clause used to go unasserted, and the first one could go
    // unrun (#654). The only expect() in this loop sat inside
    // `if (rendered.endsWith("¢") && rendered !== "<1¢")` — a condition on the
    // very output under test, which means a regression in that output can make
    // it false for all 9,999 inputs and take the sweep down with it. Making the
    // cents branch unreachable does exactly that: the assertion count goes from
    // 9,900 to zero and this case still reports green, having checked nothing
    // about the thing it is named for. (The neighbouring spot checks catch that
    // particular edit, which is not the same as this case doing its job: they
    // pin eight points and this one exists for the other 9,991.)
    //
    // So every input is now classified and judged on whichever side it lands,
    // and the verdict and the tallies are asserted outside the loop, where a
    // class that has emptied is a failure rather than a silent skip — the floor
    // #648 put outside two other quantifications, in the form this one takes.
    let sub = 0, cents = 0;
    const dollars = new Map<string, number>();
    const wrong: string[] = [];
    for (let i = 1; i < 10_000; i++) {
      const usd = i / 10_000;
      const rendered = fmtCost(usd);
      if (rendered === "<1¢") {
        sub++;
      } else if (rendered.endsWith("¢")) {
        cents++;
        if (!(Number(rendered.slice(0, -1)) < 100)) wrong.push(`fmtCost(${usd}) = ${rendered}`);
      } else {
        // "must otherwise be dollars" — the clause that was never asserted at
        // all. Every input that leaves the cents branch has to arrive as a
        // well-formed dollar figure, so "100¢" reached by some other route, a
        // bare number or an empty string is caught here rather than falling out
        // of the sweep unexamined.
        dollars.set(rendered, (dollars.get(rendered) ?? 0) + 1);
        if (!/^\$\d+\.\d\d$/.test(rendered)) wrong.push(`fmtCost(${usd}) = ${rendered}`);
      }
    }
    // Collected and asserted whole, the way #648's HALF_WIDGETS is: one
    // unconditional expect() outside the sweep names every input that broke the
    // rule rather than the first, and 10,000 expect() calls carrying a
    // per-input message cost four times the runtime of the case they explain.
    expect(wrong).toEqual([]);
    // Where the boundaries fall, stated as counts because a count is the one
    // thing an empty class cannot fake. 49 hundredths of a cent below the <1¢
    // threshold (0.0001 … 0.0049), 9,900 printed in cents, and 50 at the top
    // that leave the cents branch (0.9950 … 0.9999). Widening the <1¢
    // threshold, moving the carry, or making either branch unreachable moves
    // one of these and names itself.
    expect({ sub, cents }).toEqual({ sub: 49, cents: 9_900 });
    // The top band spelled out, because 0.9950 is the one input in it that does
    // not print the carry: `(0.995 * 100).toFixed(0)` rounds up to "100" and
    // hands off to the dollar branch, while `(0.995).toFixed(2)` rounds the same
    // double back down — the nearest double to 0.995 is 0.99499999999999999556,
    // and the multiply lands on 99.5 while the direct rounding does not. A
    // dollar figure half a cent light is a rounding choice one can argue with;
    // "100¢" was a unit that does not exist, which is the one this file is for.
    expect(Object.fromEntries(dollars)).toEqual({ "$1.00": 49, "$0.99": 1 });
  });

  it("leaves the other formatting branches untouched", () => {
    expect(fmtCost(0)).toBe("—");
    expect(fmtCost(-1)).toBe("—");
    expect(fmtCost(0.0049)).toBe("<1¢");
    expect(fmtCost(0.0995)).toBe("10.0¢");  // the parallel 10¢ carry is valid
    expect(fmtCost(0.1)).toBe("10¢");
    expect(fmtCost(1)).toBe("$1.00");
    expect(fmtCost(42.5)).toBe("$42.50");
    expect(fmtCost(100)).toBe("$100");
    expect(fmtCost(12_345)).toBe("$12.3k");
  });
});

describe("the burn-rate chip inherits the fix", () => {
  it("prints dollars per minute rather than 100¢/min", () => {
    // $0.998 of cost over exactly one minute of activity.
    expect(fmtCostRate(0.998, 60)).toBe("$1.00/min");
  });
});

// ── THE REST OF fmtCostRate, WHICH NOTHING HAD EVER RUN (#994) ──────────────
//
// `grep -rn fmtCostRate src/web/__tests__/` returned two files before this
// block. One of them greps AgentNode.tsx as source text and never calls the
// function; the other is the case directly above, and it exercises the `/min`
// branch. So of the four outcomes this function has — two null guards, `/min`,
// `/hr` — exactly one had ever been evaluated by the suite.
//
// It is the burn-rate chip on every active card, in the detail rail and in the
// usage panel, and both untested halves fail QUIETLY. Break the `* 3600` and a
// cheap long session gets a confident wrong dollars-per-hour that no reader has
// an intuition to check against. Break the `elapsedSec < 10` guard and a session
// two seconds old divides a real cost by a near-zero denominator and prints the
// result as a rate.
describe("fmtCostRate over a long cheap session, and where it refuses", () => {
  it("switches to an hourly rate when the per-minute figure drops under a cent", () => {
    // $0.30 over two hours. Per minute that is a quarter of a cent — which
    // `fmtCost` would render "<1¢", a chip that says nothing — so the scale
    // moves up and the same rate is 15¢ an hour. The `* 3600` is the whole of
    // that conversion and this is the only case that evaluates it.
    expect(fmtCostRate(0.30, 7200)).toBe("15¢/hr");
    // An agentic session left running overnight: $2 over eight hours.
    expect(fmtCostRate(2, 8 * 3600)).toBe("25¢/hr");
  });

  it("changes unit at one cent a minute and not somewhere either side of it", () => {
    // $1.00 over 6000s is exactly 1¢/min, the first value the minute scale can
    // print — and it prints with the tenth `fmtCost` gives everything under
    // 10¢, so "1.0¢/min" and not "1¢/min". A hair under it belongs to the hour
    // scale, and the two readings are the same rate: 0.99¢/min is 59¢/hr.
    expect(fmtCostRate(1, 6000)).toBe("1.0¢/min");
    expect(fmtCostRate(0.99, 6000)).toBe("59¢/hr");
  });

  it("says nothing at all rather than dividing by a window too short to mean anything", () => {
    // Nine seconds is inside the guard, ten is the first second outside it.
    // Without the guard the chip lights up on the first tool call of a session
    // with whatever $0.50/9s works out to, which is a number about the sampling
    // window and not about the session.
    expect(fmtCostRate(0.5, 9)).toBeNull();
    expect(fmtCostRate(0.5, 10)).toBe("$3.00/min");
    expect(fmtCostRate(0.5, 0)).toBeNull();
  });

  it("says nothing for a session that has not cost anything", () => {
    // Zero and negative both. `fmtCost(0)` is "—", so without this guard the
    // chip would read "—/min", which is a rate for a session that has no rate.
    expect(fmtCostRate(0, 3600)).toBeNull();
    expect(fmtCostRate(-1, 3600)).toBeNull();
  });
});

// ── THE SAME CARRY AT THE TWO DOLLAR BOUNDARIES (#1173) ─────────────────────
//
// Every tier above checks the raw value and prints a rounded one, and the ¢
// branch was the only one taught that the two can disagree. $99.995 is under
// 100, so it printed with two decimals — `(99.995).toFixed(2)` is "100.00" —
// beside "$100" for the dollar after it; and $9,999.50 printed "$10000" beside
// "$10.0k". The usage headline counts up through both (count-up.ts), and a
// session's cost crosses them, so a card and the panel could print one figure
// in two formats in the same second. Checked the way the cents branch is: on
// the rounded string, handing off to the next tier when rounding reaches it.
describe("fmtCost carries into the next dollar tier the way it carries out of cents (#1173)", () => {
  it("prints $100 and $10.0k at the carry, not $100.00 and $10000", () => {
    expect(fmtCost(99.995)).toBe("$100");
    expect(fmtCost(9999.5)).toBe("$10.0k");
    // And either side of it, unchanged.
    expect(fmtCost(99.99)).toBe("$99.99");
    expect(fmtCost(9999.49)).toBe("$9999");
  });

  it("holds across both boundaries", () => {
    // [99.9, 100) by hundredths of a cent, and [9999, 10000) by cents. Collected
    // and asserted whole, like the sub-dollar sweep above, with the tallies of
    // what crossed stated as counts so an emptied class cannot pass.
    const wrong: string[] = [];
    const carried = new Map<string, number>();
    const judge = (usd: number) => {
      const out = fmtCost(usd);
      if (!/^\$\d{1,2}\.\d\d$|^\$\d{3,4}$|^\$\d+\.\dk$/.test(out) || out === "$100.00" || out === "$10000") {
        wrong.push(`fmtCost(${usd}) = ${out}`);
      }
      if (out === "$100" || out === "$10.0k") carried.set(out, (carried.get(out) ?? 0) + 1);
    };
    for (let i = 999_000; i < 1_000_000; i++) judge(i / 10_000);
    for (let i = 999_900; i < 1_000_000; i++) judge(i / 100);
    expect(wrong).toEqual([]);
    // 99.9950 … 99.9999 and 9999.50 … 9999.99: fifty inputs each, the half of
    // the last step that rounds up.
    expect(Object.fromEntries(carried)).toEqual({ "$100": 50, "$10.0k": 50 });
  });
});
