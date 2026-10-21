// How big every card on the canvas is.
//
// Lifted out of App.tsx's `Inner` unchanged. Two sources fill one map: a
// subscription to React Flow and a DOM pass after each render, coalesced
// into one deferred measurement. A size must move by more than 4px before
// its counter changes. The layout keys off both counters; the camera, the
// drift watchdog and the zoom's level of detail read the map. All of the
// writing is here.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useStoreApi } from "reactflow";
import { SESSION_GROUP_TYPE } from "./minimap";

/**
 * @param draggingRef True for the length of a drag. Cards do not change size
 *   while one is dragged, and the DOM pass forces a synchronous layout on a
 *   render that happens on every pointer move, so it is skipped for the gesture.
 */
export function useNodeMeasurements(draggingRef: MutableRefObject<boolean>) {
  const store = useStoreApi();
  const measuredRef = useRef<Map<string, { width: number; height: number }>>(new Map());
  const measuredVersionRef = useRef(0);
  const storeSizesRef = useRef<Map<string, { width: number; height: number }>>(new Map());
  const [sizeVersion, setSizeVersion] = useState(0);
  const [domSizeVersion, setDomSizeVersion] = useState(0);
  const pendingRef = useRef<{ frame: number; timer: number } | null>(null);

  const measure = useCallback(() => {
    pendingRef.current = null;
    let storeChanged = false;
    // Read the latest committed store once. A selector must not mutate a
    // measurement counter: ResizeObserver and controlled nodes can present
    // different sizes in one commit, recursively rendering their own writer.
    for (const n of store.getState().nodeInternals.values()) {
      if (n.type === SESSION_GROUP_TYPE) continue; // geometry derived from cards
      const w = n.width, h = n.height;
      if (w == null || h == null) continue;
      const prev = storeSizesRef.current.get(n.id);
      if (!prev || Math.abs(prev.width - w) > 4 || Math.abs(prev.height - h) > 4) {
        storeSizesRef.current.set(n.id, { width: w, height: h });
        measuredRef.current.set(n.id, { width: w, height: h });
        storeChanged = true;
      }
    }
    if (storeChanged) {
      measuredVersionRef.current += 1;
      setSizeVersion(measuredVersionRef.current);
    }

    // DOM sizes remain the fallback when controlled nodes replace Flow's
    // internals. They share one scheduled pass with store notifications.
    if (draggingRef.current) return;
    let domChanged = false;
    for (const el of document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
      if (el.classList.contains(`react-flow__node-${SESSION_GROUP_TYPE}`)) continue;
      const id = el.getAttribute("data-id");
      if (!id) continue;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (!w || !h) continue;
      const prev = measuredRef.current.get(id);
      if (!prev || Math.abs(prev.width - w) > 4 || Math.abs(prev.height - h) > 4) {
        measuredRef.current.set(id, { width: w, height: h });
        domChanged = true;
      }
    }
    if (domChanged) setDomSizeVersion(v => v + 1);
  }, [store, draggingRef]);

  const schedule = useCallback(() => {
    if (pendingRef.current) return;
    // Background tabs suspend rAF; their cards still need fresh dimensions.
    pendingRef.current = document.visibilityState === "hidden"
      ? { frame: 0, timer: window.setTimeout(measure, 32) }
      : { frame: requestAnimationFrame(measure), timer: 0 };
  }, [measure]);

  useEffect(() => {
    const unsubscribe = store.subscribe(schedule);
    schedule();
    return () => {
      unsubscribe();
      const pending = pendingRef.current;
      if (pending) {
        cancelAnimationFrame(pending.frame);
        window.clearTimeout(pending.timer);
        pendingRef.current = null;
      }
    };
  }, [store, schedule]);
  // A card's markup can change before Flow's ResizeObserver updates the store.
  useEffect(schedule);

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
