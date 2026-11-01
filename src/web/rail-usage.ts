// What the rail's usage meter (V4's Figma Rail / Usage) says, from the Claude
// quota reading the page holds. Pure: RailParts.tsx lays it out and the rules
// for when there is nothing to say are here.
//
// The reading is use-quota.ts's useMeterQuota: the usual /api/quota read once a
// minute while the page is open and visible, never forced. What a held reading
// cannot say is how old it is, so the meter does: past STALE_MS, or after a read
// that failed, the numbers are drawn in --muted and the second line names the
// age instead of passing them off as now. The click opens the Usage panel.
import { quotaLevelColor, quotaPctText } from "./components/QuotaBar";
import { elapsedShort } from "./elapsed-short";
import { resetCountdown } from "./relative-time";
import type { MeterQuota } from "./use-quota";

/** How old a reading may be and still be drawn as current. The poll is a
 *  minute, so ten minutes is "reads have been failing", not "one was missed". */
export const STALE_MS = 10 * 60_000;

export interface UsageMeter {
  /** The active account's alias when the page holds one, else the plan's name
   *  as the Usage panel prints it ("Max 20x"); null when it has neither. */
  name: string | null;
  /** The 5-hour window, printed as the QuotaBar prints it. */
  pctText: string;
  /** The bar's fill, 0 to 100. */
  fill: number;
  /** The fill's colour: the Usage panel bar's own data colour for this
   *  reading, or --muted when the reading is stale. */
  color: string;
  /** The reading is old or the last read failed: drawn quiet. */
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
 *  reading not in yet, or a provider without quota windows. `nowMs` is the
 *  board's clock, in milliseconds like `readAt`. `alias` is the active
 *  account's alias from the roster the page already loads, or null. */
export function usageMeter(held: MeterQuota | null | undefined, nowMs: number, alias: string | null = null): UsageMeter | null {
  const quota = held?.reading;
  const nowSec = Math.floor(nowMs / 1000);
  if (!quota?.ok || quota.session5hPct == null || !live(quota.session5hResetAt, nowSec)) return null;
  const age = Math.max(0, nowMs - held!.readAt);
  const stale = age > STALE_MS || held!.failed;
  const capped = Math.min(100, Math.max(0, quota.session5hPct));
  const pctText = quotaPctText(capped);
  const countdown = quota.session5hResetAt ? resetCountdown(quota.session5hResetAt, nowSec) : null;
  const weekPct = quota.week7dPct != null && live(quota.week7dResetAt, nowSec)
    ? Math.min(100, Math.max(0, quota.week7dPct)) : null;
  const name = alias?.trim() || quota.planLabel || null;
  const reset = countdown ? `Resets in ${countdown}` : null;
  const week = weekPct != null ? `7-day ${quotaPctText(weekPct)}` : null;
  const readAgo = stale ? `read ${elapsedShort(held!.readAt, undefined, nowMs)} ago` : null;
  const spoken = [
    "Usage:",
    [name, `5-hour limit ${pctText}`, countdown && `resets in ${countdown}`, week, stale && `last read ${minutesAgo(age)}`]
      .filter(Boolean).join(", "),
  ].join(" ");
  return { name, pctText, fill: capped, color: stale ? "var(--muted)" : quotaLevelColor(capped), stale, readAgo, reset, week, spoken };
}
