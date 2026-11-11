// Usage and This machine fold to their header line while the Inspector is open
// on the Board. Both stay floating, movable panels; folded, they no longer
// cover the cards beside the Inspector, and closing it gives each back as it was.
//
// - The Inspector opens: every open panel folds to its header (the title, one
//   line of its readings and a chevron), and the two stack in the home slots
//   beside it (panel-place.css, "folded by the Inspector").
// - A press on a folded header opens that panel again; it floats until it is
//   closed or the Inspector closes.
// - A panel opened by its door or key while the Inspector is open opens unfolded.
// - The Inspector closes: nothing is folded. A panel it folded is open again
//   where it was; a closed one stays closed.
//
// The fold lives in memory alone and is never stored. Workspace has its own
// column and fold (side-column.ts) and a phone its sheets: neither takes this
// one (withInspectorFold, and panel-place.ts draws it on a desktop Board only).
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PanelDock, SidePanel } from "./side-column";

export type Folds = Readonly<Record<SidePanel, boolean>>;
export const NO_FOLDS: Folds = { usage: false, machine: false };

/** A panel's dock as the panel is told it: on the Board, folded while the
 *  Inspector folds it, and its unfold opens it again. Workspace's dock is its
 *  own column's and is handed on as it is. */
export function withInspectorFold(dock: PanelDock, folded: boolean, unfold: () => void): PanelDock {
  return dock.mode === "board" && folded ? { ...dock, folded: true, unfold } : dock;
}

/**
 * The folds after the Inspector or a panel's open flag moved. `on` is the
 * Inspector open on a desktop window. A panel that closes keeps its fold for
 * its exit, so it does not open up on the way out; the fold goes when it opens.
 */
export function nextFolds(prev: Folds, p: { on: boolean; wasOn: boolean; open: Folds; wasOpen: Folds }): Folds {
  if (!p.on) return NO_FOLDS;
  if (!p.wasOn) return { usage: p.open.usage, machine: p.open.machine };
  const keep = (k: SidePanel) => prev[k] && !(p.open[k] && !p.wasOpen[k]);
  return { usage: keep("usage"), machine: keep("machine") };
}

export function useInspectorFold(on: boolean, open: Folds) {
  const [folds, setFolds] = useState<Folds>(NO_FOLDS);
  const was = useRef<{ on: boolean; open: Folds }>({ on: false, open: NO_FOLDS });
  // Before paint, so the Inspector never shows beside an open panel for a frame.
  useLayoutEffect(() => {
    const before = was.current;
    const now = { usage: open.usage, machine: open.machine };
    was.current = { on, open: now };
    setFolds(prev => {
      const next = nextFolds(prev, { on, wasOn: before.on, open: now, wasOpen: before.open });
      return next.usage === prev.usage && next.machine === prev.machine ? prev : next;
    });
  }, [on, open.usage, open.machine]);
  const unfold = useCallback((k: SidePanel) => setFolds(prev => (prev[k] ? { ...prev, [k]: false } : prev)), []);
  return { folds, unfold };
}
