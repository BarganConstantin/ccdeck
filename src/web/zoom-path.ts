// The path a camera animation takes from one view to another, kept finite.
//
// Every animated viewport change on this canvas is a d3-zoom transition, and
// d3-zoom draws it with d3-interpolate's `interpolateZoom`: van Wijk and Nuij's
// smooth zoom, the centre and the scale eased together along the curve that
// reads as the shortest. The curve is computed in closed form, and the form
// has a soft spot. When the centre moves a hair while the zoom changes a lot,
// it subtracts two nearly equal large numbers,
//
//   r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)   // b0 ≈ (w1² − w0²) / (4·w0·d)
//
// and gets 0 — log(0) is −Infinity, and every frame of the animation comes out
// NaN — or noise, which sends the frames somewhere the animation does not end
// and the last frame snaps. d3 special-cases a centre that does not move at
// all (d under 1e-6) and not one that moves 1e-5, and the band it gets wrong
// runs from there to about a tenth of a flow unit.
//
// Recenter after the zoom buttons is that move. Both zoom about the middle of
// the pane, so the fit comes back to the same centre give or take the float
// rounding of the rectangles it is measured from, at a very different zoom.
// The NaN frames went to React Flow's store, every listener on it, and the
// dotted background, which said so ~120 times a press.
//
// So the pane's interpolator is wrapped (use-camera.ts installs it): the smooth
// path is taken when it is one a camera can follow, finite and running from
// the view it leaves to the one it was asked for, and otherwise d3's own answer
// for an unmoving centre, the centre along the line and the zoom at a constant
// rate. Inside that band the two draw the same picture. A frame that still is
// not finite holds the last one that was.

/** d3-zoom's view: the centre of the pane in flow units, and the pane's longer
 *  side in flow units (its size divided by the zoom). */
export type ZoomView = [number, number, number];
export type ZoomPath = (t: number) => ZoomView;
export type ZoomPathFactory = (a: ZoomView, b: ZoomView) => ZoomPath;

/** How far a path's ends may sit from the views it joins, as a share of the
 *  view's width: a healthy smooth path is off by ~1e-12, a broken one by whole
 *  percents. Below a hundredth of a screen pixel on any pane. */
const ARRIVAL_TOLERANCE = 1e-6;

/** A view the pane can be put at: a finite centre and a positive, finite width. */
function isViewable(v: readonly number[]): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]) && v[2] > 0;
}

/** Whether `v` is `want`, within ARRIVAL_TOLERANCE of the wider of the two views. */
function isAt(v: ZoomView, want: ZoomView, span: number): boolean {
  return Math.abs(v[2] - want[2]) <= ARRIVAL_TOLERANCE * want[2]
    && Math.hypot(v[0] - want[0], v[1] - want[1]) <= ARRIVAL_TOLERANCE * span;
}

/**
 * The path d3 takes for a centre that does not move: the centre along the
 * straight line, the width at a constant ratio per unit of time, so the zoom
 * reads as steady.
 */
export function straightZoomPath(a: ZoomView, b: ZoomView): ZoomPath {
  const ratio = b[2] / a[2];
  return t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] * ratio ** t];
}

/** Whether a camera can follow `path` from `a` to `b`: viewable at both ends
 *  and in the middle, and starting and arriving where it should. */
function canFollow(path: ZoomPath, a: ZoomView, b: ZoomView): boolean {
  const start = path(0), middle = path(0.5), end = path(1);
  if (!isViewable(start) || !isViewable(middle) || !isViewable(end)) return false;
  const span = Math.max(a[2], b[2]);
  return isAt(start, a, span) && isAt(end, b, span);
}

/**
 * `smooth`, d3-zoom's own interpolator factory, made safe to hand the pane:
 * its path when that path holds, the straight one when it does not, and no
 * frame that is not a view.
 */
export function guardZoomPath(smooth: ZoomPathFactory): ZoomPathFactory {
  return (a, b) => {
    const curved = smooth(a, b);
    const path = canFollow(curved, a, b) ? curved : straightZoomPath(a, b);
    let last: ZoomView = isViewable(a) ? a : b;
    return t => {
      const v = path(t);
      if (isViewable(v)) last = v;
      return last;
    };
  };
}

/** Whether a viewport the deck is about to ask for is one: finite, and a zoom
 *  above zero. Anything else would put NaN in the pane's transform. */
export function isViewableViewport(v: { x: number; y: number; zoom: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0;
}
