// The board's zoom as the whole percent the control bar prints between its
// zoom buttons. A string selector result, so React Flow's store re-renders the
// bar when the rounded figure changes and not on every frame of a pinch.
// components/CanvasControls.tsx reads it; nothing else does.

/** `0.8` is "80%", `1.0049` is "100%". Whole percents only: a figure that
 *  flickers through 100.4, 100.7 while a wheel settles is noise, and the
 *  reset button next to it lands on exactly 100. */
export function zoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
