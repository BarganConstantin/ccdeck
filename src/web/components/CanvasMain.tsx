// The canvas's own element: <main>, with the listeners that have to sit on the
// whole canvas rather than on any control inside it — the pointer focus it
// refuses (#434), the input stamps that tell the reader's move from the deck's
// (#578), and the keyboard's way into the peek — and the two overlays drawn
// over everything in it, the drag-to-remove zone and the peek itself.
//
// Moved out of App.tsx's markup unchanged. What is drawn on the canvas — the
// empty-board heroes, the category filter and React Flow — stays App.tsx's and
// comes in as children, so none of it is relayed through here.
import type { MutableRefObject, ReactNode } from "react";

import { isCanvasNodeElement } from "../canvas-node-element";
import { releasePointerFocus } from "../canvas-pointer-focus";
import { isMounted } from "../panel-exit";
import type { GraphState } from "../reducer";
import type { useCanvasViewport } from "../use-canvas-viewport";
import type { useDragTrash } from "../use-drag-trash";
import type { usePeekReaders } from "../use-peek-readers";
import type { useZoomLod } from "../use-zoom-lod";
import DragTrashZone from "./DragTrashZone";
import SessionPeek, { hidePeek, showPeek } from "./SessionPeek";

export default function CanvasMain({ canvasRef, bubbling, dragging, trash, zoom, viewport, stateRef, peek, children }: {
  canvasRef: MutableRefObject<HTMLElement | null>;
  /** A session's bubbles are animating out, which the sheet softens the canvas for. */
  bubbling: boolean;
  /** True for the length of any drag gesture. */
  dragging: boolean;
  trash: ReturnType<typeof useDragTrash>;
  /** The zoom's level of detail, which the peek and the stylesheet key off. */
  zoom: ReturnType<typeof useZoomLod>;
  viewport: ReturnType<typeof useCanvasViewport>;
  stateRef: MutableRefObject<GraphState>;
  /** What the peek reads — use-peek-readers.ts. */
  peek: ReturnType<typeof usePeekReaders>;
  children: ReactNode;
}) {
  const { trashDragging, trashState, trashPhase, trashZoneRef, trashLabel } = trash;
  const { lod, lodRef } = zoom;
  const { markCanvasInput } = viewport;
  const { peekAgent, peekLabel, peekRecap, peekBounds } = peek;
  return (
    /* <main>, because the canvas is what this page is: everything else on
       screen — the toolbar above it, the panels beside it — exists to
       describe or steer what is drawn here. One per document, and this is
       the one.
       tabIndex={-1} makes it a focus target for App.tsx's skip link without
       adding a tab stop of its own. Focus landing here is also harmless to
       the keyboard rules #367 settled: MAIN is not in shortcuts.ts's
       KEY_OWNING_TAGS and carries no interactive role, so ownsKeystroke()
       returns false and the deck's single-key shortcuts keep working from
       it, and Escape releases it back to the document like any other
       non-typing target.
       What tabIndex={-1} must NOT do is make the canvas a thing the mouse
       focuses, which it also is by default and which lit the skip link's
       ring for every click on empty canvas one keystroke later (#434).
       releasePointerFocus (canvas-pointer-focus.ts) is where that half is
       taken back, and it has to be the capture phase: React Flow stops the
       pane's mousedown dead before it can bubble this far. */
    <main
      id="canvas"
      tabIndex={-1}
      className={`canvas-wrap${bubbling ? " bubbling" : ""}${dragging ? " dragging-any" : ""}${trashDragging && trashState === "over" ? " trash-hover" : ""}`}
      data-lod={lod}
      ref={canvasRef}
      onMouseDownCapture={releasePointerFocus}
      /* The three that say a human is working this canvas right now. They
         are here, on the canvas as a whole, rather than on the two controls
         that need them, because a handler per control is a list that has to
         be kept complete and #578 is what an incomplete one costs: React
         Flow's own zoom buttons and minimap moved the viewport and nothing
         here noticed. Everything that moves the viewport on a user's
         behalf lives inside this element — the pane, the Controls
         stack, the minimap — so one listener at the top of it covers the
         controls the deck mounts today and the ones it mounts next.
         Capture, for the reason releasePointerFocus is: React Flow
         calls stopImmediatePropagation() on the pane's press, so a bubbling
         handler here would never see the gesture that matters most.
         Press AND release, because a Controls button only calls zoomIn() on
         the click, which is the release — hold + for two seconds and a
         press-only stamp would have gone stale by the time the zoom lands.
         Not pointermove: see CANVAS_INPUT_WINDOW_MS. */
      onPointerDownCapture={markCanvasInput}
      onPointerUpCapture={markCanvasInput}
      onWheelCapture={markCanvasInput}
      /* The peek is not hover-only. A card the keyboard reaches at a distance
         opens the same card the pointer would — Tab, j/k and W all land focus
         on a card — and closes when focus moves on. Only a focus the browser
         would ring (`:focus-visible`): a click also focuses the card, and a
         peek that opened under every click would cover what was clicked. */
      onFocusCapture={e => {
        const el = e.target as Element;
        if (!isCanvasNodeElement(el) || lodRef.current == null || lodRef.current === "detail") return;
        const id = el.getAttribute("data-id");
        if (id && stateRef.current.agents.has(id) && el.matches(":focus-visible")) showPeek(id, el, "focus");
      }}
      onBlurCapture={e => {
        const id = (e.target as Element).getAttribute?.("data-id");
        if (id) hidePeek(id);
      }}
    >
      {children}
      {isMounted(trashPhase) && (
        <DragTrashZone trashZoneRef={trashZoneRef} trashState={trashState} trashPhase={trashPhase} trashLabel={trashLabel} />
      )}
      <SessionPeek
        agentFor={peekAgent}
        recapFor={peekRecap}
        labelFor={peekLabel}
        bounds={peekBounds}
      />
    </main>
  );
}
