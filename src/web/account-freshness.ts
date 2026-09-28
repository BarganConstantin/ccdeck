// How old an account's numbers are, and when claude-swap reads them again.
//
// Lifted out of AccountsPanel.tsx unchanged. Both are arithmetic on a stamp and
// the panel's second-resolution clock, and the panel says them in more than one
// place — a row's freshness line, a shut row's age, the warning's popover — so
// they were helpers the component carried rather than anything it drew. Out
// here they can be run rather than read: the suite pinned `ago` by the text of
// its one line and did not pin `due` at all.
import { shortAgoSec } from "./relative-time";

// The accounts panel used to carry its own `countdown` and its own `ago`. The
// usage panel had the same countdown under another name and relative-time.ts
// had the same `ago` under `shortAgo` — and that module's header names THAT
// panel as one of the surfaces it exists to keep in one dialect (#374). Both
// now come from there; the wrapper below is what makes the second one exact
// rather than approximate.

/** The panel's ages, from a millisecond stamp and its second-resolution clock.
 *
 *  `shortAgo` takes a millisecond delta, and `shortAgo(nowSec * 1000 - at)`
 *  would NOT be what the panel computed: flooring a stamp that has a
 *  sub-second part after the subtraction lands a second lower than flooring it
 *  before, which walks every threshold by a second. Subtracting in seconds and
 *  handing the result to the seconds-form helper is character for character the
 *  arithmetic the private copy did. */
export function ago(ms: number, nowSec: number): string {
  return shortAgoSec(nowSec - Math.floor(ms / 1000));
}

/**
 * " · next in 4m" — when claude-swap plans to read this account again.
 *
 * The age alone reads as neglect. The two together read as a cadence, which is
 * what it is: claude-swap sets the interval per account and every surface
 * inherits it, so a number that has not moved in ten minutes is on schedule
 * rather than stuck. Nothing is shown once the read is due, because at that
 * point the answer is "any moment now" and a countdown to zero that lingers is
 * worse than no countdown.
 */
export function due(nextAt: number | null, nowSec: number): string {
  if (!nextAt) return "";
  const s = Math.floor(nextAt / 1000) - nowSec;
  if (s <= 0)  return " · due";
  if (s < 60)  return ` · next in ${s}s`;
  return ` · next in ${Math.round(s / 60)}m`;
}
