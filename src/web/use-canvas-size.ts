// How big the canvas is.
//
// Lifted out of App.tsx's `Inner`, where the observer sat two hundred and fifty
// lines below the ref it fills and the watchdog that reads that ref sat
// between them. One ResizeObserver on the canvas element keeps two readings:
// `canvasSize`, quantised to 40px so a nudge of the window cannot reflow the
// layout, and `paneSizeRef`, whole, because an intersection test must not
// inherit that tolerance (#615). Both are written here and nowhere else.
import { useEffect, useRef, useState } from "react";

import type { PaneSize } from "./drift";

export function useCanvasSize() {
  /** The pane the watchdog measures nodes against, in CSS pixels.
   *
   *  Written by the ResizeObserver below, which is the one thing in the deck
   *  that knows how big the canvas is. A ref rather
   *  than the `canvasSize` state beside it for two reasons: the drift watchdog
   *  in App.tsx is registered once and polls, so it wants a value it can read without
   *  being torn down and rebuilt on every resize; and `canvasSize` is
   *  deliberately quantised to 40px so a one-pixel resize cannot reflow the
   *  layout, which is exactly the rounding an intersection test must not
   *  inherit. Same observer, same element, same callback — this one keeps the
   *  reading whole.
   *
   *  Null until that observer first fires, and null for good on a browser
   *  without ResizeObserver. Both mean "the pane has not been measured", which
   *  shouldRefit treats as a reason not to decide. */
  const paneSizeRef = useRef<PaneSize | null>(null);
  // Width of the canvas column, not the window: the side panels come and go,
  // and a layout packed for the whole window would run under them. Measured
  // rather than derived from the panel flags so it stays right however the
  // grid is configured.
  // HTMLElement rather than HTMLDivElement: the canvas is a <main> now (#381),
  // and nothing here reads a property a <div> has and a <main> does not.
  const canvasRef = useRef<HTMLElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      // Unrounded, and updated on every callback: the drift watchdog compares
      // node boxes against this rectangle, and a 40px tolerance in an
      // intersection test is a 40px strip of the canvas that reads as
      // off-screen. It is also the reading that has to be current the instant a
      // side panel opens or closes, which is precisely when the pane changes
      // width by 240-360px and the watchdog is most likely to be wrong (#615).
      paneSizeRef.current = { width: r.width, height: r.height };
      // Quantised so a one-pixel resize doesn't reflow the canvas.
      setCanvasSize(prev =>
        (Math.abs(prev.w - r.width) > 40 || Math.abs(prev.h - r.height) > 40)
          ? { w: r.width, h: r.height } : prev);
    });
    ro.observe(el);
    paneSizeRef.current = { width: el.clientWidth, height: el.clientHeight };
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  return { canvasRef, canvasSize, paneSizeRef };
}
