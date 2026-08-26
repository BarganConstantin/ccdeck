// Has the graph drifted off the canvas, and should the deck go and fetch it?
//
// The deck runs a 1.5-second watchdog for one failure it cannot otherwise
// recover from: a layout pass — a new session arriving, dagre reflowing around
// it — that leaves every card outside the visible pane. Nothing is on screen,
// nothing will put itself back, and the only way out is a button the user has
// to know exists. So the watchdog re-frames the graph when it can see that
// every measured card is gone.
//
// That decision is an intersection test, and an intersection test is only as
// good as the two rectangles it is given. One of them comes from React Flow:
// `getViewport()` is the transform applied to the pane, so projecting a node's
// flow-space box through it — `x * zoom + vp.x` — yields coordinates measured
// from the top-left corner of `.canvas-wrap`, not from the top-left corner of
// the window. The other rectangle therefore has to be the pane's own size.
//
// It was `window.innerWidth - 360` and `window.innerHeight - 52` (#615): the
// window, less a detail panel assumed always open, less the topbar. `.app` is a
// grid whose columns depend on which panels are up —
//
//   detail only                    1fr 360px          pane = window - 360
//   sessions + detail       240px 1fr 360px           pane = window - 600
//   accounts + detail       288px 1fr 360px           pane = window - 648
//   neither                             1fr           pane = window
//   sessions only                 240px 1fr           pane = window - 240
//   accounts only                 288px 1fr           pane = window - 288
//
// — so the guess described one of six layouts, and not the one the deck opens
// in: the accounts panel is open on a first run and the detail panel is not,
// which is `288px 1fr`, a pane 72px wider than the check believed. The rows are
// `52px auto 1fr` with the canvas in row 3, and row 2 carries the connection
// and version banners, so the height guess was wrong by a banner too.
//
// Both errors have a failure mode, in opposite directions. A rectangle too WIDE
// (either left panel open beside the detail panel) credits the pane with
// 240-288px it does not have, so a graph parked just past the real right edge
// still counts as visible and the failsafe never fires — the one case it exists
// for is the one it sleeps through. A rectangle too NARROW (every layout with
// the detail panel closed, the default among them) writes off the last 72-360px
// of the pane, so cards plainly on screen read as drifted and the next tick
// yanks the viewport into a fit nobody asked for.
//
// Hence this module. The rule is pure and the pane is a parameter, so the six
// layouts are six numbers a test can pass in — which is the only way any of
// this is reachable in a suite with no DOM. The caller's job is to hand over
// the pane it actually has, and the deck already measures that: the
// ResizeObserver on `.canvas-wrap` is the same rectangle, taken from the same
// element, and it is what feeds this now.

/** The visible drawing area — `.canvas-wrap`, in CSS pixels. */
export interface PaneSize {
  width: number;
  height: number;
}

/** React Flow's pane transform, as `getViewport()` returns it. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** One node's box in flow space: where the layout put it, and how big it
 *  measured. */
export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Is any part of this node's box inside the pane?
 *
 * The projection is the whole point of the coordinate space: a box in flow
 * space becomes pane-relative pixels under the viewport transform, so it is
 * compared against `0 … pane.width` and `0 … pane.height` — the pane's own
 * corners — and never against a window coordinate.
 *
 * Touching edges do not count as visible: a card whose right edge lands exactly
 * on x=0 occupies no pixel of the pane.
 */
export function isBoxOnPane(box: NodeBox, vp: Viewport, pane: PaneSize): boolean {
  const left = box.x * vp.zoom + vp.x;
  const top = box.y * vp.zoom + vp.y;
  const right = (box.x + box.width) * vp.zoom + vp.x;
  const bottom = (box.y + box.height) * vp.zoom + vp.y;
  return right > 0 && left < pane.width && bottom > 0 && top < pane.height;
}

/** Everything the watchdog knows at the moment it has to decide. */
export interface DriftCheck {
  /** The measured pane. `null` before anything has measured it, and zero on
   *  either axis if the measurement came back empty — both mean the same
   *  thing, which is that there is no rectangle to test against. */
  pane: PaneSize | null;
  /** The current pane transform. */
  viewport: Viewport;
  /** Boxes for the live agents that have both a position and a measurement.
   *  Agents missing either are the caller's to leave out — an unmeasured card
   *  is not evidence of anything. */
  boxes: readonly NodeBox[];
}

/**
 * Should the deck re-frame the graph?
 *
 * True only for the genuine drift case: at least one live agent is measured,
 * and not one of them puts a pixel on the pane.
 *
 * False whenever the question cannot be answered honestly — no boxes to judge,
 * a pane of unknown size, a viewport that is not a usable transform. An
 * unmeasured pane is the case worth naming: it would read as "nothing
 * intersects a zero-sized rectangle", which is indistinguishable from total
 * drift and would have the watchdog fit every 1.5 seconds forever. Before the
 * first ResizeObserver callback, and on a browser with no ResizeObserver at
 * all, the honest answer is that the deck does not know where the canvas is —
 * so it leaves the viewport alone rather than guessing at it, which is how this
 * went wrong in the first place.
 */
export function shouldRefit({ pane, viewport, boxes }: DriftCheck): boolean {
  if (!pane) return false;
  if (!(pane.width > 0) || !(pane.height > 0)) return false;
  if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return false;
  if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y)) return false;
  let measured = false;
  for (const box of boxes) {
    measured = true;
    if (isBoxOnPane(box, viewport, pane)) return false;
  }
  return measured;
}
