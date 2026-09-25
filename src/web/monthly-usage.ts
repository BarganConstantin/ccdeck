import { fmtCost } from "./pricing";
import { rangeTotals, sinceFor, type UsageRange } from "./usage-from-ccusage";

/** How often the topbar phrase asks ccusage again: five minutes. A month's
 *  total moves by a sliver an hour, and every read walks the whole log tree, so
 *  the Usage panel's once a minute bought a number that had not visibly moved
 *  four reads out of five. */
export const MONTHLY_USAGE_POLL_MS = 5 * 60_000;

/** How often the page ASKS whether a read is due — a comparison, not a fetch.
 *  Kept apart from the cadence above so a read is never more than a minute
 *  late, without a timer that fires on the very millisecond a read comes due
 *  and loses the race to it. */
export const MONTHLY_USAGE_CHECK_MS = 60_000;

/**
 * Whether the topbar should ask ccusage for the month now.
 *
 * Only while the phrase is actually drawn. Under the width where it gives way
 * (see `.month-usage` in styles.css) it is `display: none`, and a figure read
 * for a phrase nobody can see is a ccusage run spent on nothing. The same goes
 * for a tab in the background. Otherwise a read is due when none has started in
 * the last MONTHLY_USAGE_POLL_MS, and at once when none has started at all —
 * which is what a phrase that has been hidden since the page loaded, and has
 * just been given the room to show, wants.
 *
 * AND AT ONCE WHEN THE MONTH HAS TURNED. The cadence alone let a read at 23:58
 * on the last day hold the next one until 00:03, and for those minutes last
 * month's total stood under the words "this month" — the label and the number
 * disagreeing, the pairing #737 says has to survive.
 */
export function monthlyReadDue({ shown, tabVisible, lastReadAt, now, lastSince, since }: {
  shown: boolean;
  tabVisible: boolean;
  /** When the last read started, or null before the first. */
  lastReadAt: number | null;
  now: number;
  /** The month the last read asked for, in monthlyUsageSince's form. */
  lastSince?: string | null;
  /** The month a read now would ask for. */
  since?: string;
}): boolean {
  if (!shown || !tabVisible) return false;
  if (lastSince && since && lastSince !== since) return true;
  return lastReadAt === null || now - lastReadAt >= MONTHLY_USAGE_POLL_MS;
}

export interface MonthlyUsage {
  cost: number;
  tokens: number;
}

/** Start of the current LOCAL calendar month in ccusage's YYYYMMDD format. */
export function monthlyUsageSince(now: Date = new Date()): string {
  return sinceFor("month", now);
}

/** The two figures the topbar owns, both from the same ccusage reading. */
export function monthlyUsageFrom(range: UsageRange | null | undefined): MonthlyUsage {
  const totals = rangeTotals(range);
  return { cost: totals.cost, tokens: totals.tokens };
}

/** fmtCost reserves an em dash for zero; an empty month is a real $0.00. */
export function fmtMonthlyCost(cost: number): string {
  return cost > 0 ? fmtCost(cost) : "$0.00";
}
