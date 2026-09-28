// Taking the reader to a card: focusAgent frames one card and its session,
// stepAgent walks the cards with j and k, and focusSession selects a session's
// root and frames it. Every "take me to this card" in the deck comes through
// here.
//
// Moved out of App.tsx unchanged. The camera is use-camera's, the selection
// use-selection's; what this file adds is the box a focus frames and the order
// j and k walk. focusAgentRef and lastFocusRef stay App.tsx's because the
// reframe effect reads them too.
import { useCallback, type MutableRefObject } from "react";
import type { Node } from "reactflow";
import { laneMap, type FlowNodeData } from "./canvas-flow";
import { stepTarget } from "./canvas-keys";
import { focusCanvasNode, isCanvasNodeElement } from "./canvas-node-element";
import { hidePeek } from "./components/SessionPeek";
import { focusViewport, unionBox, type FlowBox } from "./focus-camera";
import type { GraphState } from "./reducer";
import { TOOL_LANE_ALLOWANCE, type useCamera } from "./use-camera";
import type { useSelection } from "./use-selection";

/** How long a focus takes to arrive (focusAgent): the fit's own pace, a little
 *  quicker, because the reader asked for this one and is waiting on it. */
const FOCUS_MS = 450;

export function useAgentFocus({
  canvasRef, stateRef, measuredRef, nodesRef, railInsetRef, moveCamera, disableAutoFit,
  lastFocusRef, focusAgentRef, selectAgent, primarySelectedIdRef,
}: {
  canvasRef: MutableRefObject<HTMLElement | null>;
  stateRef: MutableRefObject<GraphState>;
  measuredRef: MutableRefObject<Map<string, { width: number; height: number }>>;
  /** The array React Flow was last handed, read at call time so the callbacks are made once. */
  nodesRef: MutableRefObject<Node[]>;
  /** How far the rail of floating panels covers the canvas's right edge. */
  railInsetRef: MutableRefObject<number>;
  moveCamera: ReturnType<typeof useCamera>["moveCamera"];
  disableAutoFit: () => void;
  lastFocusRef: MutableRefObject<{ id: string; at: number } | null>;
  focusAgentRef: MutableRefObject<(id: string) => void>;
  selectAgent: ReturnType<typeof useSelection>["selectAgent"];
  primarySelectedIdRef: MutableRefObject<string | null>;
}) {
  /** BRING ONE CARD, AND THE SESSION IT BELONGS TO, INTO A READABLE VIEW.
   *
   *  Every "take me to this card" in the deck comes through here — the ribbon,
   *  a cluster's name, a double-click, Z, j/k, W and the session list. They each
   *  called React Flow's `fitView` over the one node, which centres on the whole
   *  pane — under the machine and usage panels whenever those are open — and
   *  zooms to the canvas's 1.6 ceiling, with the rest of the session cut out of
   *  the frame. focus-camera.ts holds the replacement: the session in the part
   *  of the pane nobody covers, at a zoom the full card is drawn at.
   *
   *  AND IT TAKES THE WHEEL, the way a pan does. Asking to look at one session
   *  is the reader choosing the view, and the auto-fit used to take it straight
   *  back: the next tool lane or card anywhere moved layoutSig, fitLeft framed
   *  the whole board again, and the session the reader had just gone to was a
   *  tile once more. The chip that says auto-fit is off, and its Resume, are
   *  the way back — the same as after a pan. */
  const focusAgent = useCallback((id: string) => {
    const pane = canvasRef.current;
    const agent = stateRef.current.agents.get(id);
    if (!pane || !agent) return;
    const lanes = laneMap(stateRef.current);
    const boxOf = (n: Node<FlowNodeData>, withLane: boolean): FlowBox | null => {
      const m = measuredRef.current.get(n.id);
      if (!m) return null;
      // The bubbles an agent has called are drawn to its right and are part
      // of what the reader came to see: the same allowance fitLeft makes.
      const lane = withLane && lanes.has(n.id) ? TOOL_LANE_ALLOWANCE : 0;
      return { x: n.position.x, y: n.position.y, width: m.width + lane, height: m.height };
    };
    const own = nodesRef.current.find(n => n.id === id);
    const anchor = own ? boxOf(own, false) : null;
    if (!anchor) return;
    const members: FlowBox[] = [];
    for (const n of nodesRef.current) {
      if (n.type !== "agent" && n.type !== "recapNote") continue;
      if ((n.data as { sessionId?: string } | undefined)?.sessionId !== agent.sessionId) continue;
      const b = boxOf(n, n.type === "agent");
      if (b) members.push(b);
    }
    const rect = pane.getBoundingClientRect();
    const want = focusViewport({
      pane: { width: rect.width, height: rect.height },
      // Left: the control stack. Top: the tool filter bar. Right: whatever of
      // the rail of floating panels is open, as the rail effect measured it.
      insets: { top: 56, left: 72, bottom: 32, right: railInsetRef.current + 32 },
      context: unionBox(members) ?? anchor,
      anchor,
    });
    hidePeek();
    disableAutoFit();
    lastFocusRef.current = { id, at: Date.now() };
    moveCamera(want, FOCUS_MS);
  }, [moveCamera, disableAutoFit]);

  focusAgentRef.current = focusAgent;

  /** Step through visible agents in render order. `direction` is +1 for
   *  next (j) or -1 for previous (k). Selecting moves the canvas to keep
   *  the chosen agent in view.
   *
   *  The order and the wrap-around live in canvas-keys.ts, where they can be
   *  tested without a canvas; what stays here is the two things that need one,
   *  the fit and the focus. */
  const stepAgent = useCallback((direction: 1 | -1) => {
    // Cards only: a recap note is a node on the canvas, not a stop for j and k.
    const current = nodesRef.current.filter(n => n.type === "agent");
    const targetId = stepTarget(
      current.map(n => ({ id: n.id, x: n.position.x, y: n.position.y })),
      primarySelectedIdRef.current,
      direction,
    );
    const target = targetId ? current.find(n => n.id === targetId) : undefined;
    if (!target) return;
    // Traversal takes the keyboard with it, but only when the keyboard was
    // already on a card. j from <body> is the shortcut it has always been —
    // it selects, and every other single-key shortcut stays live because
    // nothing is focused. j from a card is navigation, and leaving focus
    // behind on the card the user just stepped off would make the next Enter
    // re-select the one they left rather than the one they moved to.
    const follow = isCanvasNodeElement(document.activeElement);
    selectAgent(target.id, false);
    // Fit-view to the chosen node so it lands on screen even if the user
    // had panned away.
    window.setTimeout(() => {
      try { focusAgent(target.id); } catch {}
      if (follow) focusCanvasNode(target.id);
    }, 30);
  }, [selectAgent, focusAgent]);

  /** Select a session's root and bring it on screen. Through focusAgent, which
   *  reads `nodesRef` rather than the render-scope array so callers can be
   *  memoised: the array is rebuilt every render and would otherwise re-create
   *  every handler that closes over it. The frame of delay is for the same
   *  reason the session list has always needed one — the node has to be laid
   *  out before focusAgent has a box to frame. */
  const focusSession = useCallback((sessionId: string) => {
    selectAgent(sessionId, false);
    window.setTimeout(() => {
      try { focusAgent(sessionId); } catch {}
    }, 60);
  }, [selectAgent, focusAgent]);

  return { focusAgent, stepAgent, focusSession };
}
