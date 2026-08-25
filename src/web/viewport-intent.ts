// Who moved the camera — the deck, or the person looking at it.
//
// The deck re-frames the graph on its own: every structural change fires
// fitLeft, the drift watchdog fits when nothing measurable is on screen, and
// the session list fits to whatever it focuses. That is the feature. The other
// half of the feature is that it stops the moment the user takes the wheel, and
// stays stopped until they press recenter. So the whole behaviour rests on one
// question asked of every viewport change: was this one theirs?
//
// It used to be answered by React Flow's `onMoveStart` alone, and that callback
// cannot answer it. In @reactflow/core 11.11.4 the pane's d3-zoom `start`
// handler opens with `if (!event.sourceEvent || event.sourceEvent.internal)
// return null;` — a viewport change with no originating DOM event never reaches
// onMoveStart at all. Two controls this deck mounts move the viewport exactly
// that way, because they go through the store instead of through the pane:
// @reactflow/minimap pans with `d3Zoom.transform(d3Selection, t)` and
// wheel-zooms with `d3Zoom.scaleTo(d3Selection, z)`, and @reactflow/controls'
// + and − call `zoomIn`/`zoomOut`, which are `d3Zoom.scaleBy(transition, 1.2)`.
// Two arguments, no event forwarded, so onMoveStart never fired for any of
// them, auto-fit was never switched off, and the next re-measure animated the
// user's zoom away. The same zoom made with the wheel over the canvas stuck.
//
// `onMove` is the signal that cannot lose one: the `zoom` handler beside it
// guards only on `!event.sourceEvent?.internal`, which is falsy when there is
// no source event, so it fires for the pane, for the minimap, for the zoom
// buttons — and for anything the library adds next. What it also fires for is
// the deck's own fits, which is why the answer cannot be "onMove happened".
//
// Hence the three inputs below. A move React Flow attributes to a DOM event on
// the pane is the user's by construction — the library has no way to invent
// one. A move with no source event is the user's when a press or a wheel landed
// inside the canvas a moment ago, which is what every store-driven control has
// in common and what no programmatic fit has: the opening fitView, the restored
// viewport, the layout re-fit and the drift watchdog all arrive with nothing
// having been touched. And a fit the deck itself asked for is never the user's,
// whichever of those two is true — that is the case the recenter button lives
// in, a press inside the canvas whose whole purpose is to hand the viewport
// back to auto-fit.

/** How long a viewport change the deck asked for keeps arriving.
 *
 *  An animated setViewport runs as a d3 transition, so it reports a new
 *  viewport on every frame for the length of the animation; the longest the
 *  deck asks for is 600ms, and its trailing correction lands at duration + 60.
 *  1200 covers both with room, and is the window this rule was already using
 *  inline before it had a name. */
export const DECK_FIT_WINDOW_MS = 1200;

/** How long after a press or a wheel inside the canvas a store-driven viewport
 *  change still counts as that gesture's doing.
 *
 *  Wide enough for a button whose click only fires on release, narrow enough
 *  that a fit arriving later is not blamed on a press that has been over for a
 *  second. Deliberately not stamped by pointer MOVEMENT: a cursor resting over
 *  the canvas while the deck boots would otherwise make the opening fit look
 *  like the user's, which is the one misreading that switches auto-fit off
 *  permanently on first paint. */
export const CANVAS_INPUT_WINDOW_MS = 1000;

/** One viewport change, described in the terms the decision needs. */
export interface ViewportMove {
  /** Did React Flow hand this move a DOM event?
   *
   *  Typed `MouseEvent | TouchEvent` by the library and genuinely `undefined`
   *  at runtime for everything that moves the viewport through the store — the
   *  gap this whole module exists to cover. */
  hasSourceEvent: boolean;
  /** When the move arrived. */
  at: number;
  /** When the deck last asked for a viewport of its own. 0 for never. */
  lastDeckFitAt: number;
  /** When a press or a wheel last landed anywhere inside the canvas element —
   *  the pane, the minimap and the Controls stack alike. 0 for never. */
  lastCanvasInputAt: number;
}

/**
 * Does this viewport change mean the user took the wheel?
 *
 * The one place that question is answered, so that no control can be wired to
 * a different answer than the canvas is.
 */
export function isUserViewportGesture(move: ViewportMove): boolean {
  // A fit the deck asked for is never the user's, even when a press of theirs
  // is what asked for it. Recenter, re-arrange and fit-view are all presses
  // inside the canvas that end in a deck fit, and reading their own animation
  // back as a gesture would turn auto-fit off in the act of turning it on.
  if (move.lastDeckFitAt > 0 && move.at - move.lastDeckFitAt < DECK_FIT_WINDOW_MS) return false;
  // A source event means a real gesture landed on the pane. Nothing else can
  // produce one, so nothing else has to be ruled out.
  if (move.hasSourceEvent) return true;
  // Otherwise it came through the store: the minimap, the zoom buttons, or
  // whatever the library grows next. It is the user's if they were just
  // touching the canvas, and the deck's if the canvas has been still.
  return move.lastCanvasInputAt > 0 && move.at - move.lastCanvasInputAt < CANVAS_INPUT_WINDOW_MS;
}
