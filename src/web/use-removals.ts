// What "Remove node" has taken off the board, and the way back. A removed card
// is hidden, not deleted: the session list (L) brings it back, and so does the
// session starting to wait or work again (App.tsx's call-back effect).
//
// Moved out of App.tsx unchanged. The rules — what a removal hides, what brings
// one back, how the set is stored — are remove-node.ts's; this is the state
// and the operations on it.
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import type { GraphState } from "./reducer";
import { readRemovedNodes, removalHiddenIds, saveRemovedNodes, withoutRemovals } from "./remove-node";
import type { useBoardLayout } from "./use-board-layout";

type Layout = ReturnType<typeof useBoardLayout>;

export function useRemovals({ stateRef, pinnedRef, positionsRef, canvasRef, clearSelection, primarySelectedId }: {
  stateRef: MutableRefObject<GraphState>;
  pinnedRef: Layout["pinnedRef"];
  positionsRef: Layout["positionsRef"];
  /** Where focus goes once the control that removed the card has unmounted. */
  canvasRef: MutableRefObject<HTMLElement | null>;
  clearSelection: () => void;
  primarySelectedId: string | null;
}) {
  const [removedNodes, setRemovedNodes] = useState<Set<string>>(() =>
    readRemovedNodes(typeof window === "undefined" ? null : window.localStorage));
  /** The last card taken off the board, for the sentence a screen reader
   *  hears. Nothing is drawn for it: the session list (L) is the way back. */
  const [lastRemoval, setLastRemoval] = useState<{ id: string; label: string } | null>(null);

  // Everything "Remove node" has taken off the board: the removed agents, what
  // descends from them, and every agent of a removed session. Worked out once
  // and subtracted from BOTH layoutSig and visibleAgentIds in App.tsx, so the
  // cards, the tool bubbles and the layout drop a removed agent together.
  const removedAgentIds = useMemo(
    () => removalHiddenIds(stateRef.current.agents.values(), removedNodes),
    [stateRef.current, stateRef.current.revision, removedNodes],
  );

  const removeNode = useCallback((id: string) => {
    const agent = stateRef.current.agents.get(id);
    if (!agent) return;
    setRemovedNodes(previous => {
      const next = new Set(previous);
      next.add(id);
      saveRemovedNodes(window.localStorage, next);
      return next;
    });
    setLastRemoval({ id, label: agent.label });
    pinnedRef.current.delete(id);
    positionsRef.current.delete(id);
    clearSelection();
  }, [clearSelection]);

  const removeSelectedNode = useCallback(() => {
    if (primarySelectedId) removeNode(primarySelectedId);
  }, [primarySelectedId, removeNode]);

  // Said for as long as the card is still off the board: one that came back
  // through the session list or by starting to wait has nothing left to say.
  const removalNotice = lastRemoval && removedNodes.has(lastRemoval.id) ? lastRemoval : null;
  // The button that was pressed sat in the detail panel, which unmounts with
  // the selection, so focus would otherwise fall to <body> and a keyboard user
  // would start again from the top. <main> takes focus without taking the
  // single-key shortcuts (#367).
  useEffect(() => {
    if (lastRemoval) canvasRef.current?.focus();
  }, [lastRemoval]);

  const bringBack = useCallback((ids: Iterable<string>) => {
    const list = [...ids];
    setRemovedNodes(previous => {
      const next = withoutRemovals(previous, list);
      if (next !== previous) saveRemovedNodes(window.localStorage, next);
      return next;
    });
  }, []);

  return { removedNodes, setRemovedNodes, lastRemoval, setLastRemoval, removedAgentIds,
           removeNode, removeSelectedNode, removalNotice, bringBack };
}
