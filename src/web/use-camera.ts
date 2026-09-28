// The camera's primitives: the one door every viewport the deck sets goes
// through, the fit every structural change runs, and the bookkeeping that lets
// a move tell it has been superseded or cut short.
//
// Lifted out of App.tsx's `Inner` unchanged. They were four hundred lines
// apart there — the door near the top, the fit below the clock tick, and the
// handler that lands a fit a hidden tab interrupted after it — and between
// them they are one mechanism: `applyViewport` puts the pane somewhere,
// `fitLeft` works out where the board wants it and checks it arrived, and the
// three refs are what each move leaves behind for the next one to read. The
// camera's other users (a focus, the reframe, the reader's own gestures) stay
// in App.tsx and reach the refs from there.
import { useCallback, useEffect, useRef } from "react";
import { useReactFlow, useStoreApi, type ReactFlowState } from "reactflow";

import { fitZoomForDrawnLanes } from "./semantic-zoom";
import { FIT_FILL, FIT_MARGIN, railCover } from "./use-layout-frame";
import { shouldAnimateViewport } from "./viewport-motion";

/** d3-zoom's own transform for the pane — the scale `k`, the translation
 *  `x`/`y`, and the relative builders that compose another one from it.
 *
 *  Read off React Flow's own d3-zoom handle rather than imported from d3-zoom,
 *  because d3-zoom reaches this app only as React Flow's dependency and a
 *  direct import would be a package.json entry for one type. applyViewport is
 *  the only user. */
type PaneTransform = Extract<
  Parameters<NonNullable<ReactFlowState["d3Zoom"]>["transform"]>[1],
  { k: number }
>;

// Matches TOOL_LANE_W in layout.ts — the burst lane drawn beside each card.
export const TOOL_LANE_ALLOWANCE = 420;

export function useCamera() {
  const rf = useReactFlow();
  // The same store React Flow's own viewport helpers read, and the only way to
  // reach the pane's d3-zoom behaviour from here. `useStoreApi` rather than
  // `useStore`: this is never rendered from, only called into, so a subscription
  // would be a re-render per pan frame for nothing. See applyViewport.
  const storeApi = useStoreApi();

  /**
   * Put the pane where the deck wants it — and make sure it gets there.
   *
   * One door for every viewport the deck asks for, because there are two ways
   * through and the choice is not the caller's to make each time. The animated
   * way is `setViewport`, which is a d3 transition and therefore a chain of
   * requestAnimationFrame callbacks; the immediate way is the pane's d3-zoom
   * behaviour handed a SELECTION instead of a transition, which applies the
   * transform synchronously and needs no frame at all.
   *
   * Which one is not a matter of taste. A browser runs no rAF in a page it is
   * not rendering, so in a background tab the animated way does not arrive late
   * — it does not arrive, and neither does the position it was carrying. That
   * is the whole of #671: a deck left open behind an editor could not recentre,
   * and the drift watchdog's recovery — whose entire purpose is a canvas that
   * wandered off while nobody was looking — could not execute in exactly the
   * condition it exists for. Measured in a hidden deck tab: zero rAF callbacks
   * over three seconds, while `setTimeout` kept firing at Chrome's ~1Hz
   * background clamp. The timers were slow; the frames were absent.
   *
   * `{ duration: 0 }` is NOT the immediate way, which is the trap this function
   * exists to close. React Flow's setViewport has no zero-duration branch —
   * `getD3Transition` wraps the selection in `.transition().duration(d)` for
   * every d — so a "non-animated" setViewport is a transition of length zero,
   * waiting on the same frame that is not coming. The deck's own trailing
   * correction used to be spelled that way and could never once have worked.
   * `d3Zoom.transform(d3Selection, t)` is the door React Flow's own `fitView`
   * takes when given no duration, and the one @reactflow/minimap pans through.
   *
   * The transform is composed from the live one rather than built from
   * `zoomIdentity`, so that no d3 module has to be imported beside React Flow's
   * own copy: `scale` and `translate` on a ZoomTransform are relative, and
   * scaling to `zoom / k` and then translating by the remaining gap lands on
   * exactly (x, y, zoom).
   */
  const applyViewport = useCallback((next: { x: number; y: number; zoom: number }, duration: number) => {
    if (shouldAnimateViewport({ durationMs: duration, documentHidden: document.hidden })) {
      rf.setViewport(next, { duration });
      return;
    }
    const { d3Zoom, d3Selection } = storeApi.getState();
    const current = d3Selection?.property("__zoom") as PaneTransform | undefined;
    if (d3Zoom && d3Selection && current && current.k > 0 && next.zoom > 0) {
      d3Zoom.transform(d3Selection, current
        .scale(next.zoom / current.k)
        .translate((next.x - current.x) / next.zoom, (next.y - current.y) / next.zoom));
      return;
    }
    // Nothing mounted to drive yet. Ask React Flow anyway: in a visible tab it
    // still lands, and in a hidden one there was no pane to move regardless.
    rf.setViewport(next, { duration: 0 });
  }, [rf, storeApi]);

  /** The frame an animation is on its way to, and the moment it should have
   *  arrived by. Null whenever no animated fit is in flight.
   *
   *  Kept because `document.hidden` can flip DURING an animation, and a
   *  transition that loses its frames stops where it stands: a canvas frozen
   *  part-way to a fit, with `getViewport` reporting a transform the deck never
   *  asked for and the drift watchdog measuring against it. */
  const pendingFitRef = useRef<{ target: { x: number; y: number; zoom: number }; until: number } | null>(null);
  /** WHICH CAMERA MOVE IS THE LATEST ONE ANYBODY ASKED FOR. Bumped by every
   *  frame the deck sets on purpose — a fit, a focus — and by the reader's own
   *  pan or zoom, so that a move can tell it has been superseded.
   *
   *  fitLeft's trailing correction is what needs it. That check exists to land a
   *  fit whose animation was cut short, and it could not tell "cut short" from
   *  "replaced": a fit started by the frame change a selection causes (the
   *  detail panel opens and the canvas narrows), then a double-click focusing a
   *  session 100ms later — and 560ms after the fit began, its correction found
   *  the camera somewhere it had not put it and snapped the whole board back,
   *  over the focus. A pan made during a fit's animation was undone the same
   *  way. The correction now lands only while its fit is still the latest. */
  const cameraEpochRef = useRef(0);
  const lastFitTimeRef = useRef(0);

  /** A MOVE THE DECK MAKES ON PURPOSE, to `want` over `duration`. Every one of
   *  them does the same four things in the same order, and they used to be
   *  spelled out at each: take the next epoch so an older move can tell it has
   *  been superseded, go through the door, stamp the time so the move is never
   *  read as the reader's own gesture (viewport-intent.ts), and remember the
   *  target while an animation is carrying it there, for the visibility
   *  handler below to land if the tab goes away mid-flight. Returns the epoch,
   *  for a caller that checks later whether its move is still the latest. */
  const moveCamera = useCallback((want: { x: number; y: number; zoom: number }, duration: number): number => {
    const epoch = ++cameraEpochRef.current;
    applyViewport(want, duration);
    lastFitTimeRef.current = Date.now();
    // Remembered only while an animation is actually running: a move that went
    // straight to the pane is already there, and nothing about it is pending.
    pendingFitRef.current = shouldAnimateViewport({ durationMs: duration, documentHidden: document.hidden })
      ? { target: want, until: Date.now() + duration + 60 }
      : null;
    return epoch;
  }, [applyViewport]);

  /**
   * Frame the graph against the left edge of the canvas.
   *
   * React Flow's fitView centres, and there is no asymmetric-padding option,
   * so this measures what is actually drawn and sets the viewport outright.
   * Left-anchored because a graph parked mid-canvas leaves dead space on the
   * side the eye starts from.
   */
  const fitLeft = useCallback((duration = 500) => {
    // MAX_ZOOM 1: cards are drawn at their natural size, so magnifying past
    // 1:1 only makes a small graph look coarse. FILL leaves the frame a little
    // loose — a fit that touches the margins reads as "already too big" and
    // gives the eye nowhere to land when the next session appears.
    const MARGIN = FIT_MARGIN, MAX_ZOOM = 1, MIN_ZOOM = 0.2, FILL = FIT_FILL;
    try {
      const pane = document.querySelector(".canvas-wrap");
      const drawn = Array.from(document.querySelectorAll(".react-flow__node"))
        .filter(el => (el as HTMLElement).offsetWidth > 0);
      if (!pane || drawn.length === 0) return;

      const paneRect = pane.getBoundingClientRect();
      const vp = rf.getViewport();
      if (!Number.isFinite(vp.zoom) || vp.zoom <= 0) return;

      // Screen rects back through the current viewport into flow space, so
      // this works from any starting zoom and never consults the node store —
      // which also holds the invisible per-session drag handles.
      const fx = (sx: number) => (sx - paneRect.left - vp.x) / vp.zoom;
      const fy = (sy: number) => (sy - paneRect.top - vp.y) / vp.zoom;
      const rects = drawn.map(el => el.getBoundingClientRect());
      const minX = Math.min(...rects.map(r => fx(r.left)));
      const maxX = Math.max(...rects.map(r => fx(r.right)));
      const minY = Math.min(...rects.map(r => fy(r.top)));
      const maxY = Math.max(...rects.map(r => fy(r.bottom)));
      const w = maxX - minX, h = maxY - minY;
      if (!(w > 0 && h > 0)) return;

      // Tool bursts are an overlay rather than nodes, so they are absent from
      // these rects — leave room or the last column's chips get clipped. The
      // rail's strip is not room either: a board framed into it would put its
      // last column under the machine and usage panels.
      //
      // Only where they are drawn, though (fitZoomForDrawnLanes): below the
      // full card the bubbles are hidden, and room kept for them there is the
      // band of empty canvas a board used to sit in the middle of.
      const railWidth = railCover(pane);
      const fitWith = (lane: number) => Math.max(MIN_ZOOM, Math.min(
        MAX_ZOOM,
        ((paneRect.width - railWidth - MARGIN * 2) / (w + lane)) * FILL,
        ((paneRect.height - MARGIN * 2) / h) * FILL,
      ));
      const zoom = fitZoomForDrawnLanes(fitWith(TOOL_LANE_ALLOWANCE), fitWith(0));

      // One frame, computed once. It used to be spelled out twice — here and
      // again inside the correction below — which is two chances to disagree
      // about where the graph was supposed to go.
      const want = {
        x: MARGIN - minX * zoom,
        y: Math.max(MARGIN, (paneRect.height - h * zoom) / 2) - minY * zoom,
        zoom,
      };
      const epoch = moveCamera(want, duration);
      // A transition can also be cut short — the pane loses its frames when the
      // tab is hidden mid-animation, and the user can grab it. Check afterwards
      // and, if the frame never arrived, put it there outright. Not fitView:
      // that centres, which is the one thing this function exists to avoid.
      window.setTimeout(() => {
        try {
          // Only if it is still THIS fit's target: a second fit started in the
          // meantime owns the ref now, and clearing it would leave that
          // animation with nothing to land if the tab went away mid-flight.
          if (pendingFitRef.current?.target === want) pendingFitRef.current = null;
          if (cameraEpochRef.current !== epoch) return;
          const vpNow = rf.getViewport();
          if (Math.abs(vpNow.zoom - zoom) > 0.01 || Math.abs(vpNow.x - want.x) > 2) {
            applyViewport(want, 0);
          }
        } catch { /* ignore */ }
      }, duration + 60);
    } catch { /* viewport not ready */ }
  }, [rf, applyViewport, moveCamera]);

  // A fit that is animating when the tab goes away loses its frames where it
  // stands — a canvas stopped part-way to a frame nobody chose, which is worse
  // than either end of the animation and is what `getViewport` would report to
  // the drift watchdog from then on. So the moment the page stops being
  // rendered, whatever is in flight is put where it was going.
  //
  // The trailing correction above cannot cover this one: it is a `setTimeout`,
  // and a hidden tab's timers are clamped to about 1Hz, so a 400ms fit would
  // sit frozen for the best part of a second first. The visibility change
  // itself is delivered immediately.
  useEffect(() => {
    const land = () => {
      if (!document.hidden) return;
      const pending = pendingFitRef.current;
      pendingFitRef.current = null;
      if (!pending || Date.now() > pending.until) return;
      try { applyViewport(pending.target, 0); } catch { /* pane gone */ }
      // Restamped, because this move arrives as an eventless onMove of its own
      // and the stamp from the fit that started it may already be outside the
      // window viewport-intent.ts measures.
      lastFitTimeRef.current = Date.now();
    };
    document.addEventListener("visibilitychange", land);
    return () => document.removeEventListener("visibilitychange", land);
  }, [applyViewport]);

  return { applyViewport, moveCamera, fitLeft, cameraEpochRef, lastFitTimeRef };
}
