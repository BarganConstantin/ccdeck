// The category filter row that floats over the canvas: which categories have a
// tool on the board, which ones somebody muted, and the bar getting out of the
// way when a card or a bubble slides underneath it.
//
// The bar floats over the top-left of the canvas, which is fine until you pan:
// then cards and tool bubbles slide underneath it and stay there, because
// nothing re-frames a viewport the user chose. Reported with a screenshot of a
// Bash bubble half-eaten by the bar, and a workaround — pressing Clear after
// every update — that throws away the canvas to move one toolbar.
//
// So the bar yields instead. When anything is beneath it the bar drops to a
// fifth of its opacity, and hovering or focusing it brings it straight back.
// Measured rather than derived: bubbles are positioned by the burst layer in
// screen space, so the DOM is the only place both live in the same
// coordinates. A 300ms poll of a bounded set of rects is cheaper than it
// sounds and stops entirely when the tab is hidden or the bar is absent.
//
// Lifted out of App.tsx's `Inner`, where these were five pieces spread across
// eleven hundred lines. The muted set changes only through toggleCat, and the
// occlusion flag only through its own measuring loop: both setters are private.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import { anyTouches } from "./visibility";
import { DETAIL_CAT_EMOJI, detailCategoryFor, type DetailCategory } from "./detail-category";
import type { GraphState } from "./reducer";

export function useCategoryFilterBar(stateRef: MutableRefObject<GraphState>) {
  const catBarRef = useRef<HTMLDivElement | null>(null);
  const [catBarOccluded, setCatBarOccluded] = useState(false);
  /** Categories the user has muted via the filter chips. Bursts whose
   *  category is in this set don't render. Reset only by toggling them
   *  back on (R / clear don't touch it — filters are user intent). */
  const [hiddenCats, setHiddenCats] = useState<Set<DetailCategory>>(() => new Set());

  // Which categories currently have at least one tool on the canvas — the
  // filter row only shows chips for active categories so users aren't
  // staring at empty toggle buttons.
  const presentCats = useMemo<DetailCategory[]>(() => {
    const set = new Set<DetailCategory>();
    for (const a of stateRef.current.agents.values()) {
      for (const t of a.tools) set.add(detailCategoryFor(t.name));
    }
    // Stable order: same as DETAIL_CAT_EMOJI declaration order.
    return (Object.keys(DETAIL_CAT_EMOJI) as DetailCategory[]).filter(c => set.has(c));
  }, [stateRef.current, stateRef.current.revision]);
  useEffect(() => {
    if (presentCats.length <= 1) { setCatBarOccluded(false); return; }
    let timer = 0;
    const tick = () => {
      const bar = catBarRef.current;
      if (bar && !document.hidden) {
        const b = bar.getBoundingClientRect();
        // Cards and bubbles both — a bubble is what the report showed, and it
        // lives in a different layer from the nodes.
        const boxes = Array.from(document.querySelectorAll(".react-flow__node, .tool-burst"))
          .map(el => el.getBoundingClientRect());
        const hit = anyTouches(b, boxes, 8);
        setCatBarOccluded(prev => (prev === hit ? prev : hit));
      }
      timer = window.setTimeout(tick, 300);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [presentCats.length]);

  const toggleCat = useCallback((c: DetailCategory) => {
    setHiddenCats(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }, []);

  return { presentCats, hiddenCats, toggleCat, catBarRef, catBarOccluded };
}
