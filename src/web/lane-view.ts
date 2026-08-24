// One account row printed every quota window it had, and the reader did the
// arithmetic.
//
// A row carried three lanes — `5h`, `7d` and one per scoped model — each with a
// label, a bar, a percentage and a `resets 4h 20m` line under it. Measured in
// Chrome at the panel's shipped 288px, that made a block 166.69px tall
// (160.69px on the active row), so three accounts and the panel's chrome came
// to 665.85px against the 761px the panel gets on an 813px viewport: the fourth
// account starts a scrollbar.
//
// Almost none of that height is a different fact. Only ONE of an account's
// lanes decides anything — the highest one, because that is the window that
// runs out first and the one claude-swap measures its threshold against. The
// server already knows it: claude-accounts.mjs ships
// `headroom: 100 - Math.max(...lanes.map(l => l.pct))` with the comment "the
// number that decides whether this account is worth switching to", the panel
// types the field and nothing ever read it. Further down the same file the
// panel recomputed that same `Math.max` for the auto-switch readout, so the row
// was printing three numbers and leaving the reader to do a max() the component
// performs twice on its own.
//
// So the row shows the binding lane and puts the rest behind a disclosure. That
// is what lives here, as a pure function, for the reason account-move.ts gives
// for the same move: the suite is plain node with no DOM, so a rule that only
// exists inside JSX is a rule nothing can check.
//
// Two decisions in the split are worth naming.
//
// TIES KEEP SERVER ORDER. `>` rather than `>=` when scanning, so two lanes at
// the same percentage always resolve to the earlier one. The roster reloads
// every fifteen seconds and two windows sitting on the same number for a while
// is ordinary; a strict comparison means the row cannot flicker between two
// equal readings.
//
// THE EXPANDED LIST IS NOT RE-SORTED. `rest` comes back in the order the server
// sent it. A row whose single bar changes its label from `5h` to `7d` is
// telling you something — the binding window moved — and a list that re-sorts
// itself under the reader while they are looking at it is not.
//
// The lane count is not three and never was: the server builds `5h`, `7d` and
// one lane per scoped model, and either of the first two can be missing when
// claude-swap has no reading for it. Everything below is written for n, and 0
// and 1 are the cases with an answer of their own.

/** The only part of a lane this file needs. */
export interface LaneLike { pct: number }

export interface LaneSplit<T> {
  /** The lane the row shows at rest: the first one the server sent. */
  binding: T | null;
  /** The rest, in the order the server sent them. */
  rest: T[];
  /** The fullest lane, when it is NOT the one being shown. Null otherwise.
   *
   *  The row used to lead with this one, because it is the window that decides
   *  when auto-switch trips. It leads with the first lane instead now — `5h` on
   *  every account that has one — because that is the window people read the
   *  account by, and a row whose label changed from `5h` to `7d` when the
   *  pressure moved made the column unscannable. Nothing is lost: when a hidden
   *  lane is fuller than the shown one, the disclosure says so and says which. */
  fuller: T | null;
}

/**
 * The lane the row leads with, and everything behind it.
 *
 * One function rather than two, so the row and its disclosure cannot disagree
 * about which lane is showing: `rest` is defined as "the lanes after the first",
 * not as "the lanes after a sort". The server's order is the product's order —
 * `5h`, then `7d`, then a lane per scoped model — and nothing here reorders it,
 * so the label under an account is the same label tomorrow.
 */
export function laneSplit<T extends LaneLike>(lanes: readonly T[]): LaneSplit<T> {
  if (lanes.length === 0) return { binding: null, rest: [], fuller: null };
  const [binding, ...rest] = lanes;
  let at = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].pct > binding.pct && (at < 0 || rest[i].pct > rest[at].pct)) at = i;
  }
  return { binding, rest, fuller: at < 0 ? null : rest[at] };
}

/**
 * The word on the row's disclosure, or null when there is nothing behind it.
 *
 * Null at 0 and at 1: a row with one window is already showing all of it, and a
 * control that opens nothing is worse than no control. The count is on the
 * closed state because that is where it answers a question — how much is not
 * being shown — and off the open state, where the answer is on screen.
 *
 * When a hidden window is fuller than the one on show, it takes the label
 * instead of the count. The row leads with `5h` so the column stays readable,
 * which means the window that actually decides when auto-switch trips can be
 * the one folded away — and a row reading a calm 40% while 7d sits at 79% would
 * be the panel lying by omission. The count is the weaker of the two facts and
 * it survives in the hover sentence, so nothing is dropped. One line either
 * way: `.ap-meta` is a 9px footer that already wraps on an errored row, and two
 * facts side by side is what would push it over.
 */
export function moreLabel(
  rest: number,
  open: boolean,
  fuller?: { label: string; pct: number } | null,
): string | null {
  if (rest < 1) return null;
  if (open) return "fewer";
  if (fuller) return `${fuller.label} ${Math.round(fuller.pct)}%`;
  return `${rest} more`;
}

/**
 * The disclosure's hover sentence, which is where the server's own headroom
 * finally gets said.
 *
 * `headroom` is 100 less the binding lane's percentage, computed once by
 * claude-swap's reader and shipped with every account. Saying it here costs the
 * resting row no height and answers the question the bars are being read for:
 * not "how full is this window" but "how much is left before this account stops
 * being the one to use".
 */
export function lanesTitle(
  headroom: number | null,
  bindingLabel: string | null,
  rest: number,
  open: boolean,
): string {
  const lead = headroom == null
    ? "No usage has been collected for this account yet."
    : `${Math.round(headroom)}% left on the window that runs out first${
        bindingLabel ? `, and this row leads with ${bindingLabel}` : ""}.`;
  const other = rest === 1 ? "the other window" : `the other ${rest} windows`;
  return `${lead} ${open ? "Hide" : "Show"} ${other}.`;
}
