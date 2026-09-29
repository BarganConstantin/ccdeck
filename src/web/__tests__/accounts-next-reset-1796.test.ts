// #1796: the accounts report's "Next reset" grouped the resets in one pass
// over the rows, so which account it named and how many "+N" it counted
// depended on the order the panel listed them in — the live account first.
// A sooner reset more than a minute ahead replaced the group and forgot the
// accounts already counted within a minute of it; one less than a minute
// ahead only bumped the count and never became the one named.
//
// What these pin: the soonest reset is named, with its reading, and "more"
// counts every other account back within the same minute of it, whatever the
// row order.
import { describe, expect, it } from "vitest";
import type { Account } from "../claude-accounts";
import { usageReport } from "../accounts-usage-report";

const NOW = 1_790_000_000;

function acct(num: number, inSec: number): Account {
  return {
    num, email: `a${num}@x`, alias: null, org: null, active: false, disabled: false,
    lanes: [
      { id: "five_hour", label: "5h", pct: 50, resetAt: NOW + inSec },
      { id: "seven_day", label: "7d", pct: 10, resetAt: NOW + 70 * 3600 },
    ],
    headroom: null, fetchedAt: (NOW - 60) * 1000, nextAt: null, stale: false, error: null,
  };
}

const next = (accounts: Account[]) => usageReport(accounts, NOW).windows[0].nextReset;

describe("the next reset, whatever the row order", () => {
  it("counts an account back within the minute after the soonest, listed before it", () => {
    const soonest = { at: NOW + 30, name: "a3@x", pct: 50, more: 1 };
    expect(next([acct(1, 100), acct(2, 60), acct(3, 30)])).toEqual(soonest);
    expect(next([acct(3, 30), acct(2, 60), acct(1, 100)])).toEqual(soonest);
  });

  it("names the sooner of two resets less than a minute apart", () => {
    const soonest = { at: NOW + 45, name: "a2@x", pct: 50, more: 1 };
    expect(next([acct(1, 100), acct(2, 45)])).toEqual(soonest);
    expect(next([acct(2, 45), acct(1, 100)])).toEqual(soonest);
  });

  it("gives every order of the same accounts the same answer", () => {
    const accounts = [acct(1, 100), acct(2, 45), acct(3, 170), acct(4, 104), acct(5, 400)];
    const want = { at: NOW + 45, name: "a2@x", pct: 50, more: 2 };
    const orders = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [3, 2, 1, 4, 0]];
    for (const o of orders) expect(next(o.map(i => accounts[i]))).toEqual(want);
  });
});
