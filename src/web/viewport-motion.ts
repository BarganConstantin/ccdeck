// Should a viewport change animate — and what it costs to animate one that
// cannot.
//
// Every frame of a React Flow viewport animation is a requestAnimationFrame
// callback. `useReactFlow().setViewport` hands the pane's d3-zoom behaviour a
// TRANSITION rather than a selection —
//
//   setViewport: (transform, options) => {
//     …
//     d3Zoom.transform(getD3Transition(d3Selection, options?.duration), next);
//   }
//   const getD3Transition = (selection, duration = 0) =>
//     selection.transition().duration(duration);
//
// — and a d3 transition is scheduled by d3-timer, which for anything due in the
// next 24ms calls `requestAnimationFrame`. A browser does not run rAF in a page
// it is not rendering, so in a tab that is in the background NOTHING that goes
// through that door arrives: not the animation, and not its frames.
//
// Read `getD3Transition` again for the part that makes this worth a module.
// There is no `duration === 0` branch: a zero-duration setViewport is still a
// transition, still scheduled through d3-timer, still waiting on a frame that
// is not coming. So "ask for it without the animation" is NOT a way out — it is
// the same dead end spelled differently, which is exactly the shape the deck's
// own trailing correction had (#671). Landing a viewport in a background tab
// means not calling `setViewport` at all: `d3Zoom.transform(d3Selection, t)`
// with a selection instead of a transition applies the transform there and
// then, synchronously, no frame required. That is the door React Flow's own
// `fitView` takes when it is given no duration, and the one @reactflow/minimap
// pans through.
//
// The other half of a background tab is a slower clock, and the two are easy to
// confuse while diagnosing. Chrome clamps a hidden tab's timers to roughly 1Hz
// (#612/#613 measured it: the idle render rate read 1/s until the tab was made
// audible), so a `setTimeout` still runs, late. rAF does not run at all. A
// probe in a hidden deck tab reads 0 rAF callbacks against ~1 setTimeout
// callback per second — absent, not slowed, and that difference is why a
// timeout-based fallback around an rAF-driven animation cannot rescue it.
//
// Hence a rule with a name, asked of every viewport change the deck makes. The
// animation is a nicety — a canvas that teleports is disorienting, which is why
// a visible tab must keep animating exactly as it does today — but the position
// is the point, and a deck left at the identity transform is not a deck.

/** One viewport change the deck is about to ask for. */
export interface ViewportMotion {
  /** The animation the caller wants, in milliseconds. Zero, negative and
   *  non-finite all mean "do not animate this one". */
  durationMs: number;
  /** `document.hidden` — is this page one the browser is not rendering?
   *
   *  The honest signal, and the only one the platform offers: it covers a tab
   *  behind another tab, a window minimised, and a window fully covered by
   *  another (Chrome's occlusion tracking flips visibility for that too, which
   *  is the dashboard-behind-the-editor case this deck lives in). It can also
   *  change midway through an animation, so it is read at the moment of the
   *  change rather than remembered. */
  documentHidden: boolean;
  /** `prefers-reduced-motion: reduce` — has the reader asked the OS for less
   *  motion? Left out, it is read from the page at the moment of the change,
   *  the way count-up.ts asks: a reader can flip the setting while the deck is
   *  open, and every caller already passes the other two. */
  reducedMotion?: boolean;
}

/**
 * Should this viewport change be animated?
 *
 * False in a page that is not being rendered, because there the animation is
 * not slower or choppier — it does not happen, and neither does the move it was
 * carrying. False for a duration that asks for no animation in the first place.
 * False under reduced motion (#870): a pan and zoom across the whole canvas on
 * every j/k is the vestibular trigger that setting exists to stop, and the
 * camera was the one mover in the deck written in JS, where no media query in
 * styles.css could reach it. True otherwise, which is the ordinary case and
 * must stay ordinary: a visible tab animates exactly as before.
 *
 * A `false` answer is an instruction to the caller, not permission to skip the
 * move: it means "put the pane there now, by the synchronous route", never
 * "ask React Flow for it with duration 0" — see the note on `getD3Transition`
 * above for why those are not the same thing.
 */
export function shouldAnimateViewport(
  { durationMs, documentHidden, reducedMotion = prefersReducedMotion() }: ViewportMotion,
): boolean {
  if (documentHidden || reducedMotion) return false;
  return Number.isFinite(durationMs) && durationMs > 0;
}

/** Whether the reader asked for less motion. False where there is no page to
 *  ask — the suite, a worker — so a missing API never stops an animation. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The duration to hand React Flow's `fitView`, which — unlike `setViewport` —
 * does have a synchronous branch: `duration > 0` is a d3 transition, anything
 * else is `d3Zoom.transform(d3Selection, t)` applied there and then
 * (@reactflow/core `fitView`). So for this one call a 0 really is "go now", and
 * the fits that frame a chosen card ask the rule through here instead of
 * passing a bare number. Never use it for setViewport; that is applyViewport's.
 */
export function fitViewDuration(durationMs: number): number {
  const documentHidden = typeof document !== "undefined" && document.hidden;
  return shouldAnimateViewport({ durationMs, documentHidden }) ? durationMs : 0;
}
