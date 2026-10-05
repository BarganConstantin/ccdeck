// An account whose window has reset since claude-swap read it, everywhere the
// accounts panel shows it or orders by it.
//
// The open row's bars learnt to draw such a window as a record and say
// "reset" (quota-bar-rolled-over.test.ts), and the Usage panel to say so for
// its own bars. Everything else still took the old window's number as this
// window's: the shut row printed 95% in the warning ink for a 5-hour window
// that had rolled over twenty minutes ago, "5h · fullest" put that account at
// the top, "Most room" and the fold's "% free" measured it against that 95%,
// and the live account counted as past the auto-switch threshold on it.
//
// A lapsed window says nothing about this window until it is read again: the
// row says it reset, the orders treat it as unread, and room is measured
// against the windows still running.
//
// And the Usage panel's own answer carries `stale` when the server is holding
// the last reading it has rather than a new one — which QuotaData never
// declared, so the panel could not say it.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import { ClaudeQuotaSection } from "../components/QuotaSections";
import { pastThreshold, peersOf } from "../account-fold";
import { sortAccounts } from "../other-accounts-order";
import { type Account } from "../claude-accounts";
import { type QuotaData } from "../use-quota";

const NOW = 1_800_000_000;
const AGO = NOW - 1200;      // a reset twenty minutes gone
const AHEAD = NOW + 3 * 86_400;

function acct(num: number, five: [number, number], seven: number, over: Partial<Account> = {}): Account {
  const lanes = [
    { id: "five_hour", label: "5h", pct: five[0], resetAt: five[1] },
    { id: "seven_day", label: "7d", pct: seven, resetAt: AHEAD },
  ];
  return {
    num, email: `a${num}@x.io`, alias: null, org: null, active: false, disabled: false, lanes,
    // What the server sent, when the 5-hour window had not reset yet.
    headroom: 100 - Math.max(...lanes.map(l => l.pct)),
    fetchedAt: (NOW - 1800) * 1000, nextAt: null, stale: false, error: null,
    ...over,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const shutRow = (a: Account) => renderToStaticMarkup(createElement(AccountRow, {
  a, nowSec: NOW, opened: false, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
  onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
  onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
  issueExpanded: false, onOpenIssue: () => {}, sortKey: "room",
} as never));

const lapsed = acct(2, [95, AGO], 20);
const running = acct(3, [60, NOW + 3600], 10);

describe("an account whose 5-hour window has reset since it was read", () => {
  it("is not shown at the old window's number on its shut row", () => {
    const html = shutRow(lapsed);
    const quick = /<p class="ap-quota"[^]*?<\/p>/.exec(html)?.[0] ?? "";
    expect(text(quick)).not.toContain("95%");
    expect(text(quick)).toContain("5h reset");
    expect(quick).not.toContain('data-level="hi"');
    expect(quick).toContain("5h has reset since this reading");
    // Under "Most room" the number it was placed by is the window still running.
    expect(/<span class="ap-q" data-sort-key=""[^]*?<\/span><\/span>/.exec(quick)?.[0]).toContain("7d");
  });

  it("keeps a window still running as it was", () => {
    const quick = /<p class="ap-quota"[^]*?<\/p>/.exec(shutRow(running))?.[0] ?? "";
    expect(text(quick)).toContain("5h 60%");
  });

  it("is ordered as unread by that window, not as the fullest", () => {
    const order = (o: string) => sortAccounts([lapsed, running], o, () => true, NOW).map(a => a.num);
    expect(order("5h:full")).toEqual([3, 2]);
    expect(order("5h:empty")).toEqual([3, 2]);
  });

  it("has its room measured against the windows still running", () => {
    expect(sortAccounts([running, lapsed], "room", () => true, NOW).map(a => a.num)).toEqual([2, 3]);
    expect(peersOf([lapsed], NOW)[0].headroom).toBe(80);
    expect(peersOf([running], NOW)[0].headroom).toBe(40);
  });

  it("does not put the live account past the auto-switch threshold on the old number", () => {
    expect(pastThreshold({ ...lapsed, active: true }, "90", NOW)).toBe(false);
    expect(pastThreshold({ ...acct(1, [95, NOW + 600], 20), active: true }, "90", NOW)).toBe(true);
  });
});

describe("a Claude reading the server is holding rather than refreshing", () => {
  const quota = (over: Partial<QuotaData>): QuotaData => ({
    ok: true, source: "claude-swap", fetchedAt: (NOW - 1020) * 1000,
    session5hPct: 40, session5hResetAt: NOW + 3600, session5hWindowSec: 18_000,
    week7dPct: 20, week7dResetAt: AHEAD, week7dWindowSec: 604_800, ...over,
  });
  const section = (q: QuotaData) =>
    text(renderToStaticMarkup(createElement(ClaudeQuotaSection, { quota: q, quotaLoading: false, nowSec: NOW })));

  it("says no newer reading came in, beside its age", () => {
    expect(section(quota({ stale: true }))).toContain("17m ago · no newer reading");
    expect(section(quota({}))).not.toContain("no newer reading");
  });
});
