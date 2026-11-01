// What the rail's usage meter (Figma Rail / Usage, 22:831) says, from the Claude
// quota reading the server last took. Pure: RailParts.tsx lays it out and the
// rules for when there is nothing to say are here.
//
// It looks, it never asks: the reading is use-quota.ts's useCachedQuota, an
// answer from the server's memory (/api/quota?cached=1), so the meter causes no
// read of Claude's quota of its own. What it cannot know is how old that memory
// is, so it says: past STALE_MS, or once a window has reset since, the numbers
// are drawn quiet and the meter names the age instead of passing them off as
// now. The click opens the Usage panel, which does the real read.
import { quotaPctText } from "./components/QuotaBar";
import { elapsedShort } from "./elapsed-short";
import { resetCountdown } from "./relative-time";
import type { CachedQuota } from "./use-quota";

/** How old a reading may be and still be drawn as current. The Usage panel
 *  polls every minute while it is open, so ten minutes is "nobody has been
 *  looking", not "one poll was missed". */
export const STALE_MS = 10 * 60_000;

export interface UsageMeter {
  /** The account as the Usage panel prints it: the plan's name ("Max 20x").
   *  The reading carries no alias or email — `historyAccount` is a hash — so
   *  there is nothing else the panel could say, and nothing is invented. */
  name: string | null;
  /** The 5-hour window, printed as the QuotaBar prints it. */
  pctText: string;
  /** The bar's fill, 0 to 100. */
  fill: number;
  /** The reading is old, or a window of it has reset since: drawn quiet. */
  stale: boolean;
  /** "read 12m ago" when stale, else null. */
  readAgo: string | null;
  /** "Resets in 2h 9m", from the panel's own countdown; null without a reset. */
  reset: string | null;
  /** "7-day 31%"; null while the source sent no 7-day reading. */
  week: string | null;
  /** The button's whole name, every figure in one sentence. */
  spoken: string;
}

/** A window whose reset has passed is over and so is its reading: QuotaBar says
 *  "waiting for a new reading" rather than draw it, and the meter draws nothing. */
const live = (resetAt: number | undefined, nowSec: number) => !resetAt || resetAt > nowSec;

/** "last read 12 minutes ago", for the sentence a screen reader gets. */
function minutesAgo(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m === 0 ? "less than a minute ago" : m === 1 ? "1 minute ago" : `${m} minutes ago`;
}

/** The meter, or null when there is no 5-hour reading to show: no account, the
 *  reading not in yet, a failed read, or a provider without quota windows.
 *  `nowMs` is the board's clock, in milliseconds like `readAt`. */
export function usageMeter(cached: CachedQuota | null | undefined, nowMs: number): UsageMeter | null {
  const quota = cached?.reading;
  const nowSec = Math.floor(nowMs / 1000);
  if (!quota?.ok || quota.session5hPct == null || !live(quota.session5hResetAt, nowSec)) return null;
  const age = Math.max(0, nowMs - cached!.readAt);
  const stale = age > STALE_MS || cached!.lapsed;
  const capped = Math.min(100, Math.max(0, quota.session5hPct));
  const pctText = quotaPctText(capped);
  const countdown = quota.session5hResetAt ? resetCountdown(quota.session5hResetAt, nowSec) : null;
  const weekPct = quota.week7dPct != null && live(quota.week7dResetAt, nowSec)
    ? Math.min(100, Math.max(0, quota.week7dPct)) : null;
  const name = quota.planLabel || null;
  const reset = countdown ? `Resets in ${countdown}` : null;
  const week = weekPct != null ? `7-day ${quotaPctText(weekPct)}` : null;
  const readAgo = stale ? `read ${elapsedShort(cached!.readAt, undefined, nowMs)} ago` : null;
  const spoken = [
    "Usage:",
    [name, `5-hour limit ${pctText}`, countdown && `resets in ${countdown}`, week, stale && `last read ${minutesAgo(age)}`]
      .filter(Boolean).join(", "),
  ].join(" ");
  return { name, pctText, fill: capped, stale, readAgo, reset, week, spoken };
}
