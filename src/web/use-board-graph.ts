// The board as React Flow is handed it: which agents are drawn and which are
// spotlit, the cards and edges snapshotToFlow builds from the graph, the
// session drag handles behind them, and a drag in flight patched over the top.
//
// Moved out of App.tsx unchanged, every memo with the deps it had — including
// `stateRef.current` and its `revision`, which is what moves when applyEvent
// mutates the graph in place, and the counters (dragTick, recapNotesVersion,
// layoutEpoch) listed only so the nodes memo runs again. The building is
// canvas-flow.ts's; this is when it happens.
//
// Two hooks, because the layout signature is wanted first: the autosave and
// the auto-fit key off it, and App.tsx calls them before the frame the rest is
// packed for has been measured.
import { useMemo, useRef, type MutableRefObject } from "react";
import { snapshotToFlow } from "./canvas-flow";
import { layoutSignature } from "./layout-signature";
import { useRecapNotesVersion } from "./recap-note";
import type { GraphState } from "./reducer";
import { visibleBoard } from "./remove-node";
import { sessionGroupNodes } from "./session-group-nodes";
import { spotlightUnion } from "./spotlight";
import type { useBoardLayout } from "./use-board-layout";
import type { useBubbleAnimation } from "./use-bubble-animation";
import { computeVisibleIds } from "./visibility";

/** What the layout keys off: the visible, not-removed agents and their
 *  parents, plus the two size versions — layout-signature.ts. */
export function useLayoutSig({ stateRef, now, removedAgentIds, sizeVersion, domSizeVersion }: {
  stateRef: MutableRefObject<GraphState>;
  now: number;
  /** Everything Remove node has taken off the board, which the layout skips. */
  removedAgentIds: ReadonlySet<string>;
  /** The two measurement counters — use-node-measurements.ts. */
  sizeVersion: number;
  domSizeVersion: number;
}): string {
  const layoutSig = useMemo(
    () => layoutSignature(stateRef.current.agents.values(), now, removedAgentIds, sizeVersion, domSizeVersion),
    [stateRef.current, stateRef.current.revision, now, sizeVersion, domSizeVersion, removedAgentIds],
  );
  return layoutSig;
}

export function useBoardGraph({
  stateRef, now, availableWidth, availableHeight, layout, measuredRef, onBubble, settled, dragging,
  layoutSig, selectedIds, openContext, historyReplayed, removedNodes, removedAgentIds,
  dragTick, dragPatchRef, dragMoveTick,
}: {
  stateRef: MutableRefObject<GraphState>;
  now: number;
  /** The frame the board is packed for — use-layout-frame.ts. */
  availableWidth: number;
  availableHeight: number;
  /** The stored positions, pins and placeholders the cards are placed from. */
  layout: ReturnType<typeof useBoardLayout>;
  measuredRef: MutableRefObject<Map<string, { width: number; height: number }>>;
  onBubble: ReturnType<typeof useBubbleAnimation>["onBubble"];
  /** Whether the cards have had time to mount and measure. */
  settled: boolean;
  /** True for the length of any drag gesture. */
  dragging: boolean;
  layoutSig: string;
  selectedIds: Set<string>;
  openContext: (sessionId: string) => void;
  /** Whether the history replay has finished — see liveSince. */
  historyReplayed: boolean;
  /** What Remove node took off the board, and everything that hides with it. */
  removedNodes: ReadonlySet<string>;
  removedAgentIds: ReadonlySet<string>;
  /** Bumped on each group-drag move, so the nodes are rebuilt at once. */
  dragTick: number;
  /** Live positions of whatever is being dragged, and the counter that moves with them. */
  dragPatchRef: MutableRefObject<Map<string, { x: number; y: number }> | null>;
  dragMoveTick: number;
}) {
  const { pinnedRef, positionsRef, provisionalRef, lastLayoutSigRef, restoredLayout, layoutEpoch } = layout;

  // Union spotlight set — lineage of every selected agent merged. Multi-
  // select widens the spotlight without losing the "follow the chain"
  // semantics for a single click.
  const spotlightSet = useMemo<Set<string> | null>(
    () => spotlightUnion(stateRef.current, selectedIds),
    [stateRef.current, stateRef.current.revision, selectedIds],
  );

  // The visibility set drives BOTH the React Flow nodes prop and the
  // burst overlay's render gate — single source of truth so the two
  // can never disagree (which previously left orphan bursts on screen
  // when an agent was filtered out via one path but not the other).
  const visibleAgentIds = useMemo<Set<string>>(
    () => {
      const ids = computeVisibleIds(stateRef.current, now);
      for (const id of removedAgentIds) ids.delete(id);
      return ids;
    },
    [stateRef.current, stateRef.current.revision, now, removedAgentIds],
  );

  // How big each session was last frame, so a session that fans out subagents
  // can be told apart from one that merely re-rendered. Owned here rather than
  // in layout.ts because it is memory, not geometry.
  const prevSessionSizeRef = useRef<Map<string, { w: number; h: number }>>(new Map());

  // Put away and brought back through recap-note.ts, and the note nodes are
  // built from it: a × has to rebuild the canvas now, not on the next tick.
  const recapNotesVersion = useRecapNotesVersion();

  // Rebuilt on every render, drags included.
  //
  // Freezing it during a drag was tried and reverted: it looks like an obvious
  // win — the rebuild is the most expensive thing here — but the node under the
  // cursor then stopped moving until the mouse came up. React Flow is given
  // `nodes` with no onNodesChange, so this array and React Flow's own store
  // both believe they own positions, and holding this one still meant the
  // stale one won. Anything done here has to keep the two in agreement.
  const { nodes, edges } = useMemo(
    () => {
      const flow = snapshotToFlow(
      stateRef.current, now, availableWidth, availableHeight, pinnedRef.current,
      measuredRef.current, prevSessionSizeRef.current, onBubble, settled, dragging,
      positionsRef.current, provisionalRef.current, layoutSig, lastLayoutSigRef,
      selectedIds, spotlightSet, visibleAgentIds, openContext, historyReplayed,
      restoredLayout.restored,
      );
      return visibleBoard(flow.nodes, flow.edges, removedNodes);
    },
    [stateRef.current, stateRef.current.revision, now, availableWidth, availableHeight, settled, dragging, layoutSig, selectedIds, spotlightSet, visibleAgentIds, openContext, dragTick, recapNotesVersion, removedNodes, layoutEpoch, historyReplayed],
  );

  // Invisible per-session drag-handle nodes, one behind each session's cards;
  // see session-group-nodes.ts.
  const groupNodes = useMemo(() => sessionGroupNodes(nodes), [nodes]);

  /**
   * The array React Flow renders, with the in-flight drag applied on top.
   *
   * React Flow is given `nodes` without `onNodesChange`. That makes it fully
   * controlled: it does not move nodes itself, it reports the position changes
   * it would make and expects them to be applied. Nothing applied them, so the
   * only thing that has ever moved a node here is this array being rebuilt —
   * and that happens on the clock tick, four times a second.
   *
   * Hence the shape of the bug: a slow drag looked fine because four updates a
   * second is enough to look continuous, and a fast one visibly stepped and
   * trailed, because the gap between updates is however far the cursor got in
   * 250ms.
   *
   * So the drag is applied here instead, on every pointer move: the base array
   * is left to rebuild at its own pace, and the positions of the nodes being
   * dragged are patched over it. A patch is one shallow copy per node, which
   * is nothing next to rebuilding the graph from the event log — and it is the
   * whole reason the previous two attempts failed. Both tried to make the
   * rebuild happen less often, when the rebuild was the only thing moving the
   * node; the node then did not move at all until the mouse came up.
   */
  const allNodes = useMemo(() => {
    const base = [...groupNodes, ...nodes];
    const patch = dragPatchRef.current;
    if (!patch || patch.size === 0) return base;
    return base.map(nd => {
      const p = patch.get(nd.id);
      return p ? { ...nd, position: p } : nd;
    });
  }, [groupNodes, nodes, dragMoveTick]);

  return { spotlightSet, visibleAgentIds, nodes, edges, allNodes };
}
