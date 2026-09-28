// The frame the board is packed and fitted into.
//
// Lifted out of App.tsx: the fit's margin and fill, the measurement of how
// much of the canvas the floating machine and usage panels cover, the effect
// that keeps that measurement current (#997), and the frame the three of them
// add up to. The layout scores every arrangement by the zoom it gets in this
// frame and fitLeft frames the board in it, which is why the constants and the
// cover are exported: they are one rule used from two places, and it lives here.
import { useEffect, useState, type RefObject } from "react";

import type { PanelPhase } from "./panel-exit";
import { useMirroredRef } from "./use-mirrored-ref";

/** The margin and fill fitLeft frames the board with. The layout packs the
 *  board for the same frame, so the two cannot disagree about what fits. */
export const FIT_MARGIN = 80;
export const FIT_FILL = 0.86;

/** How much of the canvas's right edge the rail covers.
 *
 *  The machine and usage panels are `position: fixed` over the canvas rather
 *  than a grid column beside it, so the canvas's own width counts the strip
 *  under them as room. A board packed and fitted into that strip puts its
 *  right-hand column under the panels — the one thing spreading the board
 *  sideways must never do. Measured rather than derived from the panel flags,
 *  like the canvas itself, so it stays right whether one panel is open or both
 *  are, and wherever the detail panel has pushed the rail. A panel on its way
 *  out is already gone as far as the board is concerned. */
export function railCover(canvas: Element | null): number {
  if (!canvas) return 0;
  const box = canvas.getBoundingClientRect();
  let left = box.right;
  for (const el of document.querySelectorAll(".sysdetail:not(.leaving), .usage-panel:not(.leaving)")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.left > box.left) left = Math.min(left, r.left);
  }
  return Math.max(0, box.right - left);
}

export function useLayoutFrame({ canvasRef, canvasSize, machinePhase, usagePhase, usagePanelOpen, detailShown }: {
  canvasRef: RefObject<HTMLElement | null>;
  /** The canvas box, quantised to 40px — see use-canvas-size.ts. */
  canvasSize: { w: number; h: number };
  machinePhase: PanelPhase;
  usagePhase: PanelPhase;
  usagePanelOpen: boolean;
  /** Whether `.detail` is in the DOM, which moves the rail by 360px. */
  detailShown: boolean;
}) {
  // What the rail covers of the canvas — see railCover. Kept only when it moves
  // by more than the canvas's own 40px quantum.
  //
  // NAMED INPUTS RATHER THAN NO DEPENDENCY ARRAY (#997). This ran after EVERY
  // render, and `setNow` re-renders the deck four times a second on a completely
  // idle board, so an idle deck was spending a document-wide `querySelectorAll`
  // plus up to three `getBoundingClientRect` reads 240 times a minute to
  // re-derive a number that had not moved. The dep-less form was deliberate —
  // a panel opening changes the cover without resizing the canvas, which is why
  // `canvasSize` alone was not enough — so the fix is to name every input rather
  // than to drop the reading.
  //
  // The list is the complete set of things that can move `.sysdetail` or
  // `.usage-panel` relative to the canvas, and each one is in the sheet:
  //   · machinePhase / usagePhase — mount, and the `.leaving` class railCover
  //     filters on. The PHASES and not the open flags: `usePanelPresence` flips
  //     the flag one render before the panel is in the DOM, so a dep on the flag
  //     would measure the frame before the panel existed and never look again.
  //   · usagePanelOpen — `.sysdetail.shifted`, which moves the machine panel
  //     300px and is driven by the raw flag, a render ahead of usagePhase.
  //   · detailShown — `--rail-r`, 368px against 8px, for both panels.
  //   · canvasSize.w — the canvas box itself, which is what the cover is
  //     measured against. Already quantised to 40px, the same quantum as the
  //     deadband below, and it is the only way the accounts panel and a window
  //     resize reach this: both change the canvas column's width.
  const [railInset, setRailInset] = useState(0);
  useEffect(() => {
    const cover = railCover(canvasRef.current);
    setRailInset(prev => (Math.abs(prev - cover) > 40 ? cover : prev));
  }, [machinePhase, usagePhase, usagePanelOpen, detailShown, canvasSize.w]);
  // The same reading for the handlers that frame a card or place its peek:
  // they run on a press or a hover, and asking the document again there would
  // be a third query of what this effect has just measured.
  const railInsetRef = useMirroredRef(railInset);

  // The frame fitLeft will show the board in, in flow units at full size: the
  // canvas less the rail's strip, less the fit's margins and fill. The layout
  // scores every arrangement by the zoom it gets in this frame, so the board
  // spreads sideways as far as the visible canvas is wide, and no further.
  const availableWidth = canvasSize.w > 0
    ? Math.max(0, (canvasSize.w - railInset - FIT_MARGIN * 2) * FIT_FILL) : 0;
  const availableHeight = canvasSize.h > 0
    ? Math.max(0, (canvasSize.h - FIT_MARGIN * 2) * FIT_FILL) : 0;

  return { railInsetRef, availableWidth, availableHeight };
}
