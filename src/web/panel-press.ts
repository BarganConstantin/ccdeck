// #518: every primary action in the accounts panel dropped keyboard focus to
// `<body>`, because the handler disabled the button that had just been pressed.
//
// Measured over CDP with real Tab and Enter presses: `share`, the header `↻`
// and `switch` each set a busy flag, the flag reached `disabled` on the control
// the press came from, and Chrome drops focus when the focused element becomes
// disabled. A keyboard user who reached `share` on the third account — ten Tab
// presses — landed at the top of the document and had to walk the whole panel
// again, through every row's `⋯` and `switch` on the way.
//
// The guards themselves are right: these are in-flight locks and removing them
// would allow a double submit. What was wrong is WHICH control they reached.
//
// ── the rule ────────────────────────────────────────────────────────────────
//
// A press never disables the control it came from. While the panel has a
// request out, every control in it is inert EXCEPT the one that started it;
// that one stays enabled, says `aria-busy` so a reader is told it is working,
// and the request functions ignore a second press outright. Chrome only drops
// focus when the focused element becomes `disabled`, and now it never does.
//
// This is the issue's third option — "do not disable, mark busy instead" — with
// its one cost paid rather than avoided. That option as written leaves every
// sibling live and guarded, which is a control that looks pressable and does
// nothing; here the siblings keep the `disabled` they already had, at the
// `--dim-off` the sheet has always dimmed them with, and only the working
// control is exempted. So the panel gains no new busy language, `:disabled`
// still means what it meant, and the change is one expression: `busy != null`
// became `busy != null && busy !== mine`.
//
// The other two options were tried against the four sites and neither is one
// mechanism. "Focus a stable ancestor" and "focus what replaces it" both leave
// focus on `<body>` for the whole length of the request and only mop up
// afterwards — a user who presses Tab during those seconds still starts from
// the top of the document, which is the complaint. And both need per-site
// bookkeeping the moment the sites differ.
//
// ── the half no busy mechanism can answer ───────────────────────────────────
//
// Three of the four presses REMOVE their own control rather than disabling it,
// and that is true whatever the busy state is spelled as:
//
//   `switch`  the row becomes active and the button is replaced by the `active`
//             marker, which is a span and not focusable;
//   `remove`  the row and everything on it is gone;
//   the slot commit, because the manage block follows its account into the slot
//             it moved to and re-mounts there.
//
// So the rule has a second half, and it is a consequence rather than a second
// answer: a control the update takes away hands focus to the nearest thing that
// outlived it. `rescueSelectors` is that chain — the row's own `⋯`, which keeps
// the reader where they were on the rows that survive, and the panel's reload
// control when the row itself is gone. Both are real controls with names, so a
// screen reader says where focus went instead of going silent.
//
// Everything here is a pure function for the usual reason: the suite is plain
// node with no DOM, and a rule that only exists inside JSX is one nothing can
// check.

/** What one control reads off the panel's single in-flight tag. */
export interface PressState {
  /** Inert, because SOMEBODY ELSE is working. Never true of the control whose
   *  own request is out — that is the whole of #518. */
  disabled: boolean;
  /** This control is the one working, and says so. */
  busy: boolean;
}

/**
 * `inflight` is the tag of the request the panel currently has out, or null.
 * `tag` is this control's own.
 */
export function pressState(inflight: string | null, tag: string): PressState {
  return { disabled: inflight != null && inflight !== tag, busy: inflight === tag };
}

/**
 * Whether a press may start a request at all.
 *
 * The other half of the guard the `disabled` above used to be: with the working
 * control left enabled, a second Enter on it reaches the handler, so the
 * handler has to refuse. One request at a time, as before.
 */
export function pressAccepted(inflight: string | null): boolean {
  return inflight == null;
}

/**
 * Where focus goes when the press took its own control away, most local first.
 *
 * The row's `⋯` when the row survived — it is that row's own control, so the
 * reader stays where they were rather than at the top of the panel. The
 * panel's reload when it did not: it is the one control here that belongs to no
 * row and is always on screen.
 */
export function rescueSelectors(row: number | null): string[] {
  const chain = row == null ? [] : [`#ap-more-${row}`];
  return [...chain, ".accounts-panel .ap-refresh"];
}

/**
 * Whether focus actually fell off the end of the document.
 *
 * Takes the tag name so it stays a pure function. Focus is only rescued when it
 * was dropped: a user who tabbed somewhere else while the request was out is
 * left where they put themselves, which is the failure mode every "restore the
 * focus" fix has.
 */
export function focusDropped(activeTag: string | null): boolean {
  return activeTag == null || activeTag === "BODY" || activeTag === "HTML";
}
