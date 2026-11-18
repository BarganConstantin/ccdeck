// The Account capacity report's rows can be ordered by any column: a press on
// its name orders them, and a second press turns the order round. What these
// pin: the first press is always ascending — A to Z, the least used, Ready,
// the newest reading — because that is the order a reader looks for room in;
// a row with no number for the column goes last whichever way it points;
// ties keep the panel's order in both directions, so equal rows never swap on
// a press or a poll; and the header says which column and which way, once, in
// aria-sort.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { nextReportSort, sortReportRows, usageReport, type ReportSort } from "../accounts-usage-report";
import { UsageReportBody } from "../components/AccountsUsageReport";
import { sourceOf } from "./client-source";

const NOW = 1_790_000_000;
const HOUR = 3600;

function acct(num: number, email: string, p5: number | null, p7: number | null, over: Partial<Account> = {}): Account {
  const lanes = [
    ...(p5 == null ? [] : [{ id: "five_hour", label: "5h", pct: p5, resetAt: NOW + 2 * HOUR }]),
    ...(p7 == null ? [] : [{ id: "seven_day", label: "7d", pct: p7, resetAt: NOW + 70 * HOUR }]),
  ];
  return {
    num, email, alias: null, org: null, active: false, disabled: false, lanes,
    fetchedAt: NOW * 1000, ...over,
  } as unknown as Account;
}

const PANEL = [
  acct(1, "composer@x.io", 65, 45),
  acct(2, "example2@x.io", 0, 83),
  acct(3, "claude4@x.io", 92, 24),
  acct(4, "captain@x.io", 0, 100),
  acct(5, "never@x.io", null, null, { fetchedAt: null } as Partial<Account>),
];

const rowsOf = (sort: ReportSort | null) =>
  sortReportRows(usageReport(PANEL, NOW).rows, sort).map(r => r.name.split("@")[0]);

describe("what a press on a column header does", () => {
  it("orders by a column you were not on, ascending", () => {
    expect(nextReportSort(null, "five_hour")).toEqual({ key: "five_hour", dir: "asc" });
    expect(nextReportSort({ key: "account", dir: "desc" }, "status")).toEqual({ key: "status", dir: "asc" });
  });

  it("turns the order round on the column you are on", () => {
    expect(nextReportSort({ key: "five_hour", dir: "asc" }, "five_hour")).toEqual({ key: "five_hour", dir: "desc" });
    expect(nextReportSort({ key: "five_hour", dir: "desc" }, "five_hour")).toEqual({ key: "five_hour", dir: "asc" });
  });
});

describe("the rows in a column's order", () => {
  it("keeps the panel's order until a column is pressed", () => {
    expect(rowsOf(null)).toEqual(["composer", "example2", "claude4", "captain", "never"]);
  });

  it("puts the least used first, and the most used first when turned round", () => {
    expect(rowsOf({ key: "five_hour", dir: "asc" })).toEqual(["example2", "captain", "composer", "claude4", "never"]);
    expect(rowsOf({ key: "five_hour", dir: "desc" })).toEqual(["claude4", "composer", "example2", "captain", "never"]);
  });

  it("puts a row with no reading for the column last, whichever way it points", () => {
    expect(rowsOf({ key: "seven_day", dir: "asc" }).at(-1)).toBe("never");
    expect(rowsOf({ key: "seven_day", dir: "desc" }).at(-1)).toBe("never");
  });

  it("keeps the panel's order between equal rows in both directions", () => {
    // example2 and captain are both at 0% of 5h: example2 stands first in the panel.
    const asc = rowsOf({ key: "five_hour", dir: "asc" });
    const desc = rowsOf({ key: "five_hour", dir: "desc" });
    expect(asc.indexOf("example2")).toBeLessThan(asc.indexOf("captain"));
    expect(desc.indexOf("example2")).toBeLessThan(desc.indexOf("captain"));
  });

  it("orders names A to Z, ignoring case", () => {
    const rows = sortReportRows(usageReport([acct(1, "b@x.io", 1, 1), acct(2, "A@x.io", 1, 1), acct(3, "c@x.io", 1, 1)], NOW).rows,
      { key: "account", dir: "asc" });
    expect(rows.map(r => r.name)).toEqual(["A@x.io", "b@x.io", "c@x.io"]);
  });

  it("puts Ready first, then Limited, then Stale", () => {
    expect(rowsOf({ key: "status", dir: "asc" })).toEqual(["composer", "example2", "claude4", "captain", "never"]);
    expect(rowsOf({ key: "status", dir: "desc" })).toEqual(["never", "captain", "composer", "example2", "claude4"]);
  });

  // CHANGED ON PURPOSE (V4's Figma): the table has no Updated column, so there
  // is no "newest reading first" to press. What a reader sorts by is the four
  // headers; the age of a reading is a line under the state. A sort that still
  // carries a key from an older build (the age, or a window's reset, which is
  // the Reset calendar's to answer) is read as no sort at all.
  it("reads a sort by a column the table no longer has as the panel's order, and never throws", () => {
    const old = acct(6, "old@x.io", 10, 10, { fetchedAt: (NOW - 2 * HOUR) * 1000 } as Partial<Account>);
    const rows = usageReport([old, ...PANEL], NOW).rows;
    const panel = rows.map(r => r.num);
    for (const key of ["updated", "five_hour_reset", "seven_day_reset", "nonsense"]) {
      for (const dir of ["asc", "desc"] as const) {
        const sorted = sortReportRows(rows, { key, dir } as unknown as ReportSort);
        expect(sorted.map(r => r.num), `${key} ${dir}`).toEqual(panel);
      }
    }
    // A sort that is still a column is still a sort, so the fallback is not
    // simply "never sorts".
    expect(sortReportRows(rows, { key: "five_hour", dir: "asc" }).map(r => r.num)).not.toEqual(panel);
  });

  it("offers only the four columns to press", () => {
    const keys = ["account", "status", "five_hour", "seven_day"] as const;
    for (const key of keys) expect(nextReportSort(null, key)).toEqual({ key, dir: "asc" });
  });
});

describe("the header of the column the rows are ordered by", () => {
  it("says which column and which way, in aria-sort, and points the arrow the same way", () => {
    const out = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: PANEL, nowSec: NOW, held: null, sort: { key: "seven_day", dir: "desc" }, onSort: () => {},
    }));
    // CHANGED ON PURPOSE (V4's Figma): four columns, named as the frame names
    // them, and no reset or age column among them.
    expect(out).toContain('<th scope="col" aria-sort="descending"><button type="button" class="sd-sort" title="Sort by 7-day window">7-day window<span class="sd-sort-dir" aria-hidden="true">↓</span></button></th>');
    expect(out.match(/aria-sort="none"/g)).toHaveLength(3);
    expect(out.match(/<th scope="col"/g)).toHaveLength(4);
    const head = out.slice(out.indexOf("<thead"), out.indexOf("</thead>"));
    expect([...head.matchAll(/class="sd-sort" title="Sort by ([^"]*)"/g)].map(m => m[1])).toEqual(["Account", "State", "5-hour window", "7-day window"]);
    expect(out).not.toMatch(/Sort by (?:5h|7d|Updated|[^"]*reset)/i);
  });

  it("is held in the dialog, not in storage: the report opens in the panel's order every time", () => {
    const modal = sourceOf("components/AccountsUsageReport.tsx");
    expect(modal).toContain("useState<{ sort: ReportSort; order: string[] } | null>(null)");
    expect(modal).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("dedicated reset columns", () => {
  const withResets = (num: number, five: number | null, seven: number | null, over: Partial<Account> = {}) =>
    acct(num, `account${num}@x.io`, 20, 30, {
      lanes: [
        { id: "five_hour", label: "5h", pct: 20, resetAt: five },
        { id: "seven_day", label: "7d", pct: 30, resetAt: seven },
      ], ...over,
    });

  // CHANGED ON PURPOSE (V4's Figma): the two tests that sorted the rows by a
  // window's reset (by seconds, and with missing and invalid times last) are
  // gone with the sort: when a window resets is the Reset calendar's to answer,
  // and the table has no reset column to press. What is kept of them is that the
  // recorded times of a stale, expired-login or already-reset window are still
  // read (they are the line under the figure), and that those rows keep their
  // states.
  it("retains recorded times for stale, expired-login and already-reset windows", () => {
    const accounts = [
      withResets(1, NOW + 120, NOW + 7200, { stale: true }),
      withResets(2, NOW + 60, NOW + 3600, { error: "invalid_grant", alive: false }),
      withResets(3, NOW - 60, NOW - 120),
    ];
    const rows = usageReport(accounts, NOW).rows;
    expect(rows.map(r => r.resets)).toEqual([
      { five_hour: NOW + 120, seven_day: NOW + 7200 },
      { five_hour: NOW + 60, seven_day: NOW + 3600 },
      { five_hour: NOW - 60, seven_day: NOW - 120 },
    ]);
    expect(rows[0].status).toBe("ready");
    expect(rows[1].status).toBe("stale");
    expect(rows[2].cells.five_hour).toMatchObject({ counted: false, why: "reset", estimate: rows[2].cells.five_hour.last });
  });

  it("draws four columns, and no column of resets or ages to press", () => {
    const out = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: [withResets(1, NOW + 120, NOW + 86400, { active: true })], nowSec: NOW, held: null, sort: { key: "five_hour", dir: "asc" },
    }));
    expect(out).toContain('<th scope="col" aria-sort="ascending"><button type="button" class="sd-sort" title="Sort by 5-hour window">5-hour window');
    expect(out.match(/aria-sort="none"/g)).toHaveLength(3);
    // The state, then the two windows, each with its figure and its own line.
    const cells = [...out.matchAll(/<td class="ap-report-(?:state|cell)"/g)];
    expect(cells).toHaveLength(3);
    expect(out).not.toContain("ap-report-reset-cell");
    expect(out).toContain('class="ap-report-current">Current');
    expect(out).toContain('role="region" aria-label="Account capacity table"');
  });

  it("says a passed reset is due, and leaves a window with no recorded reset without a line", () => {
    const out = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: [withResets(1, null, NOW - 60)], nowSec: NOW, held: null,
    }));
    // CHANGED ON PURPOSE (V4's Figma): the dash and its words were the reset
    // column's; now a missing reset is only words for a screen reader, with no
    // line drawn, and a passed one is the cell's second line.
    expect(out).toContain('<span class="vis-hidden" data-sub="">No reset time</span>');
    expect(out).toContain("Reset due · awaiting read</time>");
    expect(out).toContain(`dateTime="${new Date((NOW - 60) * 1000).toISOString()}"`);
  });
});
