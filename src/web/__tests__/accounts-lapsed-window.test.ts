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
// row says it reset, the order treats it as unread (internal #94: below the
// accounts read as usable, never among the full ones), and room is measured
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
import { byAvailability } from "../other-accounts-order";
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
/** What markup shows the eye: without what only a screen reader hears. */
const seen = (html: string) => text(html.replace(/<span class="vis-hidden">[^<]*<\/span>/g, ""));
/** One window's lane on a row, from its short name to its reset. */
const laneOf = (html: string, label: string) =>
  new RegExp(`<div class="ap-lane"><span class="ap-lane-label" title="[^"]*">${label}</span>[^]*?</div>`).exec(html)?.[0] ?? "";
const shutRow = (a: Account) => renderToStaticMarkup(createElement(AccountRow, {
  a, nowSec: NOW, opened: false, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
  onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
  onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
  issueExpanded: false, onOpenIssue: () => {},
} as never));

const lapsed = acct(2, [95, AGO], 20);
const running = acct(3, [60, NOW + 3600], 10);

describe("an account whose 5-hour window has reset since it was read", () => {
  it("is not shown at the old window's number on its shut row", () => {
    const html = shutRow(lapsed);
    // CHANGED ON PURPOSE (#2644): every window is a bar under the name on the
    // shut row too, so "reset" is said on the 5-hour window's own lane, where
    // its number was, and the week still running keeps its lane under it.
    // What the window read before it reset is the lane's hover and what a
    // screen reader hears, in the capacity report's words, so the eye's text
    // is read without it — and the old number is nowhere else.
    const five = laneOf(html, "5h");
    expect(five, "the 5h lane was not found").not.toBe("");
    expect(seen(html)).not.toContain("95%");
    expect(seen(five)).toBe("5h reset");
    expect(five).toContain('data-reset=""');
    expect(five).toContain('title="Reported reset time passed 20m ago, 95% when read 30m ago"');
    expect(html.match(/95%/g)?.length).toBe(html.match(/95% when read/g)?.length);
    // Its track is empty: a bar 95% full beside "reset" would say the opposite.
    expect(five).toContain('<span class="ap-lane-track" aria-hidden="true"></span>');
    // The error level is named "err" since every quota meter shares one level
    // (V4 top-10 #9); "hi" before. Both stay absent, so this cannot pass by the rename.
    expect(html).not.toContain('data-level="err"');
    expect(html).not.toContain('data-level="hi"');
    // And no countdown to a reset that has passed.
    expect(five).not.toMatch(/resets in/);
    // The window still running keeps its own lane, its figure and its reset.
    expect(seen(laneOf(html, "7d"))).toBe("7d 20% 3d 0h");
  });

  it("keeps a window still running as it was", () => {
    const html = shutRow(running);
    // CHANGED ON PURPOSE (#2644): each window on its own lane — name, bar,
    // figure, reset — rather than a figure beside the name and a line under it.
    expect(seen(laneOf(html, "5h"))).toBe("5h 60% 1h 00m");
    expect(laneOf(html, "5h")).toContain('<span class="ap-lane-fill" style="width:60%;background:var(--accent);opacity:1"></span>');
    expect(seen(laneOf(html, "7d"))).toBe("7d 10% 3d 0h");
  });

  it("is ordered as unread by that window: below a usable account, whatever the old number", () => {
    const usable = { reachable: true, rateLimited: false };
    expect(byAvailability([lapsed, running], () => usable, NOW).map(a => a.num)).toEqual([3, 2]);
    expect(byAvailability([running, lapsed], () => usable, NOW).map(a => a.num)).toEqual([3, 2]);
  });

  it("keeps headroom unknown until the elapsed window is observed again", () => {
    expect(peersOf([lapsed], NOW)[0].headroom).toBeNull();
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
