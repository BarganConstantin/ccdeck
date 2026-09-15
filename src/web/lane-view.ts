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

/** The only parts of a lane this file needs. `id` is the server's, and the
 *  `scoped-` prefix is its own contract — claude-accounts.mjs builds
 *  `five_hour`, `seven_day` and one `scoped-N` per model. */
export interface LaneLike { pct: number; id?: string }

/** A per-model breakdown rather than one of the account's own windows. */
function isScoped(l: LaneLike): boolean {
  return typeof l.id === "string" && l.id.startsWith("scoped-");
}

export interface LaneSplit<T> {
  /** The account's own quota windows, in the order the server sent them:
   *  `5h`, then `7d`. Both stay on the resting row — they are the two numbers
   *  an account is read by, and folding either one away made the reader open a
   *  disclosure to answer the question the panel exists for. */
  shown: T[];
  /** The per-model lanes, folded. These are a breakdown of the windows above
   *  rather than a third and fourth window, and an account can have any number
   *  of them, so they are what the disclosure is for. */
  rest: T[];
  /** The fullest folded lane, when it is fuller than every lane on show.
   *  Null otherwise.
   *
   *  The row leads with the windows rather than with whatever is fullest, so
   *  the lane that decides when auto-switch trips can be one of the folded
   *  ones. When it is, the disclosure says which and how full, because a row
   *  showing two calm numbers over a hidden hot one would be the panel lying by
   *  omission. */
  fuller: T | null;
  /** The fullest lane of all, shown or folded — the one `headroom` is about. */
  peak: T | null;
}

/**
 * What the row shows at rest, and what its disclosure holds.
 *
 * The cut is by kind, not by count or by size: the account's own windows stay,
 * the per-model breakdown folds. That is what makes the resting row the same
 * shape on every account and the same shape tomorrow — a cut by size re-labels
 * itself whenever the pressure moves, and a cut by count shows a model lane on
 * an account the server had no `7d` reading for.
 *
 * One function rather than two, so the row and its disclosure cannot disagree
 * about what is showing: `rest` is defined as the complement of `shown`, not as
 * a second filter that could drift from it.
 */
export function laneSplit<T extends LaneLike>(lanes: readonly T[]): LaneSplit<T> {
  const shown = lanes.filter(l => !isScoped(l));
  const rest  = lanes.filter(l => isScoped(l));
  // An account whose windows the server had no reading for still has to show
  // something, so a roster of nothing but model lanes leads with them rather
  // than rendering an empty row over a full disclosure.
  const head = shown.length ? shown : rest;
  const tail = shown.length ? rest : [];
  const top  = head.reduce<T | null>((a, b) => (a && a.pct >= b.pct ? a : b), null);
  let fuller: T | null = null;
  for (const l of tail) {
    if (top && l.pct <= top.pct) continue;
    if (!fuller || l.pct > fuller.pct) fuller = l;
  }
  return { shown: head, rest: tail, fuller, peak: fuller ?? top };
}

// NO COUNT OF WHAT IS FOLDED. The row's disclosure used to be a word in its
// footer — `1 more`, `fewer`, or the hot lane's label — and "1 more" named no
// thing a reader could picture. The shut row now shows its windows plus `fuller`
// when there is one, and the whole row is what opens; there is no label left to
// compute.
