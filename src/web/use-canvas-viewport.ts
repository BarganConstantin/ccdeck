// The canvas's viewport as the deck keeps it: restored from storage at boot,
// stored again on every move, and each move read for whether it was the user
// taking the wheel or the deck framing something itself.
//
// Moved out of App.tsx unchanged. The two move handlers are rebuilt every
// render, as the inline arrows on <ReactFlow> they replace were; the rule that
// tells a gesture from a fit is viewport-intent.ts's.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Viewport } from "reactflow";
import { hidePeek } from "./components/SessionPeek";
import { loadViewport, saveViewport } from "./layout-storage";
import type { useCamera } from "./use-camera";
import type { useZoomLod } from "./use-zoom-lod";
import { isUserViewportGesture } from "./viewport-intent";

type Camera = ReturnType<typeof useCamera>;

export function useCanvasViewport({ applyViewport, lastFitTimeRef, cameraEpochRef, disableAutoFit, markInteract, canvasRef, applyZoom }: {
  applyViewport: Camera["applyViewport"];
  lastFitTimeRef: Camera["lastFitTimeRef"];
  cameraEpochRef: Camera["cameraEpochRef"];
  /** The user took the wheel: auto-fit stands down (use-auto-fit-switch.ts). */
  disableAutoFit: () => void;
  /** When a pan, zoom or drag last touched the canvas, for the drift watchdog. */
  markInteract: () => void;
  canvasRef: MutableRefObject<HTMLElement | null>;
  applyZoom: ReturnType<typeof useZoomLod>["applyZoom"];
}) {
  const restoredViewport = useState(() => loadViewport())[0];

  // Apply restored viewport once ReactFlow's instance is ready. We skip
  // the initial fitView in that case (see <ReactFlow fitView={…}/> in App.tsx).
  useEffect(() => {
    if (!restoredViewport) return;
    const id = window.setTimeout(() => {
      // Through applyViewport, not `setViewport(…, { duration: 0 })`: this one
      // runs 60ms after boot, and a deck that opened its own tab while the user
      // was looking elsewhere is a hidden tab at exactly that moment.
      try { applyViewport(restoredViewport, 0); } catch {}
      // Stamped like every other viewport the deck asks for. This one never
      // needed it while onMoveStart was the only signal, because a programmatic
      // setViewport carries no source event and never reached it; onMove does
      // see it, and an unstamped restore would read as the user's first gesture
      // and switch auto-fit off before they had touched anything.
      lastFitTimeRef.current = Date.now();
    }, 60);
    return () => window.clearTimeout(id);
  }, [applyViewport, restoredViewport]);

  // Debounce timer for persisting the viewport on pan/zoom.
  const vpSaveTimerRef = useRef<number | null>(null);

  // When a press or a wheel last landed anywhere inside the canvas element,
  // which contains the pane, the Controls stack and the minimap alike.
  //
  // This is the half of "the user took the wheel" that React Flow cannot tell
  // us: a minimap pan and a Controls zoom move the viewport through the store,
  // so they reach onMove with no source event and are indistinguishable there
  // from a fit the deck asked for itself. They are distinguishable here — a
  // gesture starts with the user touching something, and no programmatic fit
  // does. See viewport-intent.ts for the rule that reads it.
  const lastCanvasInputRef = useRef(0);
  const markCanvasInput = useCallback(() => { lastCanvasInputRef.current = Date.now(); }, []);
  /** Every input the rule in viewport-intent.ts needs, read at the moment a
   *  viewport change arrives. */
  const viewportMove = useCallback((sourceEvent: unknown) => ({
    hasSourceEvent: !!sourceEvent,
    at: Date.now(),
    lastDeckFitAt: lastFitTimeRef.current,
    lastCanvasInputAt: lastCanvasInputRef.current,
  }), []);

  // A pan or a zoom starting, whoever started it.
  const onMoveStart = (e: MouseEvent | TouchEvent | null) => {
    // A pan or a zoom moves the tile out from under its peek.
    hidePeek();
    // And supersedes any fit still settling — see cameraEpochRef.
    if (isUserViewportGesture(viewportMove(e))) cameraEpochRef.current += 1;
    // The pane's own gesture, and only ever that: React Flow drops a
    // move with no source event before this callback is reached. Kept
    // alongside onMove because d3-zoom raises `start` on the press and
    // `zoom` only once the transform actually changes, so this is the
    // earlier of the two for a drag that begins on the canvas.
    if (isUserViewportGesture(viewportMove(e))) disableAutoFit();
  };
  // Every frame of a move, including the ones that come through the store.
  const onMove = (e: MouseEvent | TouchEvent | null, vp: Viewport) => {
    markInteract();
    // The signal that cannot lose a gesture. Unlike onMoveStart above,
    // this fires for a viewport moved through the store as well — the
    // minimap's pan and wheel, the Controls' + and −, and whatever the
    // library adds next — all of which arrive with no source event and
    // used to slip past the disable entirely (#578). Which of those is
    // the user and which is a fit the deck asked for is the one
    // question viewport-intent.ts answers.
    if (isUserViewportGesture(viewportMove(e))) disableAutoFit();
    // Debounce viewport persistence — pan/zoom fires many times
    // per gesture, but we only need the final state.
    // The zoom itself first, for the faces' screen-pixel layout and the
    // edges' stroke (styles.css, `data-lod`). Written on the element
    // rather than through state: it changes every frame of a gesture,
    // and the sheet is the only reader.
    canvasRef.current?.style.setProperty("--zoom", String(vp.zoom));
    if (applyZoom(vp.zoom) === "detail") hidePeek();
    if (vpSaveTimerRef.current) window.clearTimeout(vpSaveTimerRef.current);
    vpSaveTimerRef.current = window.setTimeout(() => saveViewport(vp), 250);
  };

  return { restoredViewport, markCanvasInput, onMoveStart, onMove };
}
