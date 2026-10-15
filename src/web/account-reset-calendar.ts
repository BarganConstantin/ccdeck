import type { Account } from "./claude-accounts";
import { accountIssue } from "./account-issue";
import { ago } from "./account-freshness";
import { accountName, observationAt, readingOf, REPORT_STALE_MS } from "./accounts-usage-report";
import { laneKey } from "./lane-open";

export interface ResetEntry {
  key: string;
  name: string;
  active: boolean;
  heldOut: boolean;
  at: number | null;
  used: number | null;
  stale: boolean;
  note: string | null;
}

export interface ResetDay {
  key: string;
  date: Date;
  entries: ResetEntry[];
  scheduled: number;
  outdated: number;
}

export type UnscheduledReset = ResetEntry & { reason: "unknown" | "passed" | "outside" };

/** Calendar keys come from local fields, never the UTC date of an ISO string. */
export function resetDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Today and six more local calendar days. Reported timestamps are seconds;
 *  no countdown rounding, fixed 24-hour steps, or guessed next weekly reset. */
export function resetCalendar(accounts: readonly Account[], nowSec: number, held = false): {
  days: ResetDay[];
  unscheduled: UnscheduledReset[];
} {
  const now = new Date(nowSec * 1000);
  const days: ResetDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    return { key: resetDayKey(date), date, entries: [], scheduled: 0, outdated: 0 };
  });
  const byDate = new Map(days.map(day => [day.key, day]));
  const unscheduled: UnscheduledReset[] = [];
  for (const account of accounts) {
    const lane = account.lanes.find(l => l.id === "seven_day");
    const raw = lane?.resetAt;
    const at = raw != null && raw > 0 && Number.isFinite(raw) && Number.isFinite(new Date(raw * 1000).getTime()) ? raw : null;
    const cell = readingOf(account, "seven_day", nowSec);
    const issue = accountIssue(account, nowSec);
    const observed = observationAt(account.fetchedAt);
    const unread = observed == null;
    const stale = held || unread || account.stale || account.staleCopy === true || account.stopped === true
      || issue?.blocksSwitch === true || nowSec * 1000 - observed! > REPORT_STALE_MS;
    const note = held ? "Last saved reading"
      : issue?.blocksSwitch || account.staleCopy || account.stopped ? issue?.text ?? "Not collecting"
      : unread ? "Never read"
      : stale ? `${account.stale ? "Marked stale · " : ""}Read ${ago(observed!, nowSec)}` : null;
    const entry: ResetEntry = {
      key: laneKey(account), name: accountName(account), active: account.active,
      heldOut: account.disabled, at, used: cell.counted ? cell.pct : cell.last,
      stale, note,
    };
    if (at == null) unscheduled.push({ ...entry, reason: "unknown" });
    else if (at <= nowSec) unscheduled.push({ ...entry, reason: "passed" });
    else {
      const day = byDate.get(resetDayKey(new Date(at * 1000)));
      if (!day) unscheduled.push({ ...entry, reason: "outside" });
      else {
        day.entries.push(entry);
        if (stale) day.outdated++; else day.scheduled++;
      }
    }
  }
  for (const day of days) day.entries.sort((a, b) => a.at! - b.at!);
  return { days, unscheduled };
}
