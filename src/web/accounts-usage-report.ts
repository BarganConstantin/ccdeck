// How much of the 5-hour and 7-day quota is left across every Claude account
// (#1707), as the accounts panel's Usage report adds it up.
//
// With ten accounts the panel answers "which one next" row by row, and nothing
// answered the question above it — how much usable quota is there, in all —
// without the reader adding ten pairs of percentages in their head.
//
// THE UNIT IS AN ACCOUNT'S WINDOW. The readings are percentages of each
// account's own limit; the deck is never told what the limit is, in tokens or
// in dollars, and a total in either would be a number it made up. So each
// account that has a reading for a window counts as one full window, and the
// report's "used" is their average: sum of the percentages over the number of
// accounts reporting. If the deck is ever told real limits, the average can
// become a weighted one without the report changing shape.
//
// EACH WINDOW ON ITS OWN, because an account can have a current 7-day reading
// and no 5-hour one. And a reading that is not current is left out of its
// window's total rather than counted, and said: counted as 0% it would read as
// capacity nobody has checked, and counted at its old value it would read as
// usage that may have rolled over since. "Not current" is exactly what the
// panel's rows already draw as frozen:
//
//   - no reading for the window at all;
//   - a login no switch can get past (account-issue.ts's blocksSwitch);
//   - nothing collected for a quarter of an hour (the server's `stale`);
//   - a window whose reset has passed since it was read.
//
// Pure, so the suite can call it. The modal is components/AccountsUsageReport.tsx.
import { accountIssue } from "./account-issue";
import { ago } from "./account-freshness";
import type { Account } from "./claude-accounts";

export type WindowId = "five_hour" | "seven_day";

/** The two windows every account has, by the lane ids the server sends. */
export const REPORT_WINDOWS: ReadonlyArray<{ id: WindowId; label: string; long: string }> = [
  { id: "five_hour", label: "5h", long: "5-hour" },
  { id: "seven_day", label: "7d", long: "7-day" },
];

/** Why a window has no reading that counts, in the report's words. */
export type Unread = "none" | "login" | "stale" | "reset";

/** One account's reading of one window: counted, or not and why. */
export type Cell =
  | { counted: true; pct: number; resetAt: number | null }
  | { counted: false; why: Unread; say: string };

export interface ReportRow {
  num: number;
  name: string;
  active: boolean;
  cells: Record<WindowId, Cell>;
}

export interface WindowTotal {
  id: WindowId;
  label: string;
  long: string;
  /** Accounts with a reading that counts, and accounts in the report. */
  reporting: number;
  total: number;
  /** The average of the counted readings, to one decimal; null when none count. */
  used: number | null;
  /** The soonest reset still ahead among the counted readings, and whose it is. */
  nextReset: { at: number; name: string } | null;
}

export interface UsageReport {
  rows: ReportRow[];
  windows: WindowTotal[];
}

/** The name the panel calls an account by. */
export const accountName = (a: Account) => a.alias ?? a.email ?? `account ${a.num}`;

/** One account's reading of one window, or why it does not count. */
export function readingOf(a: Account, id: WindowId, nowSec: number): Cell {
  const label = REPORT_WINDOWS.find(w => w.id === id)!.label;
  const lane = (a.lanes ?? []).find(l => l.id === id);
  // In the order a reader would fix them: a login that cannot be used says
  // more than the age of the numbers it left behind.
  const issue = accountIssue(a, nowSec);
  if (issue?.blocksSwitch) return { counted: false, why: "login", say: issue.text };
  if (!lane || !Number.isFinite(lane.pct)) return { counted: false, why: "none", say: `No ${label} reading` };
  if (a.stale) {
    const age = a.fetchedAt ? ago(a.fetchedAt, nowSec) : null;
    return { counted: false, why: "stale", say: age ? `Last read ${age}` : "Never read" };
  }
  if (lane.resetAt != null && lane.resetAt <= nowSec) {
    return { counted: false, why: "reset", say: "Reset since it was read" };
  }
  return { counted: true, pct: Math.min(100, Math.max(0, lane.pct)), resetAt: lane.resetAt };
}

/** A window's total over the rows. */
export function windowTotal(rows: readonly ReportRow[], id: WindowId): WindowTotal {
  const w = REPORT_WINDOWS.find(x => x.id === id)!;
  let sum = 0;
  let count = 0;
  let nextReset: WindowTotal["nextReset"] = null;
  for (const r of rows) {
    const c = r.cells[id];
    if (!c.counted) continue;
    sum += c.pct;
    count++;
    if (c.resetAt != null && (!nextReset || c.resetAt < nextReset.at)) nextReset = { at: c.resetAt, name: r.name };
  }
  return {
    id, label: w.label, long: w.long,
    reporting: count,
    total: rows.length,
    used: count ? Math.round((sum / count) * 10) / 10 : null,
    nextReset,
  };
}

/**
 * The report for these accounts, in the order given — the panel hands them
 * over as it lists them, the live account first — so the rows under the totals
 * are the rows the reader already knows.
 */
export function usageReport(accounts: readonly Account[], nowSec: number): UsageReport {
  const rows: ReportRow[] = accounts.map(a => ({
    num: a.num,
    name: accountName(a),
    active: a.active,
    cells: {
      five_hour: readingOf(a, "five_hour", nowSec),
      seven_day: readingOf(a, "seven_day", nowSec),
    },
  }));
  return { rows, windows: REPORT_WINDOWS.map(w => windowTotal(rows, w.id)) };
}

/**
 * The two figures a window's block prints, as whole percents that add up to a
 * hundred: "used" rounded, and "available" as the rest of it. Rounding both on
 * their own could print 27% used and 74% available.
 */
export function usedAndAvailable(used: number): { used: number; available: number } {
  const u = Math.round(used);
  return { used: u, available: 100 - u };
}
