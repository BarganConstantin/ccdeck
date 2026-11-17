// The tool filter's state: which categories have a tool on the board, and which
// ones somebody muted.
//
// Its control is the last group of the canvas bar's ⋯ menu (CanvasControls.tsx,
// the rows in CategoryFilterBar.tsx). It used to be a bar floating over the
// canvas's top left, which dimmed itself when a card or a bubble slid under it,
// measured on a 300ms poll; with the control in a menu nothing floats over the
// cards, and the measuring went with it (V4 top-10 #5).
//
// Lifted out of App.tsx's `Inner`, where these were pieces spread across eleven
// hundred lines. The muted set changes only through toggleCat: its setter is
// private.
import { useCallback, useMemo, useState, type MutableRefObject } from "react";

import { DETAIL_CAT_EMOJI, detailCategoryFor, type DetailCategory } from "./detail-category";
import type { GraphState } from "./reducer";

export function useCategoryFilterBar(stateRef: MutableRefObject<GraphState>) {
  /** Categories the user has muted via the filter chips. Bursts whose
   *  category is in this set don't render. Reset only by toggling them
   *  back on (R / clear don't touch it — filters are user intent). */
  const [hiddenCats, setHiddenCats] = useState<Set<DetailCategory>>(() => new Set());

  // Which categories currently have at least one tool on the canvas — the
  // filter only shows rows for active categories so users aren't staring at
  // empty toggles.
  const presentCats = useMemo<DetailCategory[]>(() => {
    const set = new Set<DetailCategory>();
    for (const a of stateRef.current.agents.values()) {
      for (const t of a.tools) set.add(detailCategoryFor(t.name));
    }
    // Stable order: same as DETAIL_CAT_EMOJI declaration order.
    return (Object.keys(DETAIL_CAT_EMOJI) as DetailCategory[]).filter(c => set.has(c));
  }, [stateRef.current, stateRef.current.revision]);

  const toggleCat = useCallback((c: DetailCategory) => {
    setHiddenCats(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }, []);

  return { presentCats, hiddenCats, toggleCat };
}
