// What the peek reads, through refs so the three are made once: the node's
// own data (branch summary included), a parent's label, and the room it may
// open into — the canvas less the rail of panels over its right edge.
//
// Moved out of App.tsx unchanged. SessionPeek asks these when a card or a
// recap note is hovered; they read the board at that moment rather than the
// render that made them, which is what lets them be made once.
import { useCallback, type MutableRefObject } from "react";
import type { Node } from "reactflow";
import type { FlowNodeData } from "./canvas-flow";
import type { RecapNoteData } from "./components/RecapNoteNode";
import type { GraphState } from "./reducer";

export function usePeekReaders({ nodesRef, stateRef, canvasRef, railInsetRef }: {
  /** The array React Flow was last handed. */
  nodesRef: MutableRefObject<Node[]>;
  stateRef: MutableRefObject<GraphState>;
  canvasRef: MutableRefObject<HTMLElement | null>;
  /** How far the rail of floating panels covers the canvas's right edge. */
  railInsetRef: MutableRefObject<number>;
}) {
  const peekAgent = useCallback((id: string) => {
    const n = nodesRef.current.find(x => x.id === id && x.type === "agent");
    return n ? (n.data as FlowNodeData) : undefined;
  }, []);
  const peekLabel = useCallback((id: string) => stateRef.current.agents.get(id)?.label, []);
  const peekRecap = useCallback((id: string) => {
    const n = nodesRef.current.find(x => x.id === id && x.type === "recapNote");
    if (!n) return undefined;
    const d = n.data as unknown as RecapNoteData;
    return { recap: d.recap, hue: d.hue, sessionLabel: stateRef.current.agents.get(d.parentId)?.label };
  }, []);
  const peekBounds = useCallback(() => {
    // The canvas's own box, not the window's: the peek belongs over the canvas,
    // and the canvas already runs to the foot of the page.
    const box = canvasRef.current?.getBoundingClientRect();
    const doc = document.documentElement;
    return box
      ? { width: box.right - railInsetRef.current, height: box.bottom }
      : { width: doc.clientWidth, height: doc.clientHeight };
  }, []);
  return { peekAgent, peekLabel, peekRecap, peekBounds };
}
