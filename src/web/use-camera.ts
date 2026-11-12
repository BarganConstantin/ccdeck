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
import { useReactFlow, useStoreApi, type Node, type ReactFlowState } from "reactflow";

import { boardRect } from "./board-rect";
import { AUTO_FIT_MIN_ZOOM, FIT_MIN_ZOOM, fitBoard } from "./fit-board";
import { cardBodyPx } from "./semantic-zoom";
import { sessionGroupNodes } from "./session-group-nodes";
import { TEXT_SIZE_INCREASE, currentTextSize } from "./reading-preferences";
import { railCover } from "./use-layout-frame";
import { stageEase as easeOut } from "./motion-ease";
import { CAMERA_FAST_MS, CAMERA_SLOW_MS, shouldAnimateViewport } from "./viewport-motion";
import { guardZoomPath, isViewableViewport } from "./zoom-path";

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

/** The pane zoom behaviours whose interpolator is already guarded. */
const guardedZooms = new WeakSet<object>();

/** A d3 transition on the pane, `duration` long, on V4's stage curve
 *  (--ease-stage, navigator-flip.ts). `selection.transition()` is d3-transition's
 *  and reaches the selection through React Flow, which imports it for its own
 *  setViewport; the types do not carry it, so its three calls are named here. */
type PaneSelection = NonNullable<ReactFlowState["d3Selection"]>;
type PaneTransition = Parameters<NonNullable<ReactFlowState["d3Zoom"]>["transform"]>[0];
function stageTransition(selection: PaneSelection, duration: number): PaneTransition {
  const t = (selection as unknown as {
    transition(): { duration(ms: number): { ease(fn: (t: number) => number): unknown } };
  }).transition();
  return t.duration(duration).ease(easeOut) as PaneTransition;
}

/** Stops whatever transition the pane is running, where the camera stands. */
function interruptPane(selection: PaneSelection | null | undefined): void {
  (selection as unknown as { interrupt?: () => unknown } | null | undefined)?.interrupt?.();
}

// Matches TOOL_LANE_W in layout-geometry.ts — the burst lane drawn beside each card.
export const TOOL_LANE_ALLOWANCE = 420;

/** Who asked for a fit: the auto-fit, which keeps the faces' task line, or the
 *  reader's Fit all and F, which show the whole board however small. */
export type FitReach = "auto" | "all";

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
   *
   * A target with a NaN or an infinity in it is refused, and the pane keeps the
   * frame it has: d3-zoom would apply it as given, and the transform it leaves
   * is one every reader of the store then draws from.
   */
  const applyViewport = useCallback((next: { x: number; y: number; zoom: number }, duration: number) => {
    if (!isViewableViewport(next)) return;
    const { d3Zoom, d3Selection } = storeApi.getState();
    const current = d3Selection?.property("__zoom") as PaneTransform | undefined;
    if (shouldAnimateViewport({ durationMs: duration, documentHidden: document.hidden })) {
      // On V4's stage curve, not d3's own cubic in-out: React Flow's
      // setViewport takes a duration and no easing, so the transition is made
      // here and handed to the same d3Zoom.transform it would have used. Same
      // d3 transition, so a wheel, a pinch or a drag interrupts it at once and
      // a second request starts from wherever the camera is.
      if (d3Zoom && d3Selection && current && current.k > 0 && next.zoom > 0) {
        d3Zoom.transform(stageTransition(d3Selection, duration), current
          .scale(next.zoom / current.k)
          .translate((next.x - current.x) / next.zoom, (next.y - current.y) / next.zoom));
        return;
      }
      rf.setViewport(next, { duration });
      return;
    }
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

  // Every transition the pane runs, the deck's and React Flow's own, draws its
  // frames through d3-zoom's interpolator, and the stock one comes out NaN on a
  // zoom about a centre that barely moves, which is what Recenter after the
  // zoom buttons asks for (zoom-path.ts). So the pane's is wrapped, once per
  // behaviour: now if React Flow has made it, and when it does otherwise.
  useEffect(() => {
    const guard = (zoom: ReactFlowState["d3Zoom"]) => {
      if (!zoom || guardedZooms.has(zoom)) return;
      guardedZooms.add(zoom);
      zoom.interpolate(guardZoomPath(zoom.interpolate()));
    };
    guard(storeApi.getState().d3Zoom);
    return storeApi.subscribe(state => guard(state.d3Zoom));
  }, [storeApi]);

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
  /** How to run the fit that is animating again, from where the camera is
   *  now: set by fitLeft, cleared by every other move. A window resize in the
   *  middle of a fit asks it, so the animation ends on the new frame and not
   *  on the one the old window measured. */
  const refitRef = useRef<(() => void) | null>(null);
  /** The zoom a run of zoom steps is on its way to, so a second press adds to
   *  the first instead of to the frame it has reached so far. */
  const zoomGoalRef = useRef<{ zoom: number; until: number } | null>(null);
  /** The board's own places, as the layout put them (use-board-graph.ts
   *  `nodes`), set by App each render. Below the full card React Flow is
   *  handed the board packed (packed-board.ts), and a fit read off it would
   *  depend on the zoom it was asked from. Null until the board is built; the
   *  fit then reads React Flow's nodes. */
  const boardRef = useRef<Node[] | null>(null);
  /** The reader's Fit all holds: set by Fit all, F and recenter, and the fits
   *  that follow on their own (a panel, a resize, a new session) keep showing
   *  the whole board until the reader pans or zooms by hand (releaseFitAll). */
  const fitAllHeldRef = useRef(false);

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
    refitRef.current = null;
    zoomGoalRef.current = null;
    // Immediate moves emit onMove synchronously. Stamp first, so a press of
    // Recenter is recognised as a deck fit instead of disabling auto-fit again.
    lastFitTimeRef.current = Date.now();
    applyViewport(want, duration);
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
   *
   * `reach` is who asked. The auto-fit (`auto`) never frames the board below
   * the zoom its faces still say each card's task at, and leaves the rest of
   * a board too big for that to a pan; Fit all and F (`all`) show the whole
   * board however small (fit-board.ts), and so does every fit after them
   * until the reader pans or zooms by hand.
   */
  const fitLeftRef = useRef<(duration?: number, reach?: FitReach) => void>(() => {});
  const fitLeft = useCallback((duration = CAMERA_SLOW_MS, reach: FitReach = fitAllHeldRef.current ? "all" : "auto") => {
    try {
      const pane = document.querySelector(".canvas-wrap");
      const drawn = Array.from(document.querySelectorAll(".react-flow__node"))
        .filter(el => (el as HTMLElement).offsetWidth > 0);
      if (!pane || drawn.length === 0) return;

      const paneRect = boardRect(pane);
      const vp = rf.getViewport();
      if (!Number.isFinite(vp.zoom) || vp.zoom <= 0) return;

      // Fit where the nodes are GOING, not a frame of their CSS transition.
      // R fits after 80ms, while node transforms ease for 320ms; measuring
      // screen rectangles then frames the old/intermediate arrangement and
      // leaves the final nodes under a side panel. Keep the DOM visibility
      // filter, but pair its unscaled dimensions with the targets: the
      // board's own places (boardRef), not the packed ones the faces draw,
      // so the fit is the same from any zoom.
      const board = boardRef.current;
      const targets = new Map<string, Node>((board ? [...sessionGroupNodes(board), ...board] : rf.getNodes()).map(n => [n.id, n]));
      const rects = drawn.flatMap(el => {
        const node = targets.get((el as HTMLElement).dataset.id ?? "");
        if (!node) return [];
        const pos = node.positionAbsolute ?? node.position;
        const width = node.width ?? (el as HTMLElement).offsetWidth;
        const height = node.height ?? (el as HTMLElement).offsetHeight;
        if (!(width > 0 && height > 0)) return [];
        return [{ left: pos.x, right: pos.x + width, top: pos.y, bottom: pos.y + height, type: node.type }];
      });
      const railWidth = railCover(pane);
      const bodyPx = cardBodyPx(TEXT_SIZE_INCREASE[currentTextSize()]);
      // One frame, computed once. It used to be spelled out twice — here and
      // again inside the correction below — which is two chances to disagree
      // about where the graph was supposed to go.
      const want = fitBoard(rects, {
        pane: { width: paneRect.width, height: paneRect.height }, rail: railWidth, bodyPx,
        floor: reach === "all" ? FIT_MIN_ZOOM : AUTO_FIT_MIN_ZOOM,
      });
      if (!want) return;
      const { zoom } = want;
      const epoch = moveCamera(want, duration);
      // Asked again if the window is resized while this one is still moving.
      refitRef.current = () => fitLeftRef.current(duration, reach);
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
          if (Math.abs(vpNow.zoom - zoom) > 0.01 || Math.abs(vpNow.x - want.x) > 2 || Math.abs(vpNow.y - want.y) > 2) {
            applyViewport(want, 0);
          }
        } catch { /* ignore */ }
      }, duration + 60);
    } catch { /* viewport not ready */ }
  }, [rf, applyViewport, moveCamera]);
  fitLeftRef.current = fitLeft;
  /** Fit all and F: the whole board, below the auto-fit's floor if it takes
   *  that, and held there for the fits that follow on their own. */
  const fitAll = useCallback(() => {
    fitAllHeldRef.current = true;
    fitLeft(CAMERA_SLOW_MS, "all");
  }, [fitLeft]);
  /** The reader panned or zoomed by hand: the auto-fit's floor is back. */
  const releaseFitAll = useCallback(() => { fitAllHeldRef.current = false; }, []);

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

  /** THE READER TOOK THE CAMERA. A wheel, a pinch or a press on the canvas
   *  while a fit or a focus is animating stops it where it stands: the pane's
   *  d3 transition is interrupted (d3-zoom's own gestures already do that, and
   *  this covers the ones that arrive through the store), the fit's trailing
   *  correction is superseded so it cannot put the board back over the move,
   *  and the deck's stamp is cleared so what follows reads as the reader's own
   *  gesture and not as the tail of the fit. A no-op when nothing is moving. */
  const takeOver = useCallback(() => {
    if (!pendingFitRef.current) return;
    pendingFitRef.current = null;
    refitRef.current = null;
    cameraEpochRef.current += 1;
    lastFitTimeRef.current = 0;
    interruptPane(storeApi.getState().d3Selection);
  }, [storeApi]);

  /** A zoom step, in Fast on the same transition a fit uses (V4's Board
   *  camera): the buttons and the 100% reset. It starts from where the camera
   *  is, and a second press while one is moving adds to the goal of the first.
   *  About the middle of the pane, as React Flow's own zoomIn did, and never
   *  stamped as the deck's own fit: it is the reader's gesture, so auto-fit
   *  stands down for it (viewport-intent.ts). */
  const zoomStep = useCallback((goal: (zoom: number) => number) => {
    // A zoom by hand, from a key as well as a press: Fit all lets go.
    fitAllHeldRef.current = false;
    const { d3Zoom, d3Selection, minZoom, maxZoom } = storeApi.getState();
    const current = d3Selection?.property("__zoom") as PaneTransform | undefined;
    if (!d3Zoom || !d3Selection || !current || !(current.k > 0)) return;
    const live = zoomGoalRef.current && zoomGoalRef.current.until > Date.now() ? zoomGoalRef.current.zoom : current.k;
    const want = Math.max(minZoom ?? 0, Math.min(maxZoom ?? Infinity, goal(live)));
    if (!Number.isFinite(want) || !(want > 0)) return;
    cameraEpochRef.current += 1;
    refitRef.current = null;
    pendingFitRef.current = null;
    lastFitTimeRef.current = 0;
    if (shouldAnimateViewport({ durationMs: CAMERA_FAST_MS, documentHidden: document.hidden })) {
      zoomGoalRef.current = { zoom: want, until: Date.now() + CAMERA_FAST_MS + 60 };
      d3Zoom.scaleTo(stageTransition(d3Selection, CAMERA_FAST_MS) as never, want);
    } else {
      zoomGoalRef.current = null;
      d3Zoom.scaleTo(d3Selection, want);
    }
  }, [storeApi]);
  /** THE CAMERA SIDEWAYS BY `dx` SCREEN PX, AT ONCE, for the switch between
   *  the packed board and the board as laid out (use-repack-anchor.ts): the
   *  cards move in that frame, and the camera with them keeps the one the
   *  reader is zooming at where it was. Through the pane's d3-zoom, so a wheel
   *  or a pinch in progress carries on from here. A zoom step still on its way
   *  is interrupted by the move and sent on to its goal for the time it had
   *  left. Not stamped: it belongs to the reader's own zoom. */
  const panBy = useCallback((dx: number) => {
    if (!Number.isFinite(dx) || dx === 0) return;
    const { d3Zoom, d3Selection } = storeApi.getState();
    const current = d3Selection?.property("__zoom") as PaneTransform | undefined;
    if (!d3Zoom || !d3Selection || !current || !(current.k > 0)) return;
    d3Zoom.transform(d3Selection, current.translate(dx / current.k, 0));
    const goal = zoomGoalRef.current;
    const left = goal ? goal.until - 60 - Date.now() : 0;
    if (goal && left > 0 && shouldAnimateViewport({ durationMs: left, documentHidden: document.hidden })) {
      d3Zoom.scaleTo(stageTransition(d3Selection, left) as never, goal.zoom);
    }
  }, [storeApi]);
  /** The + and − buttons: one step of React Flow's own 1.2 each way. */
  const zoomBy = useCallback((factor: number) => zoomStep(zoom => zoom * factor), [zoomStep]);
  /** The level in the control bar: back to 100%. */
  const zoomReset = useCallback(() => zoomStep(() => 1), [zoomStep]);

  // A window resized in the middle of a fit would leave the animation on its
  // way to the frame the old window measured. After the layout has settled
  // (the 80ms the reframe waits too), the fit that was moving is asked again
  // and starts from where the camera is.
  useEffect(() => {
    let timer: number | undefined;
    const onResize = () => {
      if (!pendingFitRef.current || !refitRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (pendingFitRef.current) refitRef.current?.(); }, 100);
    };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); window.clearTimeout(timer); };
  }, []);

  /** Where the pane is right now, for a move that has to come back to it —
   *  Re-arrange keeps it so its Undo can return the view it replaced. */
  const currentViewport = useCallback(() => rf.getViewport(), [rf]);

  return {
    applyViewport, moveCamera, fitLeft, fitAll, releaseFitAll, panBy, boardRef, currentViewport, cameraEpochRef, lastFitTimeRef,
    takeOver, zoomBy, zoomReset,
  };
}
