// #1707: with ten Claude accounts, nothing answered "how much quota is left in
// all" without adding ten pairs of percentages by hand. The accounts panel's
// Usage report adds them up.
//
// What these pin, from the issue's own rules: each window is totalled on its
// own; each account with a current reading counts as one full window and
// "used" is their average; a reading that is missing, old, blocked by a login
// or from before its window reset is left out of that window and said, never
// read as 0%; the resets stay per account, the total shows only the soonest;
// and the report is the panel's own roster, so an open one moves with it.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { readingOf, usageReport, usedAndAvailable, windowTotal } from "../accounts-usage-report";
import { UsageReportBody } from "../components/AccountsUsageReport";
import AccountsHeader from "../components/AccountsHeader";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const NOW = 1_790_000_000;
const HOUR = 3600;

function acct(num: number, p5: number | null, p7: number | null, over: Partial<Account> = {}, resets: [number?, number?] = []): Account {
  const lanes = [
    ...(p5 == null ? [] : [{ id: "five_hour", label: "5h", pct: p5, resetAt: resets[0] ?? NOW + 2 * HOUR }]),
    ...(p7 == null ? [] : [{ id: "seven_day", label: "7d", pct: p7, resetAt: resets[1] ?? NOW + 70 * HOUR }]),
  ];
  return {
    num, email: `a${num}@x.io`, alias: null, org: null, active: false, disabled: false, lanes,
    headroom: null, fetchedAt: (NOW - 240) * 1000, nextAt: null, stale: false, error: null, ...over,
  };
}

describe("adding it up", () => {
  it("averages the readings of the accounts that have one, each window on its own", () => {
    const r = usageReport([acct(1, 20, 40), acct(2, 40, 60), acct(3, null, 20)], NOW);
    const [five, seven] = r.windows;
    expect(five).toMatchObject({ label: "5h", reporting: 2, total: 3, used: 30 });
    expect(seven).toMatchObject({ label: "7d", reporting: 3, total: 3, used: 40 });
  });

  it("prints used and available as whole percents that add up to a hundred", () => {
    expect(usedAndAvailable(26.5)).toEqual({ used: 27, available: 73 });
    expect(usedAndAvailable(0)).toEqual({ used: 0, available: 100 });
    expect(usedAndAvailable(100)).toEqual({ used: 100, available: 0 });
    for (let u = 0; u <= 100; u += 0.3) {
      const { used, available } = usedAndAvailable(u);
      expect(used + available).toBe(100);
    }
  });

  it("holds a reading to the window it is a share of", () => {
    const r = usageReport([acct(1, 130, -5)], NOW);
    expect(r.windows[0].used).toBe(100);
    expect(r.windows[1].used).toBe(0);
  });

  it("says nobody is reporting rather than printing a total of nothing", () => {
    const w = windowTotal(usageReport([acct(1, null, 10)], NOW).rows, "five_hour");
    expect(w).toMatchObject({ reporting: 0, total: 1, used: null, nextReset: null });
  });
});

describe("what is left out, and why — never as 0%", () => {
  it("leaves out a window the account has no reading for", () => {
    expect(readingOf(acct(1, null, 10), "five_hour", NOW)).toEqual({ counted: false, why: "none", say: "No 5h reading" });
  });

  it("leaves out an account nothing has been collected for in a quarter of an hour, with its age", () => {
    const c = readingOf(acct(1, 10, 10, { stale: true, fetchedAt: (NOW - 3 * HOUR) * 1000 }), "seven_day", NOW);
    expect(c).toMatchObject({ counted: false, why: "stale" });
    expect(c.counted === false && c.say).toMatch(/^Last read /);
    expect(readingOf(acct(1, 10, 10, { stale: true, fetchedAt: null }), "five_hour", NOW))
      .toMatchObject({ counted: false, why: "stale", say: "Never read" });
  });

  it("leaves out a window whose reset has passed since it was read", () => {
    expect(readingOf(acct(1, 90, 10, {}, [NOW - 60]), "five_hour", NOW))
      .toEqual({ counted: false, why: "reset", say: "Reset since it was read" });
  });

  it("leaves out an account whose login no switch can get past", () => {
    const blocked = acct(1, 10, 10, { error: "invalid_grant", alive: false });
    // `invalid_grant` is a stored login that cannot be refreshed: the panel
    // withholds its Switch, and the report says so in the panel's own words.
    const c = readingOf(blocked, "five_hour", NOW);
    expect(c).toMatchObject({ counted: false, why: "login" });
    expect(c.counted === false && c.say).toMatch(/login expired/i);
  });

  it("counts the rest, and leaves the denominator to the accounts that count", () => {
    const r = usageReport([
      acct(1, 20, 20),
      acct(2, 80, 80, { stale: true }),
      acct(3, 60, 60, {}, [NOW - 1, NOW - 1]),
      acct(4, null, null),
    ], NOW);
    expect(r.windows.map(w => [w.reporting, w.total, w.used])).toEqual([[1, 4, 20], [1, 4, 20]]);
  });
});

describe("the resets", () => {
  it("names the soonest one ahead, among the readings that count", () => {
    const r = usageReport([
      acct(1, 10, 10, {}, [NOW + 3 * HOUR]),
      acct(2, 10, 10, { alias: "work" }, [NOW + HOUR]),
      // Sooner, but stale: not the report's to promise.
      acct(3, 10, 10, { stale: true }, [NOW + 60]),
    ], NOW);
    expect(r.windows[0].nextReset).toEqual({ at: NOW + HOUR, name: "work" });
  });

  it("keeps each account's own in its row", () => {
    const html = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: [acct(1, 10, 10, {}, [NOW + 2 * HOUR + 1800]), acct(2, 10, 10, {}, [NOW + 45 * 60])], nowSec: NOW, held: false,
    }));
    expect(html).toContain("2h 30m");
    expect(html).toContain("45m");
  });
});

describe("the report, drawn", () => {
  const html = (accounts: Account[], held = false) =>
    renderToStaticMarkup(createElement(UsageReportBody, { accounts, nowSec: NOW, held }));

  it("prints each window's used, available and how many accounts report", () => {
    const out = html([acct(1, 20, 40, { active: true }), acct(2, 40, null)]);
    expect(out).toContain("<b>30%</b> used");
    expect(out).toContain("<b>70%</b> available");
    expect(out).toContain("2 of 2 accounts reporting");
    expect(out).toContain("1 of 2 accounts reporting");
    expect(out).toContain('aria-label="30% of the combined 5-hour quota used, 70% available"');
  });

  it("marks a reading that is left out with a dash and its reason, and says it is not counted", () => {
    const out = html([acct(1, 20, 40), acct(2, 40, null)]);
    expect(out).toMatch(/data-uncounted=""><span class="ap-report-pct" aria-hidden="true">—<\/span><span class="ap-report-why">No 7d reading<span class="vis-hidden">, not counted<\/span>/);
    // And a real zero is a reading, drawn as one.
    expect(html([acct(1, 0, 0)])).toContain(">0%<");
  });

  it("lists the accounts in the order it was handed them, the live one marked", () => {
    const out = html([acct(7, 10, 10, { active: true, alias: "live" }), acct(3, 10, 10, { alias: "three" }), acct(5, 10, 10, { alias: "five" })]);
    expect(out.indexOf(">live<")).toBeLessThan(out.indexOf(">three<"));
    expect(out.indexOf(">three<")).toBeLessThan(out.indexOf(">five<"));
    expect(out).toContain('<tr data-active="">');
    expect(out).toContain("(active)");
  });

  it("says when a window has no current reading at all", () => {
    expect(html([acct(1, null, 10)])).toContain("No account has a current 5-hour reading.");
  });

  it("says when it is showing the last reading because the store could not be read", () => {
    expect(html([acct(1, 10, 10)], true)).toContain("The account store could not be read just now.");
    expect(html([acct(1, 10, 10)], false)).not.toContain("could not be read");
  });

  it("names no absolute limit it was never told", () => {
    const out = html([acct(1, 10, 10)]);
    expect(out).not.toMatch(/\$\d|tokens? (?:left|remaining)/i);
    expect(out).toContain("there is no total in tokens or dollars");
  });
});

describe("where it opens from", () => {
  const header = (canReport: boolean) => renderToStaticMarkup(createElement(AccountsHeader, {
    canShare: canReport, canReport, onAdd: () => {}, onReport: () => {}, onShareSet: () => {}, onReload: () => {},
    pressProps: () => ({}), reloading: false, closeButton: null,
  } as never));

  it("is a named button in the panel's header, drawn when there is an account to report on", () => {
    expect(header(true)).toMatch(/<button type="button" class="glyph-btn" aria-label="Usage report" aria-haspopup="dialog"/);
    expect(header(false)).not.toContain('aria-label="Usage report"');
  });

  it("is handed the panel's own roster and clock, so it starts no poll of its own", () => {
    const panel = sourceOf("components/AccountsPanel.tsx");
    expect(panel).toContain("<AccountsUsageReport accounts={[...head, ...rest]} nowSec={nowSec} onClose={() => setReportOpen(false)} />");
    const modal = sourceOf("components/AccountsUsageReport.tsx");
    expect(modal).not.toMatch(/\bfetch\(|setInterval|useAccountRoster|usePanelClock/);
  });

  it("is a dialog in the Projects report's shell: portalled, dismissed and focused the shared way", () => {
    const modal = sourceOf("components/AccountsUsageReport.tsx");
    expect(modal).toContain("const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });");
    expect(modal).toContain('role="dialog" aria-modal="true" aria-labelledby="ap-report-title ap-report-sub"');
    expect(modal).toMatch(/return createPortal\(\s*(?:\/\/[^\n]*\n\s*)*<div className="modal-backdrop"/);
  });
});

describe("the sheet", () => {
  const css = sheetText();
  it("draws the totals' meter like a lane, and registers it for contrast themes", () => {
    expect(css).toMatch(/\.ap-report-meter \{[^}]*background: var\(--line-soft\);/);
    expect(css).toMatch(/\.ap-lane-fill,\s*\.ap-report-fill,/);
    expect(css).toMatch(/\.ap-lane-track,\s*\.ap-report-meter,/);
  });

  it("puts the two totals one under the other at a phone's width", () => {
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.ap-report-sums \{ grid-template-columns: 1fr; \}/);
  });
});
