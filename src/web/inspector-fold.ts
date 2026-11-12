// Usage and This machine fold to their header line while the Inspector is open
// on the Board. All three share the Board's right column (panel-place.css);
// folded, the two leave the Inspector the column, and closing the Inspector
// gives each back as it was.
//
// - The Inspector opens: every open panel folds to one row at the top of the
//   column (the title, one line of its figures and a chevron).
// - A press on a folded row opens that panel in place, above the Inspector.
//   Its title is then the same row button with the chevron turned up, and a
//   press folds it back to its row.
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
 *  Inspector folds it, and its unfold opens it again; opened while the
 *  Inspector is open (`refold` given), `refold` folds it back. With no
 *  Inspector there is no row to fold to. Workspace's dock is its own column's
 *  and is handed on as it is. */
export function withInspectorFold(dock: PanelDock, folded: boolean, unfold: () => void, refold?: () => void): PanelDock {
  if (dock.mode !== "board") return dock;
  if (folded) return { ...dock, folded: true, unfold };
  return refold ? { ...dock, refold } : dock;
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
  // Back to its row; with no Inspector there is no row to fold to.
  const fold = useCallback((k: SidePanel) => {
    if (was.current.on) setFolds(prev => (prev[k] ? prev : { ...prev, [k]: true }));
  }, []);
  return { folds, unfold, fold, on };
}
