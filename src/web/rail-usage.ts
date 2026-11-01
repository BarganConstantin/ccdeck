// What the rail's usage meter (Figma Rail / Usage, 22:831) says, from the one
// quota reading the Usage panel also draws. Pure: RailParts.tsx lays it out and
// the rules for when there is nothing to say are here.
//
// It reads, it never fetches: the reading is use-quota.ts's, held once in
// App.tsx and handed to both this meter and the panel, so the rail adds no
// second poll of /api/quota (which can spawn `claude --print /usage`).
import { quotaPctText } from "./components/QuotaBar";
import { resetCountdown } from "./relative-time";
import type { QuotaData } from "./use-quota";

export interface UsageMeter {
  /** The account as the Usage panel prints it: the plan's name ("Max 20x").
   *  The reading carries no alias or email — `historyAccount` is a hash — so
   *  there is nothing else the panel could say, and nothing is invented. */
  name: string | null;
  /** The 5-hour window, printed as the QuotaBar prints it. */
  pctText: string;
  /** The bar's fill, 0 to 100. */
  fill: number;
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

/** The meter, or null when there is no 5-hour reading to show: no account, the
 *  reading not in yet, a failed read, or a provider without quota windows. */
export function usageMeter(quota: QuotaData | null | undefined, nowSec: number): UsageMeter | null {
  if (!quota?.ok || quota.session5hPct == null || !live(quota.session5hResetAt, nowSec)) return null;
  const capped = Math.min(100, Math.max(0, quota.session5hPct));
  const pctText = quotaPctText(capped);
  const countdown = quota.session5hResetAt ? resetCountdown(quota.session5hResetAt, nowSec) : null;
  const weekPct = quota.week7dPct != null && live(quota.week7dResetAt, nowSec)
    ? Math.min(100, Math.max(0, quota.week7dPct)) : null;
  const name = quota.planLabel || null;
  const reset = countdown ? `Resets in ${countdown}` : null;
  const week = weekPct != null ? `7-day ${quotaPctText(weekPct)}` : null;
  const spoken = ["Usage:", [name, `5-hour limit ${pctText}`, countdown && `resets in ${countdown}`, week].filter(Boolean).join(", ")].join(" ");
  return { name, pctText, fill: capped, reset, week, spoken };
}
