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
