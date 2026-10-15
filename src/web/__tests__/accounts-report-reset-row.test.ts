// A passed provider time is not a confirmed renewal. Keep last usage, mark
// uncertainty, and make the table and aggregate use the same observation.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { freshness, readingOf, sortReportRows, usageReport, usedAndAvailable } from "../accounts-usage-report";
import { UsageReportBody } from "../components/AccountsUsageReport";

const NOW = 1_790_000_000;
const MIN = 60;
const HOUR = 3600;

function acct(num: number, five: [number, number], seven: [number, number], over: Partial<Account> = {}): Account {
  return {
    num, email: `account${num}@example.com`, alias: null, org: null, active: false, disabled: false,
    lanes: [
      { id: "five_hour", label: "5h", pct: five[0], resetAt: five[1] },
      { id: "seven_day", label: "7d", pct: seven[0], resetAt: seven[1] },
    ],
    headroom: null, fetchedAt: (NOW - 4 * MIN) * 1000, nextAt: null, stale: false, error: null, ...over,
  };
}

/** The account from the report: read eighteen hours ago, and both of its
 *  windows reset since. */
const lapsedAndOld = acct(1, [96, NOW - 15 * HOUR], [84, NOW - 17 * HOUR], {
  alias: "work", stale: true, fetchedAt: (NOW - 18 * HOUR) * 1000,
});

const html = (accounts: Account[]) =>
  renderToStaticMarkup(createElement(UsageReportBody, { accounts, nowSec: NOW, held: null }));

/** Each row's two window cells, as markup, in the order they are drawn. */
const cellsOf = (out: string) => [...out.matchAll(/<td class="ap-report-cell"[^]*?<\/td>/g)].map(m => m[0]);

/** What a cell shows the eye: its markup without what only a screen reader
 *  hears, and without its tags. */
const seen = (cell: string) =>
  cell.replace(/<span class="ap-report-mobile-label"[^>]*>[^<]*<\/span>/g, "").replace(/<span class="vis-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "").trim();

describe("a reading past its reset", () => {
  it("a reading past its reset says reset in its row and retains last observed usage", () => {
    const five = readingOf(lapsedAndOld, "five_hour", NOW);
    expect(five).toMatchObject({ counted: false, why: "reset", last: 96, estimate: 96, resetAt: null });
    expect(five.counted === false && five.reset).toBe("Reported reset time passed 15h ago, 96% when read 18h ago");
    expect(readingOf(lapsedAndOld, "seven_day", NOW))
      .toMatchObject({ counted: false, why: "reset", estimate: 84, reset: "Reported reset time passed 17h ago, 84% when read 18h ago" });

    const out = html([lapsedAndOld]);
    const [cell5, cell7] = cellsOf(out);
    expect(seen(cell5)).toBe("96%");
    expect(seen(cell7)).toBe("84%");
    // Dimmed like every reading the total does not take as it stands, and the
    // facts on hover and for a screen reader.
    expect(cell5).toContain('data-uncounted=""');
    expect(cell5).toContain('title="Reported reset time passed 15h ago, 96% when read 18h ago"');
    expect(cell5).toContain('Awaiting a fresh reading, last reading, counted as is.');
    // Retain the observed value, never manufacture zero usage.
    expect(out).not.toContain("Estimated unused");

    const r = usageReport([lapsedAndOld], NOW);
    expect(r.windows.map(w => w.used)).toEqual([96, 84]);
    expect(out).toContain('<p class="ap-report-left"><b>4%</b> average remaining</p>');
    // Judged on what the total takes for it: both windows unused.
    expect(r.rows[0].status).toBe("ready");
    expect(freshness(r.rows[0], NOW)).toEqual({ text: "18h ago", old: true });
  });

  it("says reset the same way when the reading is current but its window has rolled over since", () => {
    const fresh = acct(2, [92, NOW - 4 * MIN], [30, NOW + 3 * 24 * HOUR], { fetchedAt: (NOW - 10 * MIN) * 1000 });
    const c = readingOf(fresh, "five_hour", NOW);
    expect(c).toMatchObject({ counted: false, why: "reset", last: 92, estimate: 92 });
    expect(c.counted === false && c.reset).toBe("Reported reset time passed 4m ago, 92% when read 10m ago");
    const [cell5, cell7] = cellsOf(html([fresh]));
    expect(seen(cell5)).toBe("92%");
    expect(seen(cell7)).toMatch(/^30%/);
    expect(usageReport([fresh], NOW).windows[0].used).toBe(92);
  });

  it("keeps an old reading whose window is still running at its last number, dimmed, and counts it there", () => {
    const old = acct(3, [33, NOW + 2 * HOUR], [40, NOW + 70 * HOUR], { stale: true, fetchedAt: (NOW - HOUR) * 1000 });
    const c = readingOf(old, "five_hour", NOW);
    expect(c).toMatchObject({ counted: false, why: "stale", last: 33, estimate: 33 });
    const [cell5] = cellsOf(html([old]));
    expect(seen(cell5)).toBe("33%");
    expect(cell5).toContain('data-uncounted=""');
    expect(cell5).not.toContain("title=");
    expect(usageReport([old], NOW).windows[0].used).toBe(33);
  });

  it("lets a login no switch gets past still name the row, while its reset window says reset", () => {
    const blocked = { ...lapsedAndOld, error: "invalid_grant", alive: false } as Account;
    const c = readingOf(blocked, "five_hour", NOW);
    expect(c).toMatchObject({ counted: false, why: "login", estimate: 96 });
    expect(c.counted === false && c.say).toMatch(/login expired/i);
    const r = usageReport([blocked], NOW);
    expect(r.rows[0].status).toBe("stale");
    expect(freshness(r.rows[0], NOW).text).toMatch(/login expired/i);
    // The total takes the window as unused, so the row says why: it reset.
    const out = html([blocked]);
    expect(cellsOf(out).map(seen)).toEqual(["96%", "84%"]);
    expect(out).toMatch(/<td class="ap-report-upd" data-old="">[^]*?login expired/i);
  });

  it("orders an elapsed window by its last reported usage", () => {
    const rows = usageReport([acct(4, [10, NOW + HOUR], [10, NOW + 70 * HOUR]), lapsedAndOld], NOW).rows;
    expect(sortReportRows(rows, { key: "five_hour", dir: "asc" }).map(x => x.num)).toEqual([4, 1]);
    expect(sortReportRows(rows, { key: "five_hour", dir: "desc" }).map(x => x.num)).toEqual([1, 4]);
  });
});

describe("the rows and the cards", () => {
  // The owner's twelve, anonymised: eleven accounts as they were, and the one
  // read eighteen hours ago whose two windows have reset since.
  const used5 = [100, 100, 90, 80, 70, 60, 50, 40, 30, 25, 15];
  const used7 = [100, 95, 90, 85, 80, 75, 70, 65, 50, 40, 18];
  const twelve = [
    ...used5.map((p5, i) => acct(i + 2, [p5, NOW + (i + 1) * 10 * MIN], [used7[i], NOW + (i + 1) * 6 * HOUR],
      i % 3 === 2 ? { stale: true, fetchedAt: (NOW - 2 * HOUR) * 1000 } : {})),
    lapsedAndOld,
  ];

  it("the cards' average equals the average of what the rows count", () => {
    const out = html(twelve);
    const cells = cellsOf(out).map(seen);
    const remaining = [...out.matchAll(/<p class="ap-report-left"><b>(\d+)%<\/b> average remaining<\/p>/g)].map(m => Number(m[1]));
    // The report's own figures: 45% and 36% remaining.
    expect(remaining).toEqual([37, 29]);
    for (const i of [0, 1]) {
      // A row counts its number, or nothing at all for a window that reset:
      // it retains last observed usage.
      const counted = cells.filter((_, k) => k % 2 === i).map(t => (t === "Estimated unused" ? 0 : Number.parseInt(t, 10)));
      expect(counted.every(Number.isFinite)).toBe(true);
      const rowsAverage = counted.reduce((s, x) => s + x, 0) / counted.length;
      expect(usedAndAvailable(rowsAverage).available).toBe(remaining[i]);
      expect(usageReport(twelve, NOW).windows[i].used).toBeCloseTo(rowsAverage, 10);
    }
  });
});
