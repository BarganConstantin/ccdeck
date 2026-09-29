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
// usage that may have rolled over since. Not current is:
//
//   - no reading for the window at all;
//   - a login no switch can get past (account-issue.ts's blocksSwitch), which
//     the panel's rows draw frozen;
//   - nothing collected for a quarter of an hour — the server's `stale`, and
//     this page's own clock against the reading's time, because the server's
//     flag is only as fresh as the last poll that reached it;
//   - a window whose reset has passed since it was read.
//
// AND AN AVERAGE PER WINDOW CANNOT SAY WHICH WINDOW HOLDS AN ACCOUNT BACK. An
// account at 12% of its 5 hours and 100% of its week adds 88 points of "5h
// available" that nobody can use. So the report leads with how many accounts
// have room in both — the panel's own "free" measure, which is the tighter of
// the two — and gives each row a state that names the spent window (#1713).
//
// Pure, so the suite can call it. The modal is components/AccountsUsageReport.tsx.
import { accountIssue } from "./account-issue";
import { ago } from "./account-freshness";
import type { Account } from "./claude-accounts";
import { laneKey } from "./lane-open";

export type WindowId = "five_hour" | "seven_day";

/** The two windows every account has, by the lane ids the server sends. */
export const REPORT_WINDOWS: ReadonlyArray<{ id: WindowId; label: string; long: string }> = [
  { id: "five_hour", label: "5h", long: "5-hour" },
  { id: "seven_day", label: "7d", long: "7-day" },
];

/** Why a window has no reading that counts, in the report's words. */
export type Unread = "none" | "login" | "stale" | "reset";

/** One account's reading of one window: counted, or not and why — with the
 *  number it last had, when it had one, for the row to show dimmed. */
export type Cell =
  | { counted: true; pct: number; resetAt: number | null }
  | { counted: false; why: Unread; say: string; last: number | null };

export interface ReportRow {
  num: number;
  /** Who the row is, as laneKey names it — for the report's held order. */
  key: string;
  name: string;
  active: boolean;
  /** Held out of rotation: counted like any account, but the panel offers no
   *  Switch to it, so the row says so. */
  heldOut: boolean;
  cells: Record<WindowId, Cell>;
  /** What the row can do now — see statusOf. */
  status: Status;
}

/**
 * What an account can do now, from its two readings (#1713).
 *
 * Two questions, kept apart: can the readings be trusted, and then how many
 * windows are spent. A reading that is not current — none, too old, a window
 * reset since, a login no switch gets past — makes the row `stale`, whatever
 * its last numbers were: an account is never called ready on a reading the
 * report would not count. Otherwise it is `ready` with room in both windows,
 * `limited` with one at 100%, and `exhausted` with both. Near a limit is not a
 * state of its own; the row's number wears the warning ink instead.
 */
export type Status = "ready" | "limited" | "exhausted" | "stale";

export function statusOf(cells: Record<WindowId, Cell>): Status {
  const f = cells.five_hour, s = cells.seven_day;
  if (!f.counted || !s.counted) return "stale";
  const spent = Number(f.pct >= 100) + Number(s.pct >= 100);
  return spent === 0 ? "ready" : spent === 1 ? "limited" : "exhausted";
}

/** Why a stale row is stale, in the words its first unread reading gives. */
export function staleReason(cells: Record<WindowId, Cell>): string | null {
  for (const w of REPORT_WINDOWS) {
    const c = cells[w.id];
    if (!c.counted) return c.say;
  }
  return null;
}

/** How old a reading may be and still count — the server's own line. */
export const REPORT_STALE_MS = 15 * 60_000;

export interface WindowTotal {
  id: WindowId;
  label: string;
  long: string;
  /** Accounts with a reading that counts, and accounts in the report. */
  reporting: number;
  total: number;
  /** The average of the counted readings, unrounded; null when none count.
   *  Rounded once, where it is printed — see usedAndAvailable. */
  used: number | null;
  /** The soonest reset still ahead among the counted readings: whose, at what
   *  reading, and how many more accounts reset in the same minute. */
  nextReset: { at: number; name: string; pct: number; more: number } | null;
}

export interface UsageReport {
  rows: ReportRow[];
  windows: WindowTotal[];
  /** Accounts with a current reading in both windows and room in both. */
  roomInBoth: number;
}

/** The name the panel calls an account by. */
export const accountName = (a: Account) => a.alias ?? a.email ?? `account ${a.num}`;

/** One account's reading of one window, or why it does not count. */
export function readingOf(a: Account, id: WindowId, nowSec: number): Cell {
  const label = REPORT_WINDOWS.find(w => w.id === id)!.label;
  const lane = (a.lanes ?? []).find(l => l.id === id);
  const last = lane && Number.isFinite(lane.pct) ? clamp(lane.pct) : null;
  // In the order a reader would fix them: a login that cannot be used says
  // more than the age of the numbers it left behind.
  const issue = accountIssue(a, nowSec);
  if (issue?.blocksSwitch) return { counted: false, why: "login", say: issue.text, last };
  if (last == null) return { counted: false, why: "none", say: `No ${label} reading`, last: null };
  const old = a.stale || a.fetchedAt == null || nowSec * 1000 - a.fetchedAt > REPORT_STALE_MS;
  if (old) {
    return { counted: false, why: "stale", say: a.fetchedAt ? `Updated ${ago(a.fetchedAt, nowSec)}` : "Never read", last };
  }
  if (lane!.resetAt != null && lane!.resetAt <= nowSec) {
    // Good news the numbers have not caught up with: the window has come back
    // since this was read, so the account is likely emptier than it says.
    return { counted: false, why: "reset", say: `Reset ${ago(lane!.resetAt * 1000, nowSec)}, not updated`, last };
  }
  return { counted: true, pct: last, resetAt: lane!.resetAt };
}

const clamp = (pct: number) => Math.min(100, Math.max(0, pct));

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
    if (c.resetAt == null) continue;
    // "The same minute": resets are stamped to the second, and two accounts
    // coming back within one are one moment to a reader.
    if (!nextReset || c.resetAt < nextReset.at - 59) nextReset = { at: c.resetAt, name: r.name, pct: c.pct, more: 0 };
    else if (c.resetAt - nextReset.at < 60) nextReset.more++;
  }
  return {
    id, label: w.label, long: w.long,
    reporting: count,
    total: rows.length,
    used: count ? sum / count : null,
    nextReset,
  };
}

/**
 * The report for these accounts, in the order given — the panel hands them
 * over as it lists them, the live account first — so the rows under the totals
 * are the rows the reader already knows.
 */
export function usageReport(accounts: readonly Account[], nowSec: number): UsageReport {
  const rows: ReportRow[] = accounts.map(a => {
    const cells = {
      five_hour: readingOf(a, "five_hour", nowSec),
      seven_day: readingOf(a, "seven_day", nowSec),
    };
    return {
      num: a.num,
      key: laneKey(a),
      name: accountName(a),
      active: a.active,
      heldOut: a.disabled === true,
      cells,
      status: statusOf(cells),
    };
  });
  // Counted off the rows' own status, so the lead's "7 of 9 ready" and the
  // rows that say Ready cannot disagree.
  const roomInBoth = rows.filter(r => r.status === "ready").length;
  return { rows, windows: REPORT_WINDOWS.map(w => windowTotal(rows, w.id)), roomInBoth };
}

/**
 * A used percent as a whole number to print, which says 100 only at the limit
 * (#1713). The states are decided on the unrounded reading, so 99.6% is room:
 * Ready, and counted as ready. Rounded plainly it printed "100%" on that row,
 * and "0% remaining" on a card whose lead said the account was ready.
 */
export function shownUsed(pct: number): number {
  return pct >= 100 ? 100 : Math.min(99, Math.round(pct));
}

/**
 * The two figures a window's block prints, as whole percents that add up to a
 * hundred: "used" rounded, and "available" as the rest of it. Rounding both on
 * their own could print 27% used and 74% available.
 */
export function usedAndAvailable(used: number): { used: number; available: number } {
  const u = shownUsed(used);
  return { used: u, available: 100 - u };
}

/**
 * Why the report is showing the last readings rather than this poll's, in the
 * words it prints: the panel's own line for a reload that failed, or the empty
 * answer a store gives while claude-swap rewrites it. Null when nothing is
 * being held back — including an empty roster the report never had rows for.
 */
export function heldNote(failed: string | null, empty: boolean, hadRows: boolean): string | null {
  if (failed) return `${failed} These are the last readings.`;
  if (empty && hadRows) return "The account store could not be read just now. These are the last readings.";
  return null;
}
