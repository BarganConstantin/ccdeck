// Clear: the confirmation it waits on, the single door the toolbar button and
// the "c" shortcut both come through, and the wipe only the dialog's own button
// reaches. Which request does what is clear-confirm.ts's rule; this is the
// state and the two callbacks around it.
//
// Moved out of App.tsx unchanged. The door asks the modal gate
// (use-modal-gate.ts) whether another dialog is up, through the same ref the
// keydown listener reads.
import { useCallback, useState, type MutableRefObject } from "react";
import { clearActionFor, type ClearSource } from "./clear-confirm";
import { clearStoredLayout } from "./layout-storage";
import { initialState, type GraphState } from "./reducer";
import type { useBoardLayout } from "./use-board-layout";
import { useMirroredRef } from "./use-mirrored-ref";

type Layout = ReturnType<typeof useBoardLayout>;

export function useClearFlow({
  stateRef, pinnedRef, measuredRef, positionsRef, lastLayoutSigRef, forgetRemovals, clearSelection, rerender, modalOpenRef,
}: {
  /** The graph, replaced by an empty one. */
  stateRef: MutableRefObject<GraphState>;
  pinnedRef: Layout["pinnedRef"];
  measuredRef: MutableRefObject<Map<string, { width: number; height: number }>>;
  positionsRef: Layout["positionsRef"];
  lastLayoutSigRef: Layout["lastLayoutSigRef"];
  forgetRemovals: () => void;
  clearSelection: () => void;
  rerender: () => void;
  /** Whether another dialog is up — use-modal-gate.ts. */
  modalOpenRef: { readonly current: boolean };
}) {
  /** Whether the Clear confirmation is up. Clear truncates the server's event
   *  log, so nothing destructive happens until this dialog is answered. */
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const handleClear = useCallback(async () => {
    try { await fetch("/api/clear", { method: "POST" }); } catch {}
    stateRef.current = initialState();
    pinnedRef.current.clear();
    measuredRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    forgetRemovals();
    clearSelection();
    rerender();
  }, [rerender, clearSelection, forgetRemovals]);

  // The keydown listener is registered once and must stay that way, so the
  // gate reads what is on screen through refs rather than closing over it.
  // Assigned during render, the way App's nodesRef is, so a keystroke in the
  // same commit sees the dialogs that were just drawn.
  const clearConfirmOpenRef = useMirroredRef(clearConfirmOpen);

  /** The single door to Clear. Both the toolbar button and the "c" shortcut
   *  come through here, so the confirmation cannot hold for one and not the
   *  other, and only the dialog's own button reaches handleClear. */
  const requestClear = useCallback((source: ClearSource) => {
    const action = clearActionFor(source, {
      confirmOpen: clearConfirmOpenRef.current,
      modalOpen: modalOpenRef.current,
    });
    if (action === "confirm") setClearConfirmOpen(true);
    else if (action === "clear") { setClearConfirmOpen(false); handleClear(); }
  }, [handleClear]);

  return { clearConfirmOpen, setClearConfirmOpen, requestClear };
}
