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
  | {
    counted: false; why: Unread; say: string; last: number | null;
    /** What the windows' totals take for it (#1713): the last reading, or 0
     *  for a window that has reset since it was read — that reading belongs to
     *  the window before — and null when there has never been a reading. */
    estimate: number | null;
    /** Its reset, when the last reading had one still ahead. */
    resetAt: number | null;
  };

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
  /** When the account was last read, in ms; null when it never was. */
  updatedAt: number | null;
}

/**
 * What an account can do now, from its two readings (#1713).
 *
 * FROM THE LAST NUMBER, HOWEVER OLD. Inactive accounts are read on
 * claude-swap's own plan, often slower than the report's fifteen minutes, and
 * an account nobody is using spends nothing between two reads — so its last
 * reading is its reading, near enough. A window that has reset since it was
 * read is taken as unused. The row still says the reading is old; it is not
 * held back from Ready for it.
 *
 * Stale is left for an account the numbers cannot speak for: one never read in
 * a window, or one behind a login no switch gets past, whose room cannot be
 * used whatever it shows. Otherwise it is `ready` with room in both windows,
 * `limited` with one at 100%, and `exhausted` with both. Near a limit is not a
 * state of its own; the row's number wears the warning ink instead.
 */
export type Status = "ready" | "limited" | "exhausted" | "stale";

/** The number a window is taken at — the current reading, or the estimate
 *  for one that is not — or null when there is none to take. */
function takenAt(c: Cell): number | null {
  if (c.counted) return c.pct;
  return c.why === "login" ? null : c.estimate;
}

export function statusOf(cells: Record<WindowId, Cell>): Status {
  const f = takenAt(cells.five_hour), s = takenAt(cells.seven_day);
  if (f == null || s == null) return "stale";
  const spent = Number(f >= 100) + Number(s >= 100);
  return spent === 0 ? "ready" : spent === 1 ? "limited" : "exhausted";
}

/**
 * The row's Updated column (#1713): how current the numbers it was judged on
 * are, in one short word or phrase, so the Status column can stay one word.
 *
 * "now" for a current reading — the report's own fifteen-minute line — and the
 * age for an older one, since the row is still judged on it. A row the numbers
 * cannot speak for says why instead of when: a login no switch gets past, or a
 * window never read. `old` is whether the reader should notice it.
 */
export function freshness(row: ReportRow, nowSec: number): { text: string; old: boolean } {
  const cells = REPORT_WINDOWS.map(w => row.cells[w.id]);
  for (const c of cells) {
    if (!c.counted && (c.why === "login" || c.why === "none")) return { text: c.say, old: true };
  }
  if (row.updatedAt == null) return { text: "never read", old: true };
  if (cells.every(c => c.counted)) return { text: "now", old: false };
  return { text: ago(row.updatedAt, nowSec), old: true };
}

/** How old a reading may be and still count — the server's own line. */
export const REPORT_STALE_MS = 15 * 60_000;

export interface WindowTotal {
  id: WindowId;
  label: string;
  long: string;
  /** Accounts with a current reading, accounts in the total — the current
   *  ones and the stale ones at their last reading — and accounts in the
   *  report. `total - included` have never been read. */
  reporting: number;
  included: number;
  total: number;
  /** The average over the accounts in the total, unrounded; null when none
   *  has a number. Rounded once, where it is printed — see usedAndAvailable. */
  used: number | null;
  /** The soonest reset still ahead among the accounts in the total: whose, at
   *  what reading, and how many more accounts reset in the same minute. */
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
  const lapsed = lane?.resetAt != null && lane.resetAt <= nowSec;
  const unread = (why: Unread, say: string): Cell => ({
    counted: false, why, say, last,
    estimate: last == null ? null : lapsed ? 0 : last,
    resetAt: lapsed ? null : lane?.resetAt ?? null,
  });
  if (issue?.blocksSwitch) return unread("login", issue.text);
  if (last == null) return unread("none", `No ${label} reading`);
  const old = a.stale || a.fetchedAt == null || nowSec * 1000 - a.fetchedAt > REPORT_STALE_MS;
  if (old) return unread("stale", a.fetchedAt ? `Updated ${ago(a.fetchedAt, nowSec)}` : "Never read");
  if (lapsed) {
    // Good news the numbers have not caught up with: the window has come back
    // since this was read, so the account is likely emptier than it says.
    return unread("reset", `Reset ${ago(lane!.resetAt! * 1000, nowSec)}, not updated`);
  }
  return { counted: true, pct: last, resetAt: lane!.resetAt };
}

const clamp = (pct: number) => Math.min(100, Math.max(0, pct));

/** A window's total over the rows. */
export function windowTotal(rows: readonly ReportRow[], id: WindowId): WindowTotal {
  const w = REPORT_WINDOWS.find(x => x.id === id)!;
  let sum = 0;
  let count = 0;
  let included = 0;
  const resets: Array<{ at: number; name: string; pct: number }> = [];
  for (const r of rows) {
    const c = r.cells[id];
    // EVERY ACCOUNT WITH A NUMBER IS IN THE TOTAL (#1713). Inactive accounts
    // are read on claude-swap's own plan, which is often slower than the
    // report's fifteen minutes, so a total of the fresh ones alone was a total
    // of whichever few happened to be read lately. A stale one counts at its
    // last reading and says so; the row still marks it Stale.
    const pct = c.counted ? c.pct : c.estimate;
    if (pct == null) continue;
    sum += pct;
    included++;
    if (c.counted) count++;
    if (c.resetAt != null) resets.push({ at: c.resetAt, name: r.name, pct });
  }
  // The soonest reset, and every other account back within a minute of it,
  // taken from the whole list (#1796): the rows come in the panel's order, the
  // live account first, and one pass over them kept or forgot accounts by where
  // they were listed. A tie names the one listed first. "The same minute":
  // resets are stamped to the second, and two accounts coming back within one
  // are one moment to a reader.
  const first = resets.reduce<(typeof resets)[number] | null>((a, x) => (!a || x.at < a.at ? x : a), null);
  const nextReset: WindowTotal["nextReset"] = first && {
    ...first, more: resets.filter(x => x !== first && x.at - first.at < 60).length,
  };
  return {
    id, label: w.label, long: w.long,
    reporting: count,
    included,
    total: rows.length,
    used: included ? sum / included : null,
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
      updatedAt: a.fetchedAt ?? null,
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
