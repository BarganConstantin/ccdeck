// What a click, a double-click and a hover on the canvas do: select the card
// (or its session, from a recap note) and bring it into view, clear the
// selection on the empty canvas, and open the peek where a card is too small
// to say it itself.
//
// Moved out of App.tsx's markup. The handlers are rebuilt every render, as the
// inline arrows on <ReactFlow> they replace were; the one thing they keep
// between renders is the camera jump a click holds under reduced motion.
import type React from "react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Node } from "reactflow";
import { hidePeek, showPeek } from "./components/SessionPeek";
import { createFocusHold } from "./focus-hold";
import { prefersReducedMotion } from "./viewport-motion";
import type { useSelection } from "./use-selection";
import type { useZoomLod } from "./use-zoom-lod";

export function useCanvasClicks({ clearSelection, selectAgent, detailOpen, setDetailOpen, detailShown, focusAgent, draggingRef, lodRef }: {
  clearSelection: () => void;
  selectAgent: ReturnType<typeof useSelection>["selectAgent"];
  /** The stored flag: whether the detail panel is meant to be open. */
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  /** Whether the detail panel is on screen now, which narrows the canvas. */
  detailShown: boolean;
  focusAgent: (id: string) => void;
  draggingRef: MutableRefObject<boolean>;
  lodRef: ReturnType<typeof useZoomLod>["lodRef"];
}) {
  // Under reduced motion a click's camera jump waits out the double-click —
  // see focus-hold.ts. Made once, lazily (a useRef argument is evaluated on
  // every render, #612), and reading the newest focusAgent when it fires.
  const focusRef = useRef(focusAgent);
  focusRef.current = focusAgent;
  const [focusHold] = useState(() => createFocusHold({
    focus: id => focusRef.current(id),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: handle => window.clearTimeout(handle),
  }));
  useEffect(() => () => focusHold.cancel(), [focusHold]);

  const onNodeClick = (e: React.MouseEvent, n: Node) => {
    if (n.type === "sessionGroup") { focusHold.cancel(); clearSelection(); return; }
    // A click on a card SELECTS it and GOES TO its session — the frame
    // focusAgent builds, the card and its session at a readable zoom —
    // and leaves the detail panel shut: that is the double-click's, one
    // press further in. Shift+click only widens the selection, as ever.
    // A recap note speaks for its session, so a click on it is a click
    // on the root.
    const id = n.type === "recapNote" ? (n.data as { parentId: string }).parentId : n.id;
    selectAgent(id, e.shiftKey, false);
    if (e.shiftKey) return;
    // AND SHUTS THE PANEL, whether or not it is showing. `detailOpen` is
    // persisted, so every deck that clicked a card under #814 has it
    // stored open — and after a reload nothing is selected, so nothing
    // is SHOWN, and a test of what is on screen let this very click
    // select the card and bring the stored panel up with it. The frame
    // waits a paint only when a panel was really there, for the canvas
    // it gives back, the way the double-click's does for the one it takes.
    if (detailOpen) setDetailOpen(false);
    // Under reduced motion the camera jumps rather than travels, and a jump
    // made now would put something else under a double-click's second press:
    // it is held until no double-click can follow (focus-hold.ts), which is
    // longer than the paint a closing panel needs. Otherwise, as ever.
    if (prefersReducedMotion()) {
      focusHold.hold(id);
    } else if (detailShown) {
      window.setTimeout(() => { try { focusAgent(id); } catch {} }, 80);
    } else {
      focusAgent(id);
    }
  };
  // A click on the empty canvas clears the selection a held jump was for.
  const onPaneClick = () => { focusHold.cancel(); hidePeek(); clearSelection(); };
  // The details, one press past the click that went to the session:
  // the panel opens on the card — the prompt, every tool call, tokens
  // and timing — and the frame is built again a paint later, for the
  // canvas the panel has just narrowed. React Flow's own double-click
  // zoom never reaches a card (its filter drops a dblclick inside a
  // draggable node), so nothing else answers here.
  const onNodeDoubleClick = (_: React.MouseEvent, n: Node) => {
    if (n.type !== "agent" && n.type !== "recapNote") return;
    // The jump its first press held back is this one's to make now.
    focusHold.cancel();
    const id = n.type === "recapNote" ? (n.data as { parentId: string }).parentId : n.id;
    selectAgent(id, false);
    window.setTimeout(() => { try { focusAgent(id); } catch {} }, 80);
  };
  // The peek (SessionPeek) is for the distances where the card cannot
  // say it itself. At the detail tier the card is readable and a copy
  // over it would be noise, so it never opens there.
  const onNodeMouseEnter = (e: React.MouseEvent, n: Node) => {
    if ((n.type !== "agent" && n.type !== "recapNote") || draggingRef.current) return;
    if (lodRef.current == null || lodRef.current === "detail") return;
    showPeek(n.id, e.currentTarget as Element);
  };
  const onNodeMouseLeave = (_: React.MouseEvent, n: Node) => hidePeek(n.id);

  return { onNodeClick, onPaneClick, onNodeDoubleClick, onNodeMouseEnter, onNodeMouseLeave };
}
