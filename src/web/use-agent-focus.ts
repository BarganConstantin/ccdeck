// Taking the reader to a card: focusAgent frames one card and its session,
// revealAgent brings a selected card into view without zooming in, stepAgent
// walks the cards with j and k, and focusSession selects a session's root and
// brings it into view. Every "take me to this card" in the deck comes through
// here.
//
// Moved out of App.tsx unchanged. The camera is use-camera's, the selection
// use-selection's; what this file adds is the box a focus frames and the order
// j and k walk. focusAgentRef and lastFocusRef stay App.tsx's because the
// reframe effect reads them too.
import { useCallback, type MutableRefObject } from "react";
import type { Node } from "reactflow";
import { boardRect } from "./board-rect";
import { landDelayMs, landOnCard } from "./card-land";
import { sessionOfNode } from "./layout-geometry";
import { laneMap, type FlowNodeData } from "./canvas-flow";
import { stepTarget } from "./canvas-keys";
import { focusCanvasNode, isCanvasNodeElement } from "./canvas-node-element";
import { hidePeek } from "./components/SessionPeek";
import { focusViewport, revealViewport, unionBox, type FlowBox, type PaneInsets } from "./focus-camera";
import type { GraphState } from "./reducer";
import { FAR_ZOOM } from "./semantic-zoom";
import { TOOL_LANE_ALLOWANCE, type useCamera } from "./use-camera";
import type { useSelection } from "./use-selection";
import type { useZoomLod } from "./use-zoom-lod";
import { CAMERA_SLOW_MS } from "./viewport-motion";

/** How long a focus takes to arrive (focusAgent): the camera's Slow, the fit's
 *  own pace (V4's Board camera: fit, recenter, jump, F and Z are one). */
const FOCUS_MS = CAMERA_SLOW_MS;

/** What of the pane a card is never framed under, in screen px from each
 *  edge. Top: the tool filter bar. Bottom: the row the control bar and the
 *  notices stand in (12px in, one button and its 6px of padding and edge,
 *  then air). Right: whatever of the rail of floating panels is open, as the
 *  rail effect measured it. Left: air; an open left panel is a column beside
 *  the canvas, so the canvas box already ends where the panel begins. The
 *  minimap keeps off the selected card by itself (minimap-place.ts). */
const paneInsets = (rail: number): PaneInsets => ({ top: 56, left: 32, bottom: 56, right: rail + 32 });

/** The last jump to a card, for the reframe (use-reframe.ts), which makes it
 *  again the same way when the canvas changes size a moment later: a reveal
 *  for a selection, a focus for a double-click, Z or a cluster's name. */
export interface LastFocus { id: string; at: number; reveal?: boolean }

export function useAgentFocus({
  canvasRef, stateRef, measuredRef, nodesRef, shownRef, lodRef, railInsetRef, moveCamera, currentViewport, disableAutoFit,
  lastFocusRef, focusAgentRef, selectAgent, primarySelectedIdRef, onLand,
}: {
  canvasRef: MutableRefObject<HTMLElement | null>;
  stateRef: MutableRefObject<GraphState>;
  measuredRef: MutableRefObject<Map<string, { width: number; height: number }>>;
  /** The array React Flow was last handed, read at call time so the callbacks are made once. */
  nodesRef: MutableRefObject<Node[]>;
  /** The board as React Flow draws it now, packed below the full card
   *  (use-board-graph.ts `shown`): where a selection is brought into view. */
  shownRef: MutableRefObject<Node[]>;
  /** Which card the canvas draws now: the notes are drawn at `detail` only. */
  lodRef: ReturnType<typeof useZoomLod>["lodRef"];
  /** How far the rail of floating panels covers the canvas's right edge. */
  railInsetRef: MutableRefObject<number>;
  moveCamera: ReturnType<typeof useCamera>["moveCamera"];
  /** Where the camera is now. */
  currentViewport: ReturnType<typeof useCamera>["currentViewport"];
  disableAutoFit: () => void;
  lastFocusRef: MutableRefObject<LastFocus | null>;
  /** The last jump's framing made again, for the reframe: set here. */
  focusAgentRef: MutableRefObject<(id: string) => void>;
  selectAgent: ReturnType<typeof useSelection>["selectAgent"];
  primarySelectedIdRef: MutableRefObject<string | null>;
  /** A jump to a session has begun: the rail's row for it says "here" once. */
  onLand?: (sessionId: string) => void;
}) {
  /** BRING ONE CARD, AND THE SESSION IT BELONGS TO, INTO A READABLE VIEW.
   *
   *  The explicit "frame this card" comes through here — a double-click, Z
   *  and a cluster's name; a selection only brings its card into view
   *  (revealAgent, below). They each called React Flow's `fitView` over the
   *  one node, which centres on the whole pane — under the machine and usage
   *  panels whenever those are open — and zooms to the canvas's 1.6 ceiling,
   *  with the rest of the session cut out of the frame. focus-camera.ts holds
   *  the replacement: the session in the part of the pane nobody covers, at a
   *  zoom the full card is drawn at.
   *
   *  AND IT TAKES THE WHEEL, the way a pan does. Asking to look at one session
   *  is the reader choosing the view, and the auto-fit used to take it straight
   *  back: the next tool lane or card anywhere moved layoutSig, fitLeft framed
   *  the whole board again, and the session the reader had just gone to was a
   *  tile once more. The control bar's recenter, marked while auto-fit is off,
   *  is the way back — the same as after a pan. */
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
      if (sessionOfNode(n) !== sessionOfNode(own!)) continue;
      const b = boxOf(n, n.type === "agent");
      if (b) members.push(b);
    }
    const rect = boardRect(pane);
    const want = focusViewport({
      pane: { width: rect.width, height: rect.height },
      insets: paneInsets(railInsetRef.current),
      context: unionBox(members) ?? anchor,
      anchor,
    });
    hidePeek();
    disableAutoFit();
    lastFocusRef.current = { id, at: Date.now() };
    moveCamera(want, FOCUS_MS);
  }, [moveCamera, disableAutoFit]);

  /** BRING A SELECTED CARD INTO VIEW, AND NO MORE (focus-camera.ts
   *  revealViewport): the zoom the reader chose is kept, unless the card's
   *  face cannot be read at it, and the camera slides the least distance that
   *  puts the card, with its note where the note is drawn, clear of the
   *  panels. Already in view, it does not move at all, and the auto-fit is
   *  left as it was: nothing took the view from it. A move takes the wheel,
   *  as a focus does, or the auto-fit would put the board back over the card
   *  the reader was just brought to. */
  const revealAgent = useCallback((id: string) => {
    const pane = canvasRef.current;
    if (!pane || !stateRef.current.agents.get(id)) return;
    const drawn = shownRef.current;
    const boxOf = (n: Node): FlowBox | null => {
      const m = measuredRef.current.get(n.id);
      return m ? { x: n.position.x, y: n.position.y, width: m.width, height: m.height } : null;
    };
    const own = drawn.find(n => n.id === id);
    const card = own ? boxOf(own) : null;
    if (!own || !card) return;
    // The session's note, while the full card draws it (no note is drawn
    // below it, context-modal.css).
    const session = sessionOfNode(own);
    const noteNode = lodRef.current === "detail"
      ? drawn.find(n => n.type === "recapNote" && sessionOfNode(n) === session) : undefined;
    const rect = boardRect(pane);
    const want = revealViewport({
      view: currentViewport(),
      pane: { width: rect.width, height: rect.height },
      insets: paneInsets(railInsetRef.current),
      card,
      note: noteNode ? boxOf(noteNode) : null,
      minZoom: FAR_ZOOM,
    });
    hidePeek();
    lastFocusRef.current = { id, at: Date.now(), reveal: true };
    if (!want) return;
    disableAutoFit();
    moveCamera(want, FOCUS_MS);
  }, [moveCamera, currentViewport, disableAutoFit]);

  // The reframe asks for the last jump again, made the way it was made.
  focusAgentRef.current = (id: string) => (lastFocusRef.current?.reveal ? revealAgent : focusAgent)(id);

  /** Step through visible agents in render order. `direction` is +1 for
   *  next (j) or -1 for previous (k). Selecting moves the canvas to keep
   *  the chosen agent in view, at the zoom it is at (revealAgent).
   *
   *  The order and the wrap-around live in canvas-keys.ts, where they can be
   *  tested without a canvas; what stays here is the two things that need one,
   *  the fit and the focus.
   *
   *  Returns whether it landed on a card: with none on the board there is
   *  nothing to step to, and D says so in the Inspector instead
   *  (pickSessionForInspector). */
  const stepAgent = useCallback((direction: 1 | -1): boolean => {
    // Cards only: a recap note is a node on the canvas, not a stop for j and k.
    const current = nodesRef.current.filter(n => n.type === "agent");
    const targetId = stepTarget(
      current.map(n => ({ id: n.id, x: n.position.x, y: n.position.y })),
      primarySelectedIdRef.current,
      direction,
    );
    const target = targetId ? current.find(n => n.id === targetId) : undefined;
    if (!target) return false;
    // Traversal takes the keyboard with it, but only when the keyboard was
    // already on a card. j from <body> is the shortcut it has always been —
    // it selects, and every other single-key shortcut stays live because
    // nothing is focused. j from a card is navigation, and leaving focus
    // behind on the card the user just stepped off would make the next Enter
    // re-select the one they left rather than the one they moved to.
    const follow = isCanvasNodeElement(document.activeElement);
    selectAgent(target.id, false);
    // Bring the chosen node on screen even if the user had panned away.
    window.setTimeout(() => {
      try { revealAgent(target.id); } catch {}
      if (follow) focusCanvasNode(target.id);
    }, 30);
    return true;
  }, [selectAgent, revealAgent]);

  /** Select a session's root and bring it on screen, at the zoom the reader is
   *  at: a selection pans, never zooms. Through revealAgent, which reads
   *  `shownRef` rather than the render-scope array so callers can be
   *  memoised: the array is rebuilt every render and would otherwise re-create
   *  every handler that closes over it. The frame of delay is for the same
   *  reason the session list has always needed one — the node has to be laid
   *  out before revealAgent has a box to frame. */
  const focusSession = useCallback((sessionId: string) => {
    selectAgent(sessionId, false);
    // N, W, a notification, ⌘K and a cluster's name all arrive here: the one
    // place the rail is told where you landed.
    onLand?.(sessionId);
    window.setTimeout(() => {
      try { revealAgent(sessionId); } catch {}
      // The card takes the Land once the camera has brought it into view.
      window.setTimeout(() => landOnCard(sessionId), landDelayMs(FOCUS_MS));
    }, 60);
  }, [selectAgent, revealAgent, onLand]);

  return { focusAgent, revealAgent, stepAgent, focusSession };
}
