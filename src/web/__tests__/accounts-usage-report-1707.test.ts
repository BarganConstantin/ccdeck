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
//
// #1713 reworked what it draws into "Account capacity": the accounts ready
// lead, each window's card says what REMAINS, the rows keep what each account
// has USED under columns that say so, and each row has a state — Ready,
// Limited, Exhausted, or Stale when its reading cannot be trusted. "N of M
// ready" is the count of rows that say Ready, by construction.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import {
  heldNote, readingOf, REPORT_STALE_MS, staleReason, statusOf, usageReport, usedAndAvailable, windowTotal,
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
    expect(w).toMatchObject({ reporting: 0, total: 1, used: null, nextReset: null });
  });
});

describe("what is left out, and why — never as 0%", () => {
  it("leaves out a window the account has no reading for", () => {
    expect(readingOf(acct(1, null, 10), "five_hour", NOW))
      .toEqual({ counted: false, why: "none", say: "No 5h reading", last: null, estimate: null, resetAt: null });
  });

  it("leaves out a reading nothing has refreshed in a quarter of an hour, by the server's flag or this page's clock", () => {
    const flagged = readingOf(acct(1, 33, 10, { stale: true, fetchedAt: (NOW - 3 * HOUR) * 1000 }), "five_hour", NOW);
    expect(flagged).toMatchObject({ counted: false, why: "stale", last: 33 });
    expect(flagged.counted === false && flagged.say).toMatch(/^Updated /);
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
    expect(c.counted === false && c.say).toMatch(/^Reset 18m ago, not updated$/);
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

  it("totals every account with a number: a stale one at its last reading, a reset window as unused (#1713)", () => {
    // Until #1713 the total was the fresh accounts' alone — 20% here — and
    // inactive accounts, read on claude-swap's slower plan, were routinely
    // stale, so the cards added up whichever few had been read lately.
    const r = usageReport([
      acct(1, 20, 20),
      acct(2, 80, 80, { stale: true }),
      acct(3, 60, 60, {}, [NOW - 1, NOW - 1]),
      acct(4, null, null),
    ], NOW);
    expect(r.windows.map(w => [w.reporting, w.included, w.total])).toEqual([[1, 3, 4], [1, 3, 4]]);
    for (const w of r.windows) expect(w.used).toBeCloseTo((20 + 80 + 0) / 3, 10);
    // Only the account never read is out; it is never a 0% it was not given.
    expect(r.rows[3].cells.five_hour).toMatchObject({ counted: false, estimate: null });
    // And the rows are judged on the same numbers the total takes; only the
    // account never read is Stale.
    expect(r.rows.map(x => x.status)).toEqual(["ready", "ready", "ready", "stale"]);
  });
});

describe("room that cannot be used", () => {
  it("names the accounts one window has spent Limited, whichever window it is", () => {
    // What the per-window capped count said until #1713; the row says it now.
    const r = usageReport([acct(1, 12, 100), acct(2, 100, 40), acct(3, 30, 30)], NOW);
    expect(r.rows.map(x => x.status)).toEqual(["limited", "limited", "ready"]);
  });

  it("leads with how many accounts have room in both windows", () => {
    const r = usageReport([acct(1, 12, 100), acct(2, 50, 40), acct(3, 30, 30), acct(4, null, 10), acct(5, 10, 10, { stale: true })], NOW);
    expect(r.roomInBoth).toBe(3);
  });
});

describe("what each account can do now (#1713)", () => {
  const stateOf = (a: Account) => usageReport([a], NOW).rows[0].status;

  it("is Ready with room in both windows, near a limit included", () => {
    expect(stateOf(acct(1, 0, 0))).toBe("ready");
    expect(stateOf(acct(1, 95, 50))).toBe("ready");
    expect(stateOf(acct(1, 99.6, 99.6))).toBe("ready");
  });

  it("is Limited with exactly one window at its limit, and Exhausted with both", () => {
    expect(stateOf(acct(1, 100, 50))).toBe("limited");
    expect(stateOf(acct(1, 50, 100))).toBe("limited");
    expect(stateOf(acct(1, 100, 100))).toBe("exhausted");
  });

  it("judges an old reading on its last numbers, since an idle account spends nothing between reads", () => {
    expect(stateOf(acct(1, 10, 10, { stale: true }))).toBe("ready");
    expect(stateOf(acct(1, 10, 10, { fetchedAt: NOW * 1000 - REPORT_STALE_MS - 1000 }))).toBe("ready");
    expect(stateOf(acct(1, 100, 40, { stale: true }))).toBe("limited");
    expect(stateOf(acct(1, 100, 100, { stale: true }))).toBe("exhausted");
    // A window that has reset since it was read is taken as unused.
    expect(stateOf(acct(1, 100, 10, {}, [NOW - 60]))).toBe("ready");
  });

  it("is Stale only where the numbers cannot speak: never read, or behind a login", () => {
    expect(stateOf(acct(1, null, 10))).toBe("stale");
    expect(stateOf(acct(1, 10, 10, { error: "invalid_grant", alive: false }))).toBe("stale");
  });

  it("draws a lead that matches the rows that say Ready", () => {
    const out = renderToStaticMarkup(createElement(UsageReportBody, {
      accounts: [acct(1, 0, 0), acct(2, 95, 50), acct(3, 100, 50), acct(4, 10, 10, { stale: true }), acct(5, 30, null)],
      nowSec: NOW, held: null,
    }));
    const lead = Number(/<b>(\d+)<\/b> of \d+ accounts? ready/.exec(out)?.[1]);
    expect(lead).toBe(out.match(/data-status="ready"/g)?.length);
    expect(lead).toBe(3);
  });

  it("counts as ready exactly the rows that say Ready", () => {
    const r = usageReport([
      acct(1, 0, 0), acct(2, 95, 50), acct(3, 100, 50), acct(4, 100, 100),
      acct(5, 10, 10, { stale: true }), acct(6, null, 10), acct(7, 30, 30),
    ], NOW);
    expect(r.rows.map(x => x.status)).toEqual(["ready", "ready", "limited", "exhausted", "ready", "stale", "ready"]);
    expect(r.roomInBoth).toBe(r.rows.filter(x => x.status === "ready").length);
    expect(r.roomInBoth).toBe(4);
  });

  it("never prints 100% on a window that has room, nor 0% remaining on one", () => {
    // 99.6% used is room: Ready, counted as ready — and so it must not be
    // drawn as the limit. Rounded plainly it read "100%" in the error ink on a
    // row that said Ready, and "0% remaining" on a card whose lead said 1 of 1
    // ready.
    const out = renderToStaticMarkup(createElement(UsageReportBody, { accounts: [acct(1, 99.6, 99.6)], nowSec: NOW, held: null }));
    expect(out).toContain('<span class="ap-report-pct" data-level="hi">99%</span>');
    expect(out).not.toContain(">100%<");
    expect(out).toContain('<p class="ap-report-left"><b>1%</b> remaining</p>');
    expect(out).toContain("<b>1</b> of 1 account ready");
    expect(usedAndAvailable(99.6)).toEqual({ used: 99, available: 1 });
    expect(usedAndAvailable(100)).toEqual({ used: 100, available: 0 });
  });

  it("says why a stale row is stale in its first unread reading's words", () => {
    const [row] = usageReport([acct(1, 10, null)], NOW).rows;
    expect(staleReason(row.cells)).toBe("No 7d reading");
    expect(staleReason(usageReport([acct(1, 10, 10)], NOW).rows[0].cells)).toBeNull();
    expect(statusOf(row.cells)).toBe("stale");
  });
});

describe("the resets", () => {
  it("names the soonest one ahead among every account in the total, with what it brings back", () => {
    const r = usageReport([
      acct(1, 10, 10, {}, [NOW + 3 * HOUR]),
      acct(2, 12, 10, { alias: "work" }, [NOW + HOUR]),
      // Stale, but a reset time does not move with the reading's age (#1713).
      acct(3, 15, 10, { stale: true, alias: "old" }, [NOW + 60]),
      // Already passed: nothing ahead to name.
      acct(4, 10, 10, { stale: true, alias: "gone" }, [NOW - 60]),
    ], NOW);
    expect(r.windows[0].nextReset).toEqual({ at: NOW + 60, name: "old", pct: 15, more: 0 });
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

  it("leads with how many accounts are ready, then what each window has remaining", () => {
    const out = html([acct(1, 20, 40, { active: true }), acct(2, 40, null)]);
    expect(out).toContain("<b>1</b> of 2 accounts ready");
    // One line: what "ready" means is in the disclosure, not under the count.
    expect(out).not.toContain("ap-report-lead-sub");
    expect(out).toContain('<p class="ap-report-left"><b>70%</b> remaining</p>');
    expect(out).toContain('<p class="ap-report-left"><b>60%</b> remaining</p>');
    expect(out.indexOf("accounts ready")).toBeLessThan(out.indexOf("remaining"));
    // One figure a card, never the same fact twice the other way round.
    expect(out).not.toMatch(/available<|% used</);
  });

  it("says only which accounts a card leaves out: the ones never read", () => {
    expect(html([acct(1, 20, 40), acct(2, 40, 40)])).not.toContain("ap-report-basis");
    // Stale ones are in the total, and their rows say how old they are.
    expect(html([acct(1, 20, 40), acct(2, 40, 40, { stale: true })])).not.toContain("ap-report-basis");
    const never = html([acct(1, 20, 40), acct(2, 40, null)]);
    expect(never.match(/ap-report-basis/g)).toHaveLength(1);
    expect(never).toContain('<p class="ap-report-basis">1 never read</p>');
  });

  it("draws one quiet bar of what remains, in the warning ink only once the window runs low", () => {
    // A transform rather than a width, as the Usage panel's bars (#1713).
    expect(html([acct(1, 20, 40)])).toContain('<div class="ap-report-meter" aria-hidden="true"><i style="transform:scaleX(0.8)"></i></div>');
    const low = html([acct(1, 95, 75)]);
    expect(low).toContain('<div class="ap-report-meter" data-level="hi" aria-hidden="true"><i style="transform:scaleX(0.05)"></i></div>');
    expect(low).toContain('<div class="ap-report-meter" data-level="mid" aria-hidden="true"><i style="transform:scaleX(0.25)"></i></div>');
  });

  it("names whose reset comes next on the line, since each account keeps its own window", () => {
    // "Resets in 25m" under 88% remaining read as the whole window coming back.
    const out = html([acct(1, 12, 10, { alias: "work" }, [NOW + HOUR]), acct(2, 10, 10, {}, [NOW + 3 * HOUR])]);
    expect(out).toContain('<p class="ap-report-reset" title="First: work (12% used)"><span>Next reset in <span class="ap-report-num">1h 0m</span></span><span aria-hidden="true">·</span><span class="ap-report-who">work</span><span class="vis-hidden">. First: work (12% used)</span></p>');
    expect(out).not.toMatch(/>Resets in /);
    const two = html([acct(1, 12, 10, { alias: "a" }, [NOW + HOUR]), acct(2, 10, 10, { alias: "b" }, [NOW + HOUR + 20])]);
    expect(two).toContain('<span class="ap-report-who">a</span><span class="ap-report-more">+1</span>');
  });

  it("labels the rows' numbers as used, beside a state for each", () => {
    const out = html([acct(1, 10, 10)]);
    expect(out).toContain('<th scope="col">5h used</th><th scope="col">7d used</th><th scope="col">Status</th>');
  });

  it("dims a left-out reading's last number, and says once, in its state, why", () => {
    const out = html([acct(1, 33, 40, { stale: true, fetchedAt: (NOW - HOUR) * 1000 })]);
    expect(out).toContain('data-uncounted=""><span class="ap-report-pct">33%</span><span class="vis-hidden">, not counted</span>');
    // Judged on its last numbers, and saying how old they are (#1713).
    expect(out).toMatch(/<td class="ap-report-state" data-status="ready"><span class="ap-report-state-word"><i aria-hidden="true"><\/i>Ready<\/span><span class="ap-report-why">Updated [^<]+<\/span><\/td>/);
    expect(out.match(/ap-report-why/g)).toHaveLength(1);
    // No number at all: a dash for the eye, words for a screen reader.
    const none = html([acct(1, 20, null)]);
    expect(none).toContain('<span class="ap-report-pct"><span aria-hidden="true">—</span><span class="vis-hidden">no reading</span></span>');
    expect(none).toContain('<span class="ap-report-why">No 7d reading</span>');
    // And a real zero is a reading, drawn as one.
    expect(html([acct(1, 0, 0)])).toContain(">0%<");
  });

  it("says a login that blocks both windows once, as the row's reason", () => {
    const out = html([acct(1, 10, 10, { error: "invalid_grant", alive: false })]);
    expect(out).toContain('data-status="stale"');
    expect(out.match(/ap-report-why/g)).toHaveLength(1);
    expect(out).toMatch(/<span class="ap-report-why">[^<]*login expired/i);
  });

  it("names a spent window Limited and two Exhausted, and warns without a state for one near its limit", () => {
    const out = html([acct(1, 12, 100), acct(2, 100, 100), acct(3, 95, 30)]);
    expect(out).toMatch(/data-status="limited"><span class="ap-report-state-word"><i aria-hidden="true"><\/i>Limited</);
    expect(out).toMatch(/data-status="exhausted"><span class="ap-report-state-word"><i aria-hidden="true"><\/i>Exhausted</);
    expect(out).toMatch(/data-status="ready"><span class="ap-report-state-word"><i aria-hidden="true"><\/i>Ready</);
    expect(out).toContain('<span class="ap-report-pct" data-level="hi">95%</span>');
    expect(out).toContain("<b>1</b> of 3 accounts ready");
  });

  it("marks an account held out of rotation", () => {
    expect(html([acct(1, 10, 10, { disabled: true })])).toContain('<span class="ap-report-tag">held out</span>');
  });

  it("lists the accounts in the order it was handed them, the live one marked", () => {
    const out = html([acct(7, 10, 10, { active: true, alias: "live" }), acct(3, 10, 10, { alias: "three" }), acct(5, 10, 10, { alias: "five" })]);
    expect(out.indexOf(">live<")).toBeLessThan(out.indexOf(">three<"));
    expect(out.indexOf(">three<")).toBeLessThan(out.indexOf(">five<"));
    expect(out).toContain('<tr data-active="" style="--row:0">');
    expect(out).toContain('<span class="ap-report-name" title="live">live</span><span class="ap-report-current">Current</span>');
    expect(out.match(/ap-report-current/g)).toHaveLength(1);
  });

  it("says when a window has no current reading at all", () => {
    expect(html([acct(1, null, 10)])).toContain("No account has a 5-hour reading yet.");
  });

  it("names no absolute limit it was never told", () => {
    const out = html([acct(1, 10, 10)]);
    // The deck is never told a limit, so it prints no amount of one. The
    // sentence saying so was cut from the disclosure for length (#1713); the
    // guarantee is this line.
    expect(out).not.toMatch(/\$\d|tokens? (?:left|remaining)/i);
  });

  it("folds how it is worked out, and what each state means, into a disclosure", () => {
    const out = html([acct(1, 10, 10)]);
    expect(out).toMatch(/<details class="ap-report-how"><summary><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>How usage is calculated<\/summary>/);
    const body = out.slice(out.indexOf('<div class="ap-report-how-body">'));
    for (const word of ["Ready", "Limited", "Exhausted", "Stale"]) expect(body).toContain(`<b>${word}</b>`);
    expect(out).not.toContain("ap-report-note");
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
    expect(header(true)).toMatch(/<button type="button" class="glyph-btn" aria-label="Account capacity" aria-haspopup="dialog"/);
    expect(header(false)).not.toContain('aria-label="Account capacity"');
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
    expect(modal).toContain('<h2 className="ap-proj-title" id="ap-report-title">Account capacity</h2>');
  });
});

describe("the sheet", () => {
  const css = sheetText();
  it("registers the account marks for contrast themes", () => {
    expect(css).toMatch(/\.ap-lane-fill,\s*\.ap-report-meter i,/);
    // The state marks are borders, which a Contrast theme repaints on its own.
    expect(css).toMatch(/\.ap-report-state-word i \{[^}]*border: 3px solid currentColor;/);
  });

  it("keeps the column names in view while the rows scroll", () => {
    expect(css).toMatch(/\.ap-report-table thead th \{\s*position: sticky;/);
  });

  it("puts the two totals one under the other at a phone's width", () => {
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.ap-report-sums \{ grid-template-columns: 1fr; \}/);
  });
});
