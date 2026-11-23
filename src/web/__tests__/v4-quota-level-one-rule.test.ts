// Quota colors agree across Usage and the Accounts views.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBar, { quotaFill, quotaLevel } from "../components/QuotaBar";
import AccountRow from "../components/AccountRow";
import { UsageReportBody } from "../components/AccountsUsageReport";
import AccountResetCalendar from "../components/AccountResetCalendar";
import type { Account } from "../claude-accounts";
import { sheetText } from "./sheet-source";

const NOW = 1_800_000_000;
const HOUR = 3600;
const css = sheetText();

type Level = "warn" | "err" | null;
/** The level the figure wears (LevelMark's tone), or null when it wears none. */
const markTone = (html: string): Level => (/<span class="level-mark" data-tone="(warn|err)">/.exec(html)?.[1] as Level) ?? null;

// Each surface is given the same reading.

function usagePanel(pct: number) {
  const html = renderToStaticMarkup(createElement(QuotaBar, { pct, label: "5-hour window", nowSec: NOW }));
  return { level: markTone(html), fill: /class="qb-fill"[^>]*background:(var\(--[\w-]+\))/.exec(html)?.[1] };
}

const account = (pct: number): Account => ({
  num: 1, email: "reader@example.com", alias: null, org: null, active: true, disabled: false,
  lanes: [
    { id: "five_hour", label: "5h", pct, resetAt: NOW + 2 * HOUR },
    { id: "seven_day", label: "7d", pct: 10, resetAt: NOW + 3 * 86_400 },
  ],
  headroom: 100 - pct, fetchedAt: (NOW - 60) * 1000, nextAt: (NOW + 240) * 1000, stale: false, error: null,
} as Account);

function accountRow(pct: number, opened = false) {
  const html = renderToStaticMarkup(createElement(AccountRow, {
    a: account(pct), nowSec: NOW, opened, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
    onDismissRefusal: () => {}, onSignIn: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));
  // CHANGED ON PURPOSE (#2644): the row's figures are its lanes', shut or
  // open — the first window's figure, its warning mark and its level on the
  // attribute — and each lane draws its own bar where the row drew one meter.
  const lane = /<div class="ap-lane">[^]*?<\/div>/.exec(html)?.[0] ?? "";
  const figure = /<span class="ap-lane-pct"(?: data-level="(warn|err)")?/.exec(lane);
  const marked = /<span class="ap-lane-pct" data-level="(warn|err)" title="high"><svg[^>]*class="level-mark-glyph"/.exec(lane);
  return {
    level: (figure?.[1] as Level) ?? null,
    laneLevel: (marked?.[1] as Level) ?? null,
    fill: /class="ap-lane-fill" style="[^"]*background:(var\(--[\w-]+\))/.exec(lane)?.[1],
  };
}

function reportCell(pct: number) {
  const html = renderToStaticMarkup(createElement(UsageReportBody, { accounts: [account(pct)], nowSec: NOW, held: null }));
  const cell = /<td class="ap-report-cell">[^]*?<\/td>/.exec(html)![0];
  const bar = /<span class="ap-report-meter"(?: data-level="(warn|err)")?/.exec(cell);
  return { level: markTone(cell), barLevel: (bar?.[1] as Level) ?? null };
}

/** The fill the sheet gives the report's row bar at a level. */
function reportFill(level: Level): string | undefined {
  const sel = level ? `\\.ap-report-fig \\.ap-report-meter\\[data-level="${level}"\\] i` : "\\.ap-report-meter i";
  return new RegExp(`${sel} \\{[^}]*background: (var\\(--[\\w-]+\\))`).exec(css)?.[1];
}

describe("one quota level for every meter (V4 top-10 #9)", () => {
  it.each([
    [45, null, "var(--accent)"],
    [86, "warn", "var(--warn)"],
    [97, "err", "var(--err)"],
  ] as const)("at %d%% the Usage panel, an account row and the report say %s, in %s", (pct, level, fill) => {
    expect(quotaLevel(pct)).toBe(level);
    expect(quotaFill(quotaLevel(pct))).toBe(fill);

    const u = usagePanel(pct);
    const a = accountRow(pct);
    const open = accountRow(pct, true);
    const rep = reportCell(pct);

    // The figure's level, the same on every surface.
    expect({ usage: u.level, row: a.level, lane: open.laneLevel, report: rep.level })
      .toEqual({ usage: level, row: level, lane: level, report: level });
    // The fill, the same token on every surface, shut or open.
    expect({ usage: u.fill, row: a.fill, open: open.fill, report: reportFill(rep.barLevel) })
      .toEqual({ usage: fill, row: fill, open: fill, report: fill });
  });

});

describe("the reset calendar's reading", () => {
  const calendar = (used: number) => renderToStaticMarkup(createElement(AccountResetCalendar, {
    accounts: [{ ...account(10), lanes: [
      { id: "five_hour", label: "5h", pct: 10, resetAt: NOW + 2 * HOUR },
      { id: "seven_day", label: "7d", pct: used, resetAt: NOW + 2 * 86_400 },
    ] } as Account],
    nowSec: NOW, held: null,
  }));
  const meterLevel = (html: string) => (/<span class="ap-reset-meter"(?: data-level="(warn|err)")?/.exec(html)?.[1] as Level) ?? null;

  it.each([[45, null], [86, "warn"], [97, "err"]] as const)("wears the shared level at %d%%: %s", (used, level) => {
    const html = calendar(used);
    expect(markTone(/<span class="ap-reset-reading"[^]*?<\/span><\/span>/.exec(html)?.[0] ?? "")).toBe(level);
    expect(meterLevel(html)).toBe(level);
  });

  it("fills its meter in the accent, then the level's ink", () => {
    expect(css).toMatch(/\.ap-reset-meter > span \{[^}]*background: var\(--accent\);/);
    expect(css).toContain('.ap-reset-meter[data-level="warn"] > span { background: var(--warn); }');
    expect(css).toContain('.ap-reset-meter[data-level="err"] > span { background: var(--err); }');
  });
});
