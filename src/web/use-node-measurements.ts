// How big every card on the canvas is.
//
// Lifted out of App.tsx's `Inner` unchanged. Two sources fill one map: a
// selector over React Flow's store, which ticks a counter only when a size
// moved by more than 4px, and a pass over the rendered cards after every
// render, because the store drops the sizes each time the `nodes` prop is
// replaced (see below). The layout keys off both counters; the camera, the
// drift watchdog and the zoom's level of detail read the map. All of the
// writing is here.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useStore, type ReactFlowState } from "reactflow";

/**
 * @param draggingRef True for the length of a drag. Cards do not change size
 *   while one is dragged, and the DOM pass forces a synchronous layout on a
 *   render that happens on every pointer move, so it is skipped for the gesture.
 */
export function useNodeMeasurements(draggingRef: MutableRefObject<boolean>) {
  // Real per-node sizes — read from RF's internal store via a selector that
  // returns a monotonic counter. Counter only ticks when a measurement
  // actually changed (delta > 4px) or a new node was measured. No
  // recursion: stable input → stable output → no extra render.
  const measuredRef = useRef<Map<string, { width: number; height: number }>>(new Map());
  const measuredVersionRef = useRef(0);
  const measuredSelector = useCallback((s: ReactFlowState) => {
    const map = measuredRef.current;
    let changed = false;
    for (const n of s.nodeInternals.values()) {
      const w = n.width, h = n.height;
      if (w == null || h == null) continue;
      const prev = map.get(n.id);
      if (!prev) {
        map.set(n.id, { width: w, height: h });
        changed = true;
      } else if (Math.abs(prev.height - h) > 4 || Math.abs(prev.width - w) > 4) {
        map.set(n.id, { width: w, height: h });
        changed = true;
      }
    }
    if (changed) measuredVersionRef.current += 1;
    return measuredVersionRef.current;
  }, []);
  const sizeVersion = useStore(measuredSelector);
  const [domSizeVersion, setDomSizeVersion] = useState(0);

  // Measure the rendered cards directly, as a source that does not depend on
  // React Flow's store holding on to them.
  //
  // It does not: createNodeInternals rebuilds every entry as `{...node}` from
  // the incoming `nodes` prop, carrying over handleBounds but NOT width and
  // height. This canvas replaces that prop on every tick, so a measurement
  // taken by the ResizeObserver survives until the next render and is then
  // dropped. That closed a loop — the store lost the sizes, so the selector
  // above read null and skipped, so the map stayed empty, so the nodes we
  // passed carried no sizes for the store to keep. fitView needs dimensions
  // to compute bounds and silently returns false without them, which is why
  // nothing was ever framed.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const map = measuredRef.current;
      let changed = false;
      for (const el of document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
        const id = el.getAttribute("data-id");
        if (!id) continue;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) continue;
        const prev = map.get(id);
        // Same 4px deadband as the store selector: sub-pixel jitter must not
        // trigger a relayout.
        if (!prev || Math.abs(prev.width - w) > 4 || Math.abs(prev.height - h) > 4) {
          map.set(id, { width: w, height: h });
          changed = true;
        }
      }
      if (changed) setDomSizeVersion(v => v + 1);
    };
    // After paint, so the cards have their final size — except in a background
    // tab, where requestAnimationFrame never fires at all. The deck is a thing
    // people leave open on a second monitor or behind their editor, so an
    // rAF-only schedule means sizes stop updating exactly when nobody is
    // looking, and the layout they come back to was computed from stale ones.
    // offsetWidth/offsetHeight on every card forces a synchronous layout, and
    // a drag re-renders on every pointer move. Cards do not change size while
    // one is being dragged, so the whole pass is skipped for the gesture.
    if (draggingRef.current) return;
    let timer = 0;
    if (document.visibilityState === "hidden") {
      timer = window.setTimeout(measure, 32);
    } else {
      raf = requestAnimationFrame(measure);
    }
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  });

  return { measuredRef, measuredVersionRef, sizeVersion, domSizeVersion };
}

/** Whether the cards have had time to mount and measure: false for the page's
 *  first 2.5s, then true for good. Moved out of App.tsx unchanged, and called
 *  there where it was; the layout and the reframe hold back until it is. */
export function useSettled(): boolean {
  // Sizes only mean something once the cards have all mounted and measured.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  return settled;
}
