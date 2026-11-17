// V4 top-10 #9: the same number has the same colour everywhere. A 5-hour
// window at 86% was calm cyan at the rail's foot and amber "⚠ 86% · high" in
// the Usage panel, because each meter had its own rule. Now one function
// (quotaLevel in QuotaBar.tsx) decides a quota reading's level for the whole
// web UI, and every quota meter draws its figure (LevelMark) and its fill
// (quotaFill) from it.
//
// What these pin: at 45, 86 and 97 the rail's meter, the Usage panel's bar, an
// account's row (shut and open) and the Account capacity report's cell agree on
// the level and on the fill; a rail meter split by session draws every part in
// the one fill colour; and the reset calendar's reading wears the same level.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBar, { quotaFill, quotaLevel } from "../components/QuotaBar";
import { RailUsage } from "../components/RailParts";
import AccountRow from "../components/AccountRow";
import { UsageReportBody } from "../components/AccountsUsageReport";
import AccountResetCalendar from "../components/AccountResetCalendar";
import { railSegments, usageMeter } from "../rail-usage";
import type { Account } from "../claude-accounts";
import type { QuotaData } from "../use-quota";
import { sheetText } from "./sheet-source";

const NOW = 1_800_000_000;
const HOUR = 3600;
const css = sheetText();

type Level = "warn" | "err" | null;
/** The level the figure wears (LevelMark's tone), or null when it wears none. */
const markTone = (html: string): Level => (/<span class="level-mark" data-tone="(warn|err)">/.exec(html)?.[1] as Level) ?? null;

// ── The four surfaces, each asked for the same 5-hour reading ──────────────

function rail(pct: number, shares?: number[]) {
  const reading: QuotaData = { ok: true, planLabel: "Max 20x", session5hPct: pct, session5hResetAt: NOW + 2 * HOUR };
  const meter = usageMeter({ reading, readAt: NOW * 1000, failed: false }, NOW * 1000)!;
  // No caller passes a split today (rail-usage.ts); the meter draws one when given.
  const drawn = shares ? { ...meter, segments: railSegments(shares) } : meter;
  const html = renderToStaticMarkup(createElement(RailUsage, { meter: drawn, onPress: () => {} }));
  const fills = [...html.matchAll(/class="sl-usage-seg" style="[^"]*background:(var\(--[\w-]+\))/g)].map(m => m[1]);
  return { level: markTone(html), fills, html };
}

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
  // The shut row's head figure: the mark alone, its level on the attribute.
  const head = /<span class="ap-value ap-q-pct"(?: data-level="(warn|err)")?/.exec(html);
  const lane = /<div class="ap-lane">[^]*?<\/div>/.exec(html)?.[0] ?? "";
  return {
    level: (head?.[1] as Level) ?? null,
    laneLevel: markTone(lane),
    fill: /class="ap-meter-fill" style="[^"]*background:(var\(--[\w-]+\))/.exec(html)?.[1],
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
  ] as const)("at %d%% the rail, the Usage panel, an account row and the report say %s, in %s", (pct, level, fill) => {
    expect(quotaLevel(pct)).toBe(level);
    expect(quotaFill(quotaLevel(pct))).toBe(fill);

    const r = rail(pct);
    const u = usagePanel(pct);
    const a = accountRow(pct);
    const open = accountRow(pct, true);
    const rep = reportCell(pct);

    // The figure's level, the same on every surface.
    expect({ rail: r.level, usage: u.level, row: a.level, lane: open.laneLevel, report: rep.level })
      .toEqual({ rail: level, usage: level, row: level, lane: level, report: level });
    // The fill, the same token on every surface.
    expect({ rail: r.fills, usage: u.fill, row: a.fill, report: reportFill(rep.barLevel) })
      .toEqual({ rail: [fill], usage: fill, row: fill, report: fill });
  });

  it("says high in words beside the figure from 70, on the rail as in the Usage panel", () => {
    expect(rail(86).html).toContain('<span class="level-mark-word">high</span>');
    expect(rail(45).html).not.toContain("level-mark");
  });
});

describe("a rail meter split by session", () => {
  it("draws every part of an 86% fill in --warn: the split is shape, not colour", () => {
    const { fills, level } = rail(86, [5, 3, 2]);
    expect(level).toBe("warn");
    expect(fills).toEqual(["var(--warn)", "var(--warn)", "var(--warn)"]);
  });

  it("keeps the parts apart by a 2px gap, and gives them no colour of their own in the sheet", () => {
    expect(css).toMatch(/\.session-list \.sl-usage-fill \{[^}]*gap: 2px;/);
    expect(css).not.toMatch(/\.sl-usage-seg[^{]*\{[^}]*background/);
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
