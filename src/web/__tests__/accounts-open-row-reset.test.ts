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

/** One window's lane on a row, from its short name to its reset. */
// CHANGED ON PURPOSE (#2644): every row, shut or open, draws each window as a
// lane — its short name (the whole name its title), a bar, its number or
// "reset", and when it resets — and the row has no meter of its own.
const laneOf = (html: string, label: string) =>
  new RegExp(`<div class="ap-lane"><span class="ap-lane-label" title="[^"]*">${label}</span>[^]*?</div>`)
    .exec(html)?.[0] ?? "";

/** What the shut row says of one window, without its label. */
// CHANGED ON PURPOSE (#2644): the shut row says it on the window's own lane,
// the same lane the open row draws.
const shutSays = (html: string, label: string) =>
  seen(laneOf(html, label)).replace(label, "").trim();

// CHANGED ON PURPOSE (user feedback): the open row names the week's window
// "Weekly", beside the model lanes that run a week too.
const WINDOWS = [
  { label: "5h", name: "5-hour", said: "Reported reset time passed 15h ago, 96% when read 18h ago" },
  { label: "7d", name: "Weekly", said: "Reported reset time passed 17h ago, 84% when read 18h ago" },
];

describe("an open account row whose windows have reset since a reading that is frozen", () => {
  it("says reset where a frozen row's number was, once its window has reset", () => {
    const open = row(frozenAndReset, true);
    for (const { label, name, said } of WINDOWS) {
      const lane = laneOf(open, label);
      expect(lane, `the ${label} line was not found`).not.toBe("");
      // CHANGED ON PURPOSE (#2644): the lane leads with the short name, as the
      // shut row's always did, and keeps the whole one in its title.
      expect(seen(lane)).toBe(`${label} reset`);
      expect(lane).toContain(`<span class="ap-lane-label" title="${name}">${label}</span>`);
      // When, and at what, on hover and for a screen reader — the report's words.
      expect(lane).toContain(`title="${said}"`);
      expect(lane).toContain(`<span class="vis-hidden">${said}</span>`);
    }
    // Never the old window's number, and never a 0% the deck was not given.
    expect(seen(open)).not.toMatch(/\b(96|84|0)%/);
  });

  it("draws a reset window's bar empty, not full to the reading before the reset", () => {
    // CHANGED ON PURPOSE (#2644): every window draws its own bar, shut or
    // open, and the row has no meter beside them; a window that has reset is
    // an empty track on its lane.
    for (const opened of [false, true]) {
      const html = row(frozenAndReset, opened);
      expect(html).not.toContain("ap-meter");
      expect(html).not.toContain("ap-lane-fill");
      for (const { label } of WINDOWS) {
        expect(laneOf(html, label), `the ${label} lane, ${opened ? "open" : "shut"}`)
          .toContain('<span class="ap-lane-track" aria-hidden="true"></span>');
      }
    }
  });

  it("keeps a frozen window still running at its last number, as a record", () => {
    const running: Account = {
      ...frozenAndReset,
      lanes: [{ id: "five_hour", label: "5h", pct: 33, resetAt: NOW + 2 * HOUR }, frozenAndReset.lanes[1]],
    };
    const lane = laneOf(row(running, true), "5h");
    // CHANGED ON PURPOSE (#2644): the short name leads the lane, and a reset
    // still ahead is counted down on an old reading too — when a window ends
    // is not something a later reading moves, and the shut row said it to a
    // screen reader on this row before, so the accounts compare on it.
    expect(seen(lane)).toBe("5h 33% 2h 00m");
    expect(lane).toContain('<span class="vis-hidden">resets in </span>2h 00m');
    // In the record's one ink: no warning colour, and its own bar in the muted ink.
    expect(lane).not.toContain("data-level");
    expect(lane).toContain('<span class="ap-lane-fill" style="width:33%;background:var(--muted);opacity:1"></span>');
    expect(lane).not.toContain("title=\"Reported reset time passed");
  });

  it("preserves panel reset wording while qualifying the report estimate", () => {
    const shut = row(frozenAndReset, false);
    const open = row(frozenAndReset, true);
    // CHANGED ON PURPOSE (V4's Figma): the report's cell now ends with a second
    // line, when the window resets (pinned in accounts-report-window-lines). This
    // compares the figure each view gives for the window, as it always did.
    const cells = [...report(frozenAndReset).matchAll(/<td class="ap-report-cell"[^]*?<\/td>/g)].map(m => seen(m[0].replace(/<span class="ap-report-mobile-label"[^]*?<\/span>/g, "").replace(/<span class="ap-report-win-sub"[^]*$/, "")));
    expect(cells).toHaveLength(2);
    WINDOWS.forEach(({ label }, i) => {
      const views = {
        shut: shutSays(shut, label),
        open: seen(laneOf(open, label)).replace(label, "").trim(),
        report: cells[i],
      };
      expect(views, `the ${label} window`).toEqual({ shut: "reset", open: "reset", report: i === 0 ? "96%" : "84%" });
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
