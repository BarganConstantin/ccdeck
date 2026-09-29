// The auto-fit: what brings the board back into view without being asked.
// Two triggers, both of which stand down while the user has taken the wheel
// (autoFitDisabledRef — use-auto-fit-switch.ts holds the switch): a layout
// signature that moved, and a board that drifted off the pane.
//
// Moved out of App.tsx unchanged, with the two refs only the signature trigger
// reads. The fit itself is use-camera's fitLeft.
import { useEffect, useRef, type MutableRefObject } from "react";
import type { ReactFlowInstance } from "reactflow";
import { shouldRefit, type NodeBox, type PaneSize } from "./drift";
import type { GraphState } from "./reducer";
import type { useBoardLayout } from "./use-board-layout";
import type { useCamera } from "./use-camera";
import { isAgentVisible } from "./visibility";

type Layout = ReturnType<typeof useBoardLayout>;

export function useAutoFit({
  layoutSig, rf, stateRef, measuredRef, pinnedRef, positionsRef, paneSizeRef, lastInteractRef,
  autoFitDisabledRef, lastFitTimeRef, fitLeft,
}: {
  /** Visible agent ids plus the two size versions: what moves when the board changes shape. */
  layoutSig: string;
  rf: ReactFlowInstance;
  stateRef: MutableRefObject<GraphState>;
  measuredRef: MutableRefObject<Map<string, { width: number; height: number }>>;
  pinnedRef: Layout["pinnedRef"];
  positionsRef: Layout["positionsRef"];
  /** The pane as the deck measured it, which the drift check tests boxes against (#615). */
  paneSizeRef: MutableRefObject<PaneSize | null>;
  /** When a pan, zoom or drag last touched the canvas; the watchdog waits 800ms after one. */
  lastInteractRef: MutableRefObject<number>;
  autoFitDisabledRef: MutableRefObject<boolean>;
  lastFitTimeRef: ReturnType<typeof useCamera>["lastFitTimeRef"];
  fitLeft: ReturnType<typeof useCamera>["fitLeft"];
}): void {
  // The auto-fit's trailing timer (see the layout-signature effect below).
  const fitTimerRef = useRef<number | null>(null);

  const lastLayoutSigForFitRef = useRef("");

  // Auto-recover from "drifted off-screen": every 1.5s check whether ANY
  // agent's bounding box intersects the visible viewport. If none have at
  // all, fit-view immediately. Skipped only when the user is actively
  // interacting (pan/zoom/drag in the last 800ms) so we don't yank the view
  // mid-gesture. This is the failsafe that recovers from layout reflows
  // when a new session arrives and dagre shifts everything off-screen.
  useEffect(() => {
    const id = setInterval(() => {
      if (autoFitDisabledRef.current) return;
      if (Date.now() - lastInteractRef.current < 800) return;
      const state = stateRef.current;
      const t = Date.now();
      const liveAgents: { id: string }[] = [];
      for (const a of state.agents.values()) {
        // Mirror isAgentVisible — was inline `exitAt + EXIT_ANIM_MS` only,
        // which skipped the ghost-session filter and disagreed with the node
        // renderer when stale-exitAt replays excluded subagents that the
        // canvas was still showing. Use the single source of truth.
        if (!isAgentVisible(a, t)) continue;
        liveAgents.push({ id: a.id });
      }
      if (liveAgents.length === 0) return;
      const boxes: NodeBox[] = [];
      for (const { id } of liveAgents) {
        const size = measuredRef.current.get(id);
        const pos = pinnedRef.current.get(id) ?? positionsRef.current.get(id);
        // An agent with no measurement or no position is not evidence either
        // way, so it is left out rather than counted as off-screen.
        if (!size || !pos) continue;
        boxes.push({ x: pos.x, y: pos.y, width: size.width, height: size.height });
      }
      // The decision itself lives in drift.ts, against the pane the deck
      // measured rather than a rectangle guessed from the window. `getViewport`
      // returns the pane's transform, so a node projected through it is in
      // pane-relative pixels — and the only rectangle in the same coordinate
      // space is the pane's own size. It used to be tested against
      // `innerWidth - 360`, which is the window minus a detail panel assumed
      // always open: right in one of the six layouts `.app` grids itself into,
      // wrong in the five others including the one the deck starts in (#615).
      if (shouldRefit({ pane: paneSizeRef.current, viewport: rf.getViewport(), boxes })) {
        fitLeft(600);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [rf]);

  // Auto-fit on layout-signature changes — the single source of truth for
  // structural shifts: agent added/removed, parent relationship changed, or
  // a measurement that moved a node. Catches the "14 agents in state but
  // none visible" case where count is stable but the layout reflowed.
  // Suspended entirely when the user has taken manual control of the
  // viewport (see autoFitDisabledRef + recenter button in Controls).
  useEffect(() => {
    if (lastLayoutSigForFitRef.current === layoutSig) return;
    const prev = lastLayoutSigForFitRef.current;
    lastLayoutSigForFitRef.current = layoutSig;
    if (!prev) return; // first render — let initial fitView prop handle it
    if (autoFitDisabledRef.current) return;
    const tnow = Date.now();
    if (tnow - lastFitTimeRef.current > 1200) {
      fitLeft(400);
    }
    if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => {
      if (autoFitDisabledRef.current) return;
      fitLeft(500);
    }, 280);
  }, [layoutSig, rf, fitLeft]);
}
