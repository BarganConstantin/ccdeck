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
  acct(1, "dcorovin@x.io", 65, 45),
  acct(2, "sapec2@x.io", 0, 83),
  acct(3, "claude4@x.io", 92, 24),
  acct(4, "cbargan@x.io", 0, 100),
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
    expect(rowsOf(null)).toEqual(["dcorovin", "sapec2", "claude4", "cbargan", "never"]);
  });

  it("puts the least used first, and the most used first when turned round", () => {
    expect(rowsOf({ key: "five_hour", dir: "asc" })).toEqual(["sapec2", "cbargan", "dcorovin", "claude4", "never"]);
    expect(rowsOf({ key: "five_hour", dir: "desc" })).toEqual(["claude4", "dcorovin", "sapec2", "cbargan", "never"]);
  });

  it("puts a row with no reading for the column last, whichever way it points", () => {
    expect(rowsOf({ key: "seven_day", dir: "asc" }).at(-1)).toBe("never");
    expect(rowsOf({ key: "seven_day", dir: "desc" }).at(-1)).toBe("never");
  });

  it("keeps the panel's order between equal rows in both directions", () => {
    // sapec2 and cbargan are both at 0% of 5h: sapec2 stands first in the panel.
    const asc = rowsOf({ key: "five_hour", dir: "asc" });
    const desc = rowsOf({ key: "five_hour", dir: "desc" });
    expect(asc.indexOf("sapec2")).toBeLessThan(asc.indexOf("cbargan"));
    expect(desc.indexOf("sapec2")).toBeLessThan(desc.indexOf("cbargan"));
  });

  it("orders names A to Z, ignoring case", () => {
    const rows = sortReportRows(usageReport([acct(1, "b@x.io", 1, 1), acct(2, "A@x.io", 1, 1), acct(3, "c@x.io", 1, 1)], NOW).rows,
      { key: "account", dir: "asc" });
    expect(rows.map(r => r.name)).toEqual(["A@x.io", "b@x.io", "c@x.io"]);
  });

  it("puts Ready first, then Limited, then Stale", () => {
    expect(rowsOf({ key: "status", dir: "asc" })).toEqual(["dcorovin", "sapec2", "claude4", "cbargan", "never"]);
    expect(rowsOf({ key: "status", dir: "desc" })).toEqual(["never", "cbargan", "dcorovin", "sapec2", "claude4"]);
  });

  it("puts the newest reading first, and a row never read last", () => {
    const old = acct(6, "old@x.io", 10, 10, { fetchedAt: (NOW - 2 * HOUR) * 1000 } as Partial<Account>);
    const rows = sortReportRows(usageReport([old, ...PANEL], NOW).rows, { key: "updated", dir: "asc" }).map(r => r.name.split("@")[0]);
    expect(rows).toEqual(["dcorovin", "sapec2", "claude4", "cbargan", "old", "never"]);
  });
});

describe("the header of the column the rows are ordered by", () => {
  it("says which column and which way, in aria-sort, and points the arrow the same way", () => {
    const out = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: PANEL, nowSec: NOW, held: null, sort: { key: "seven_day", dir: "desc" }, onSort: () => {},
    }));
    expect(out).toContain('<th scope="col" aria-sort="descending"><button type="button" class="sd-sort" title="Sort by 7d used">7d used<span class="sd-sort-dir" aria-hidden="true">↓</span></button></th>');
    expect(out.match(/aria-sort="none"/g)).toHaveLength(6);
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

  it("sorts both windows by seconds even when countdowns would round to the same text", () => {
    const rows = usageReport([
      withResets(1, NOW + 121, NOW + 4 * 86400 + 30),
      withResets(2, NOW + 120, NOW + 4 * 86400 + 10),
      withResets(3, NOW + 122, NOW + 4 * 86400 + 20),
    ], NOW).rows;
    expect(sortReportRows(rows, { key: "five_hour_reset", dir: "asc" }).map(r => r.num)).toEqual([2, 1, 3]);
    expect(sortReportRows(rows, { key: "five_hour_reset", dir: "desc" }).map(r => r.num)).toEqual([3, 1, 2]);
    expect(sortReportRows(rows, { key: "seven_day_reset", dir: "asc" }).map(r => r.num)).toEqual([2, 3, 1]);
    expect(sortReportRows(rows, { key: "seven_day_reset", dir: "desc" }).map(r => r.num)).toEqual([1, 3, 2]);
  });

  it("keeps missing and invalid timestamps last and preserves ties in both directions", () => {
    const rows = usageReport([
      withResets(1, null, null),
      withResets(2, NOW + 120, NOW + 120),
      withResets(3, NOW + 120, NOW + 120),
      withResets(4, Number.NaN, Number.POSITIVE_INFINITY),
      withResets(5, NOW + 60, NOW + 60),
    ], NOW).rows;
    for (const key of ["five_hour_reset", "seven_day_reset"] as const) {
      expect(sortReportRows(rows, { key, dir: "asc" }).map(r => r.num)).toEqual([5, 2, 3, 1, 4]);
      expect(sortReportRows(rows, { key, dir: "desc" }).map(r => r.num)).toEqual([2, 3, 5, 1, 4]);
      expect(nextReportSort(null, key)).toEqual({ key, dir: "asc" });
      expect(nextReportSort({ key, dir: "asc" }, key)).toEqual({ key, dir: "desc" });
      expect(nextReportSort({ key, dir: "desc" }, key)).toEqual({ key, dir: "asc" });
    }
    expect(rows.map(r => r.num)).toEqual([1, 2, 3, 4, 5]);
  });

  it("retains recorded times for stale, expired-login and already-reset windows", () => {
    const accounts = [
      withResets(1, NOW + 120, NOW + 7200, { stale: true }),
      withResets(2, NOW + 60, NOW + 3600, { error: "invalid_grant", alive: false }),
      withResets(3, NOW - 60, NOW - 120),
    ];
    const rows = usageReport(accounts, NOW).rows;
    expect(sortReportRows(rows, { key: "five_hour_reset", dir: "asc" }).map(r => r.num)).toEqual([3, 2, 1]);
    expect(sortReportRows(rows, { key: "seven_day_reset", dir: "desc" }).map(r => r.num)).toEqual([1, 2, 3]);
    expect(rows[0].status).toBe("ready");
    expect(rows[1].status).toBe("stale");
    expect(rows[2].cells.five_hour).toMatchObject({ counted: false, why: "reset", estimate: 0 });
  });

  it("renders reset headers as accessible sort buttons and separates usage from reset cells", () => {
    for (const key of ["five_hour_reset", "seven_day_reset"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const out = renderToStaticMarkup(createElement(UsageReportBody, {
          accounts: [withResets(1, NOW + 120, NOW + 86400, { active: true })], nowSec: NOW, held: null, sort: { key, dir },
        }));
        const label = key === "five_hour_reset" ? "5h reset" : "7d reset";
        expect(out).toContain(`<th scope="col" aria-sort="${dir === "asc" ? "ascending" : "descending"}"><button type="button" class="sd-sort" title="Sort by ${label}">${label}`);
        expect(out.match(/aria-sort="none"/g)).toHaveLength(6);
        const used = [...out.matchAll(/<td class="ap-report-cell"[^>]*>(.*?)<\/td>/g)].map(m => m[1]);
        expect(used).toEqual(['<span class="ap-report-pct">20%</span>', '<span class="ap-report-pct">30%</span>']);
        expect(out.match(/class="ap-report-reset-cell"/g)).toHaveLength(2);
        expect(out).toContain('class="ap-report-current">Current');
        expect(out).toContain('role="region" aria-label="Account capacity table"');
      }
    }
  });

  it("distinguishes missing resets from passed resets without inventing a countdown", () => {
    const out = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: [withResets(1, null, NOW - 60)], nowSec: NOW, held: null,
    }));
    expect(out).toContain('<span aria-hidden="true">—</span><span class="vis-hidden">No reset time</span>');
    expect(out).toContain('<span class="vis-hidden">reset already </span>passed</time>');
    expect(out).toContain(`dateTime="${new Date((NOW - 60) * 1000).toISOString()}"`);
  });
});
