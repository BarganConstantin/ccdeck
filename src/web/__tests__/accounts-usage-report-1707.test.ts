// #1707: with ten Claude accounts, nothing answered "how much quota is left in
// all" without adding ten pairs of percentages by hand. The accounts panel's
// Usage report adds them up.
//
// What these pin, from the issue's own rules: each window is totalled on its
// own; each account with a current reading counts as one full window and
// "used" is their average, rounded once; a reading that is missing, old,
// blocked by a login or from before its window reset is left out of that
// window and said, never read as 0%; the resets stay per account, the total
// shows only the soonest; the room one window shows for an account the other
// has spent is flagged; and the report is the panel's own roster, so an open
// one moves with it without a poll of its own.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import {
  heldNote, readingOf, REPORT_STALE_MS, usageReport, usedAndAvailable, windowTotal,
} from "../accounts-usage-report";
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

  it("rounds once, where it is printed, and prints two figures that add up to a hundred", () => {
    // Eleven accounts summing to 291: 26.45…%. Rounded to a tenth first and a
    // whole second, it read 27.
    const eleven = Array.from({ length: 11 }, (_, i) => acct(i + 1, i < 10 ? 26 : 31, 10));
    const w = usageReport(eleven, NOW).windows[0];
    expect(w.used).toBeCloseTo(291 / 11, 10);
    expect(usedAndAvailable(w.used!)).toEqual({ used: 26, available: 74 });
    expect(usedAndAvailable(50.5)).toEqual({ used: 51, available: 49 });
  });

  it("holds a reading to the window it is a share of", () => {
    const r = usageReport([acct(1, 130, -5)], NOW);
    expect(r.windows[0].used).toBe(100);
    expect(r.windows[1].used).toBe(0);
  });

  it("says nobody is counted rather than printing a total of nothing", () => {
    const w = windowTotal(usageReport([acct(1, null, 10)], NOW).rows, "five_hour");
    expect(w).toMatchObject({ reporting: 0, total: 1, used: null, nextReset: null, capped: 0 });
  });
});

describe("what is left out, and why — never as 0%", () => {
  it("leaves out a window the account has no reading for", () => {
    expect(readingOf(acct(1, null, 10), "five_hour", NOW)).toEqual({ counted: false, why: "none", say: "No 5h reading", last: null });
  });

  it("leaves out a reading nothing has refreshed in a quarter of an hour, by the server's flag or this page's clock", () => {
    const flagged = readingOf(acct(1, 33, 10, { stale: true, fetchedAt: (NOW - 3 * HOUR) * 1000 }), "five_hour", NOW);
    expect(flagged).toMatchObject({ counted: false, why: "stale", last: 33 });
    expect(flagged.counted === false && flagged.say).toMatch(/^Last read /);
    // The server said fresh, and then stopped answering: the flag is only as
    // new as the last poll that reached it.
    const aged = acct(1, 33, 10, { fetchedAt: NOW * 1000 - REPORT_STALE_MS - 1000 });
    expect(readingOf(aged, "five_hour", NOW)).toMatchObject({ counted: false, why: "stale" });
    expect(readingOf(acct(1, 33, 10, { fetchedAt: NOW * 1000 - REPORT_STALE_MS + 1000 }), "five_hour", NOW).counted).toBe(true);
    expect(readingOf(acct(1, 10, 10, { fetchedAt: null }), "five_hour", NOW))
      .toMatchObject({ counted: false, why: "stale", say: "Never read" });
  });

  it("leaves out a window whose reset has passed since it was read, and says when", () => {
    const c = readingOf(acct(1, 90, 10, {}, [NOW - 18 * 60]), "five_hour", NOW);
    expect(c).toMatchObject({ counted: false, why: "reset", last: 90 });
    expect(c.counted === false && c.say).toMatch(/^Reset 18m ago, not read since$/);
  });

  it("leaves out an account whose login no switch can get past", () => {
    // `invalid_grant` is a stored login that cannot be refreshed: the panel
    // withholds its Switch, and the report says so in the panel's own words.
    const c = readingOf(acct(1, 10, 10, { error: "invalid_grant", alive: false }), "five_hour", NOW);
    expect(c).toMatchObject({ counted: false, why: "login" });
    expect(c.counted === false && c.say).toMatch(/login expired/i);
  });

  it("still counts a fresh reading beside an error that does not block a switch", () => {
    // A 429 is the collector being throttled; the numbers it last got are
    // current, and the panel still offers Switch.
    expect(readingOf(acct(1, 40, 10, { error: "http-429" }), "five_hour", NOW)).toMatchObject({ counted: true, pct: 40 });
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

describe("room that cannot be used", () => {
  it("flags the accounts one window counts that the other has spent", () => {
    const r = usageReport([acct(1, 12, 100), acct(2, 100, 40), acct(3, 30, 30)], NOW);
    const [five, seven] = r.windows;
    expect(five.capped).toBe(1);   // account 1: room in 5h, none in 7d
    expect(seven.capped).toBe(1);  // account 2: the other way round
  });

  it("leads with how many accounts have room in both windows", () => {
    const r = usageReport([acct(1, 12, 100), acct(2, 50, 40), acct(3, 30, 30), acct(4, null, 10), acct(5, 10, 10, { stale: true })], NOW);
    expect(r.roomInBoth).toBe(2);
  });
});

describe("the resets", () => {
  it("names the soonest one ahead among the readings that count, with what it brings back", () => {
    const r = usageReport([
      acct(1, 10, 10, {}, [NOW + 3 * HOUR]),
      acct(2, 12, 10, { alias: "work" }, [NOW + HOUR]),
      // Sooner, but stale: not the report's to promise.
      acct(3, 10, 10, { stale: true }, [NOW + 60]),
    ], NOW);
    expect(r.windows[0].nextReset).toEqual({ at: NOW + HOUR, name: "work", pct: 12, more: 0 });
  });

  it("says how many more come back in the same minute", () => {
    const r = usageReport([
      acct(1, 10, 10, { alias: "a" }, [NOW + HOUR]),
      acct(2, 10, 10, { alias: "b" }, [NOW + HOUR + 20]),
      acct(3, 10, 10, { alias: "c" }, [NOW + HOUR + 90]),
    ], NOW);
    expect(r.windows[0].nextReset).toMatchObject({ name: "a", more: 1 });
  });

  it("keeps each account's own in its row", () => {
    const html = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: [acct(1, 10, 10, {}, [NOW + 2 * HOUR + 1800]), acct(2, 10, 10, {}, [NOW + 45 * 60])], nowSec: NOW, held: null,
    }));
    expect(html).toContain('<span class="ap-report-in"><span class="vis-hidden">resets in </span>2h 30m</span>');
    expect(html).toContain('<span class="ap-report-in"><span class="vis-hidden">resets in </span>45m</span>');
  });
});

describe("the report, drawn", () => {
  const html = (accounts: Account[], held: string | null = null) =>
    renderToStaticMarkup(createElement(UsageReportBody, { accounts, nowSec: NOW, held }));

  it("leads with how much is available, then used, and how many accounts are counted", () => {
    const out = html([acct(1, 20, 40, { active: true }), acct(2, 40, null)]);
    expect(out).toContain('<span class="ap-report-avail"><b>70%</b> available</span>');
    expect(out).toContain("<b>30%</b> used");
    expect(out.indexOf("available")).toBeLessThan(out.indexOf("used</span>"));
    expect(out).toContain("2 of 2 accounts counted");
    expect(out).toContain("1 of 2 accounts counted");
    expect(out).toContain("<b>1</b> of 2 accounts has room in both windows");
  });

  it("draws one mark per counted account in its fullness ink, hidden from a screen reader", () => {
    const out = html([acct(1, 20, 40), acct(2, 75, 95), acct(3, 95, null)]);
    const strips = [...out.matchAll(/<div class="ap-report-strip" aria-hidden="true">(.*?)<\/div>/g)].map(m => m[1]);
    expect(strips[0]).toBe('<i></i><i data-level="mid"></i><i data-level="hi"></i>');
    expect(strips[1]).toBe('<i></i><i data-level="hi"></i>');
  });

  it("dims a left-out reading's last number beside its reason, and says it is not counted", () => {
    const out = html([acct(1, 33, 40, { stale: true, fetchedAt: (NOW - HOUR) * 1000 })]);
    expect(out).toMatch(/data-uncounted=""><span class="ap-report-pct">33%<\/span><span class="ap-report-why">Last read [^<]+<span class="vis-hidden">, not counted<\/span>/);
    // No number at all: a dash, hidden from a screen reader, and the reason.
    expect(html([acct(1, 20, null)])).toContain('<span class="ap-report-pct"><span aria-hidden="true">—</span></span><span class="ap-report-why">No 7d reading');
    // And a real zero is a reading, drawn as one.
    expect(html([acct(1, 0, 0)])).toContain(">0%<");
  });

  it("says a login that blocks both windows once, across both", () => {
    const out = html([acct(1, 10, 10, { error: "invalid_grant", alive: false })]);
    expect(out).toContain('colSpan="2"');
    expect(out.match(/ap-report-why/g)).toHaveLength(1);
  });

  it("flags room the other window has spent", () => {
    expect(html([acct(1, 12, 100), acct(2, 30, 30)])).toContain("1 of these is at the limit of its 7d window");
    expect(html([acct(1, 12, 100), acct(2, 30, 100)])).toContain("2 of these are at the limit of their 7d window");
  });

  it("marks an account held out of rotation", () => {
    expect(html([acct(1, 10, 10, { disabled: true })])).toContain('<span class="ap-report-tag">held out</span>');
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

  it("names no absolute limit it was never told", () => {
    const out = html([acct(1, 10, 10)]);
    expect(out).not.toMatch(/\$\d|tokens? (?:left|remaining)/i);
    expect(out).toContain("there is no total in tokens or dollars");
  });

  it("is a named scroll region, and invents no tab stop to be one", () => {
    const out = html([acct(1, 10, 10)]);
    expect(out).toMatch(/^<div class="ap-proj-body ap-report-body" role="region" aria-label="Report">/);
    expect(out).not.toContain("tabindex");
  });
});

describe("when the readings are the last ones rather than this poll's", () => {
  it("says so for a reload that failed, in the panel's own words", () => {
    expect(heldNote("Couldn't reach the deck.", false, true)).toBe("Couldn't reach the deck. These are the last readings.");
  });

  it("says so for a store that answered empty after it had accounts", () => {
    expect(heldNote(null, true, true)).toMatch(/could not be read just now/);
  });

  it("says nothing when this poll is the reading, or there never were rows", () => {
    expect(heldNote(null, false, true)).toBeNull();
    expect(heldNote(null, true, false)).toBeNull();
  });

  it("draws the note, and speaks it through a region that is always there", () => {
    expect(renderToStaticMarkup(createElement(UsageReportBody, { accounts: [acct(1, 10, 10)], nowSec: NOW, held: "Held." })))
      .toContain('<p class="ap-report-held">Held.</p>');
    const modal = sourceOf("components/AccountsUsageReport.tsx");
    expect(modal).toContain('<div className="vis-hidden" role="status" aria-atomic="true">{held ?? ""}</div>');
  });
});

describe("where it opens from", () => {
  const header = (canReport: boolean) => renderToStaticMarkup(createElement(AccountsHeader, {
    canShare: canReport, canReport, onAdd: () => {}, onReport: () => {}, onShareSet: () => {}, onReload: () => {},
    pressProps: () => ({}), reloading: false, closeButton: null,
  } as never));

  it("is a named button in the panel's header", () => {
    expect(header(true)).toMatch(/<button type="button" class="glyph-btn" aria-label="Usage report" aria-haspopup="dialog"/);
    expect(header(false)).not.toContain('aria-label="Usage report"');
  });

  it("is offered for two accounts or more, and kept while the report is open", () => {
    const panel = sourceOf("components/AccountsPanel.tsx");
    expect(panel).toContain("canReport={(data?.accounts?.length ?? 0) > 1 || reportOpen}");
  });

  it("is handed the panel's own roster, the order it had on opening, and its clock — no poll of its own", () => {
    const panel = sourceOf("components/AccountsPanel.tsx");
    expect(panel).toContain("onReport={() => { setReportOrder([...head, ...rest].map(laneKey)); setReportOpen(true); }}");
    expect(panel).toMatch(/<AccountsUsageReport accounts=\{data\?\.accounts \?\? null\} order=\{reportOrder\}\s+failed=\{failure\?\.reload \? failure\.text : null\}\s+nowSec=\{nowSec\}/);
    const modal = sourceOf("components/AccountsUsageReport.tsx");
    expect(modal).not.toMatch(/\bfetch\(|setInterval|useAccountRoster|usePanelClock/);
    expect(modal).toContain("const rows = holdOrder(shown, order);");
  });

  it("is a dialog in the Projects report's shell: portalled, dismissed and focused the shared way", () => {
    const modal = sourceOf("components/AccountsUsageReport.tsx");
    expect(modal).toContain("const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });");
    expect(modal).toContain('role="dialog" aria-modal="true" aria-labelledby="ap-report-title ap-report-sub"');
    expect(modal).toMatch(/return createPortal\(\s*(?:\/\/[^\n]*\n\s*)*<div className="modal-backdrop"/);
    expect(modal).toContain('<h2 className="ap-proj-title" id="ap-report-title">Usage report</h2>');
  });
});

describe("the sheet", () => {
  const css = sheetText();
  it("registers the account marks for contrast themes", () => {
    expect(css).toMatch(/\.ap-lane-fill,\s*\.ap-report-strip i,/);
  });

  it("keeps the column names in view while the rows scroll", () => {
    expect(css).toMatch(/\.ap-report-table thead th \{\s*position: sticky;/);
  });

  it("puts the two totals one under the other at a phone's width", () => {
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.ap-report-sums \{ grid-template-columns: 1fr; \}/);
  });
});
