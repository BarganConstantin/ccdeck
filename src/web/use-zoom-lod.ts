// Which face the cards wear at the current zoom: detail, compact or overview.
//
// Lifted out of App.tsx's `Inner`. The mode was kept twice — a ref for the
// handlers that ask it on every pointer event, state for the render — and
// written in one place, five lines inside the viewport handler in the JSX that
// stored both copies and the canvas attribute in the order that keeps them in
// step. Those five lines are `applyZoom` now, beside the state they write, and
// the handler says what it does with the answer: a canvas back at full detail
// closes the peek.
import { useCallback, useRef, useState, type MutableRefObject, type RefObject } from "react";

import type { GraphState } from "./reducer";
import { nextLod, referenceCard, type CardSize, type LodMode } from "./semantic-zoom";

export function useZoomLod({ stateRef, measuredRef, measuredVersionRef, canvasRef }: {
  stateRef: MutableRefObject<GraphState>;
  measuredRef: MutableRefObject<Map<string, CardSize>>;
  /** Moves whenever a measurement does, so the reference card is re-derived only then. */
  measuredVersionRef: MutableRefObject<number>;
  /** The canvas element whose `data-lod` the stylesheet reads. */
  canvasRef: RefObject<HTMLElement | null>;
}) {
  /** WHICH CARD IS DRAWN AT THIS DISTANCE — detail, compact or overview.
   *
   *  The canvas zooms to 0.2, and below the full card every word on it is drawn
   *  at the canvas's scale: at 0.3 the 12px name is under 4px. The two smaller
   *  modes are faces laid out in screen pixels instead (AgentNode's NodeFace);
   *  which one is drawn is decided in semantic-zoom.ts from what the smallest
   *  card measures on screen, with a band either side of each threshold so a
   *  zoom resting near one cannot flip the canvas back and forth.
   *
   *  It lives on the canvas element rather than in each node ON PURPOSE. A node
   *  that subscribed to the viewport would re-render every card on every frame
   *  of a pinch, on a surface that already runs a 200-iteration relaxation and
   *  four resting animations; this is one attribute on one element, written
   *  only when the mode actually changes, which is a handful of times per
   *  gesture at most.
   *
   *  Nothing here changes a card's BOX. The faces are drawn over the card's own
   *  rows, which keep their space, because the measured height of a node is a
   *  layout input — shrinking a card at a distance would reflow the graph under
   *  the reader's hands, and the auto-fit would chase it. */
  const [lod, setLod] = useState<LodMode>("detail");
  const lodRef = useRef<LodMode | null>(null);
  /** The card the mode has to work for: the smallest agent card on the board,
   *  re-measured only when a measurement moved (measuredVersionRef). */
  const lodCardRef = useRef<{ version: number; card: CardSize } | null>(null);
  const lodCard = useCallback((): CardSize => {
    const version = measuredVersionRef.current;
    if (lodCardRef.current?.version === version) return lodCardRef.current.card;
    const sizes: CardSize[] = [];
    for (const id of stateRef.current.agents.keys()) {
      const m = measuredRef.current.get(id);
      if (m) sizes.push(m);
    }
    const card = referenceCard(sizes);
    lodCardRef.current = { version, card };
    return card;
  }, []);

  /** The viewport is now at `zoom`. Returns the mode the canvas changed to, or
   *  null when the band it is in holds it where it was. */
  const applyZoom = useCallback((zoom: number): LodMode | null => {
    const mode = nextLod(lodRef.current, zoom, lodCard());
    if (mode === lodRef.current) return null;
    lodRef.current = mode;
    // The attribute now, the state for React with it: the face must
    // not wait a render to appear on the frame the mode changed on.
    canvasRef.current?.setAttribute("data-lod", mode);
    setLod(mode);
    return mode;
  }, [lodCard, canvasRef]);

  return { lod, lodRef, applyZoom };
}
