// One account, three views, and the open one disagreed.
//
// An account last read eighteen hours ago at 96% of its 5 hours and 84% of its
// week, and both windows had reset since. Its shut row said "5h reset · 7d
// reset", and the Account capacity report said "reset" in both cells and
// counted both windows as unused (#2093). Opened, the same row drew two bars
// 96% and 84% full and printed 96% and 84% in the muted ink.
//
// The open row's bars said "reset" only for a window that had rolled over on a
// row that was not frozen, and a row nothing has read for a quarter of an hour
// is frozen — which is exactly the row whose windows have most likely reset.
//
// What these pin: a window whose reset has passed since its last reading says
// "reset" where its number was, frozen or not; when it reset and what it read
// before are on hover and said to a screen reader, in the report's own words;
// its bar is empty, as the Usage panel draws a window that has reset, because
// the total counts it as unused; the old number and a 0% it was never given
// appear nowhere on screen; and the shut row, the open row and the report say
// the same of every window.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import { UsageReportBody } from "../components/AccountsUsageReport";
import type { Account } from "../claude-accounts";
import { sheetText } from "./sheet-source";

const NOW = 1_790_000_000;
const HOUR = 3600;

/** Read eighteen hours ago, at 96% and 84%; both windows have reset since. */
const frozenAndReset: Account = {
  num: 4, email: "frozen@example.com", alias: "work", org: null, active: false, disabled: false,
  lanes: [
    { id: "five_hour", label: "5h", pct: 96, resetAt: NOW - 15 * HOUR },
    { id: "seven_day", label: "7d", pct: 84, resetAt: NOW - 17 * HOUR },
  ],
  headroom: 4, fetchedAt: (NOW - 18 * HOUR) * 1000, nextAt: null, stale: true, error: null,
};

const row = (a: Account, opened: boolean) => renderToStaticMarkup(createElement(AccountRow, {
  a, nowSec: NOW, opened, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
  onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
  onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
  issueExpanded: false, onOpenIssue: () => {},
} as never));

const report = (a: Account) =>
  renderToStaticMarkup(createElement(UsageReportBody, { accounts: [a], nowSec: NOW, held: null }));

/** What markup shows the eye: without what only a screen reader hears, and
 *  without its tags. */
const seen = (html: string) => html
  .replace(/<span class="vis-hidden">[^<]*<\/span>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** One window's line on the open row, from its label to its reset slot. */
const laneOf = (html: string, label: string) =>
  new RegExp(`<div class="ap-lane"[^>]*><span class="ap-lane-label" title="${label}">[^]*?class="ap-lane-reset"[^>]*>[^]*?</span></div>`)
    .exec(html)?.[0] ?? "";

/** What the shut row says of one window, without its label. */
const shutSays = (html: string, label: string) =>
  seen(new RegExp(`<span class="ap-q"[^>]*><span class="ap-q-label">${label}</span>[^]*?</span></span>`).exec(html)?.[0] ?? "")
    .replace(label, "").trim();

const WINDOWS = [
  { label: "5h", said: "Reset 15h ago, 96% when read 18h ago" },
  { label: "7d", said: "Reset 17h ago, 84% when read 18h ago" },
];

describe("an open account row whose windows have reset since a reading that is frozen", () => {
  it("says reset where a frozen row's number was, once its window has reset", () => {
    const open = row(frozenAndReset, true);
    for (const { label, said } of WINDOWS) {
      const lane = laneOf(open, label);
      expect(lane, `the ${label} line was not found`).not.toBe("");
      expect(seen(lane)).toBe(`${label} reset`);
      // When, and at what, on hover and for a screen reader — the report's words.
      expect(lane).toContain(`title="${said}"`);
      expect(lane).toContain(`<span class="vis-hidden">${said}</span>`);
    }
    // Never the old window's number, and never a 0% the deck was not given.
    expect(seen(open)).not.toMatch(/\b(96|84|0)%/);
  });

  it("draws a reset window's bar empty, not full to the reading before the reset", () => {
    const open = row(frozenAndReset, true);
    for (const { label } of WINDOWS) {
      const lane = laneOf(open, label);
      expect(lane).toContain('<div class="ap-lane-track"></div>');
      expect(lane).not.toContain("ap-lane-fill");
    }
  });

  it("keeps a frozen window still running at its last number, as a record", () => {
    const running: Account = {
      ...frozenAndReset,
      lanes: [{ id: "five_hour", label: "5h", pct: 33, resetAt: NOW + 2 * HOUR }, frozenAndReset.lanes[1]],
    };
    const lane = laneOf(row(running, true), "5h");
    expect(seen(lane)).toBe("5h 33%");
    expect(lane).toContain('<div class="ap-lane-fill" style="width:33%;background:var(--muted);opacity:0.4"></div>');
    expect(lane).not.toContain("title=\"Reset");
  });

  it("says reset in both views of the account, as the capacity report does", () => {
    const shut = row(frozenAndReset, false);
    const open = row(frozenAndReset, true);
    const cells = [...report(frozenAndReset).matchAll(/<td class="ap-report-cell"[^]*?<\/td>/g)].map(m => seen(m[0]));
    expect(cells).toHaveLength(2);
    WINDOWS.forEach(({ label }, i) => {
      const views = {
        shut: shutSays(shut, label),
        open: seen(laneOf(open, label)).replace(label, "").trim(),
        report: cells[i],
      };
      expect(views, `the ${label} window`).toEqual({ shut: "reset", open: "reset", report: "reset" });
    });
  });

  it("lifts the reset word above an inactive row's door, so its hover answers", () => {
    // Every row but the live one is a door laid over the whole row, open or
    // shut. A title under it is never reached by a pointer, and this one is
    // the only place the open row keeps the old number and its times.
    const lifts = [...sheetText().replace(/\/\*[^]*?\*\//g, "")
      .matchAll(/\.ap-account :is\(([^)]+)\)\s*\{\s*position:\s*relative;\s*z-index:\s*1;/g)].map(m => m[1]);
    const raised = lifts.find(selectors => selectors.includes(".ap-age")) ?? "";
    expect(raised).toContain(".ap-lane-pct[data-reset]");
    expect(laneOf(row(frozenAndReset, true), "5h")).toMatch(/<span class="ap-lane-pct"[^>]* data-reset=""/);
  });
});
