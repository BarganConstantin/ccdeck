// What the Account capacity report's cells tell a screen reader about a
// reading that is not current.
//
// Every such cell ended in a hidden ", not counted". That was the rule of
// #1707, when the windows' totals took only current readings. #1713 changed
// the totals — every account with a number is in them, an old reading at its
// last value and a window that has reset as unused — and the cells kept the
// old sentence. So a stale reading of 33% was announced "33%, not counted"
// while the card above added that 33% into its average.
//
// The only reading the totals leave out is one that does not exist: a window
// never read. A login no switch gets past is left out of the accounts READY,
// by its row's state, but its numbers are in the windows' totals like any
// other old reading — and a cell is a window's column, so that is the total it
// speaks for.
//
// What these pin: a cell says what the total above it does with its number —
// a stale or login-blocked reading is its last one, counted as it is; a window
// that has reset says when and at what it was read (#2093); a window never read
// says it is not counted — and every one of them is dimmed, so the eye sees the
// same "not a current reading" the words say, while a current one is not.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { usageReport } from "../accounts-usage-report";
import { UsageReportBody } from "../components/AccountsUsageReport";

const NOW = 1_790_000_000;
const MIN = 60;
const HOUR = 3600;

function acct(five: number | null, over: Partial<Account> = {}, fiveReset = NOW + 2 * HOUR): Account {
  return {
    num: 1, email: "reader@example.com", alias: null, org: null, active: false, disabled: false,
    lanes: [
      ...(five == null ? [] : [{ id: "five_hour", label: "5h", pct: five, resetAt: fiveReset }]),
      { id: "seven_day", label: "7d", pct: 20, resetAt: NOW + 70 * HOUR },
    ],
    headroom: null, fetchedAt: (NOW - 4 * MIN) * 1000, nextAt: null, stale: false, error: null, ...over,
  };
}

/** The 5h cell, as markup. */
const fiveCell = (a: Account) =>
  /<td class="ap-report-cell"[^]*?<\/td>/.exec(
    renderToStaticMarkup(createElement(UsageReportBody, { accounts: [a], nowSec: NOW, held: null })),
  )?.[0] ?? "";

/** What a screen reader hears of a cell: everything but what is hidden from it. */
const heard = (cell: string) => cell
  .replace(/<span aria-hidden="true">[^<]*<\/span>/g, "")
  .replace(/<[^>]+>/g, "").trim();

const stale = acct(33, { stale: true, fetchedAt: (NOW - HOUR) * 1000 });
const reset = acct(96, { stale: true, fetchedAt: (NOW - 18 * HOUR) * 1000 }, NOW - 15 * HOUR);
const neverRead = acct(null);
const loginBlocked = acct(40, { error: "invalid_grant", alive: false } as Partial<Account>);
const loginNeverRead = acct(null, { error: "invalid_grant", alive: false } as Partial<Account>);

describe("what a capacity cell that is not current says to a screen reader", () => {
  it("says a stale reading is its last one, counted as it is", () => {
    expect(heard(fiveCell(stale))).toBe("33%, last reading, counted as is");
    // Which is what the card does with it.
    expect(usageReport([stale], NOW).windows[0].used).toBe(33);
  });

  it("says a login-blocked reading is its last one, counted as it is", () => {
    expect(heard(fiveCell(loginBlocked))).toBe("40%, last reading, counted as is");
    const r = usageReport([loginBlocked], NOW);
    expect(r.windows[0].used).toBe(40);
    // What leaves it out is the count of accounts ready, and the row says why.
    expect(r.rows[0].status).toBe("stale");
    expect(r.roomInBoth).toBe(0);
  });

  it("says when a reset window reset and what it read, as #2093 does", () => {
    expect(heard(fiveCell(reset))).toBe("Reset 15h ago, 96% when read 18h ago");
    expect(usageReport([reset], NOW).windows[0].used).toBe(0);
  });

  it("says a window never read is not counted", () => {
    expect(heard(fiveCell(neverRead))).toBe("no reading, not counted");
    expect(heard(fiveCell(loginNeverRead))).toBe("no reading, not counted");
    expect(usageReport([neverRead], NOW).windows[0]).toMatchObject({ included: 0, used: null });
  });

  it("dims every reading that is not current, and only those", () => {
    for (const a of [stale, loginBlocked, reset, neverRead]) {
      expect(fiveCell(a), heard(fiveCell(a))).toMatch(/^<td class="ap-report-cell" data-uncounted=""/);
    }
    const current = fiveCell(acct(33));
    expect(current).not.toContain("data-uncounted");
    expect(heard(current)).toMatch(/^33%resets in /);
  });
});
