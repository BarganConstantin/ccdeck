// Zoom's fold and unfold, as the root's data-zoom says them (workspace.css).
//
// The list and the Inspector (and Usage and Machine with them) are overlays on
// a pane that already has the whole cell while Zoom is on or moving: they
// slide out on a fold and in on an unfold, over the same path, and the grid
// takes its tracks back only when the unfold is over. So the pane's box
// changes once, with nothing travelling over it, and the terminal refits once
// (its resize is settled, use-terminal-session.ts) instead of following a
// moving edge.
//
//   "fold"    Zoom is on: the grid is one track, the panels are overlays going
//             to (or at) their folded place.
//   "unfold"  Zoom was just turned off: still one track, the panels sliding
//             back over the pane.
//   undefined the grid as the view draws it.
//
// By a key it is at once: no unfold phase, the grid is back in the same
// render (input-modality.ts marks the root for any key).
import { useEffect, useState } from "react";
import { tokenMs } from "./rail-motion";
import { prefersReducedMotion } from "./viewport-motion";

export type ZoomPhase = "fold" | "unfold" | undefined;

/** The crossfade a reduced-motion reader gets in place of the slide
 *  (workspace.css, --zoom-xfade). */
export const ZOOM_REDUCED_MS = 140;

/** How long the unfold takes: Move, or the crossfade when motion is reduced. */
export function unfoldMs(): number {
  return prefersReducedMotion() ? ZOOM_REDUCED_MS : tokenMs("--dur-move");
}

function byKey(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "instant";
}

export function useZoomPhase(zoomed: boolean): ZoomPhase {
  const [was, setWas] = useState(zoomed);
  const [unfolding, setUnfolding] = useState(false);
  // Derived in the render that changes it, so no frame is drawn between the
  // press and the phase.
  if (was !== zoomed) {
    setWas(zoomed);
    setUnfolding(!zoomed && !byKey());
  }
  useEffect(() => {
    if (!unfolding) return;
    const t = window.setTimeout(() => setUnfolding(false), unfoldMs());
    return () => window.clearTimeout(t);
  }, [unfolding]);
  if (zoomed) return "fold";
  return unfolding && was === zoomed ? "unfold" : undefined;
}
