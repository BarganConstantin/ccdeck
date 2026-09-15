// The persisted viewport, and the check it has to pass before the canvas is
// handed it. Kept out of App.tsx — the way stored-layout.ts is — so the check
// can be tested without React, React Flow or a DOM.
//
// Reading the key is still App.tsx's job: it owns the storage key and the
// debounced write. What lives here is the half that decides whether what came
// back is a viewport this canvas could have been left at.

/** How far out, and how far in, this canvas lets anyone zoom. The one
 *  <ReactFlow> in App.tsx takes its `minZoom` and `maxZoom` from here, so the
 *  check below and the bound it checks against are one number each rather
 *  than two that happen to agree. */
export const CANVAS_MIN_ZOOM = 0.2;
export const CANVAS_MAX_ZOOM = 1.6;

export interface StoredViewport { x: number; y: number; zoom: number }

/**
 * The stored viewport, or null when there is nothing usable to restore — in
 * which case the opening `fitView` frames the board, because App.tsx turns that
 * fit off only when a viewport came back (#1006).
 *
 * The check this replaces asked `typeof … === "number"` of each field and
 * nothing more. That admits a zoom of 0 or -3, which JSON carries without
 * complaint, and Infinity, which it carries too: `JSON.parse('{"zoom":1e400}')`
 * overflows to it. (NaN is the one it cannot — JSON.stringify writes it as
 * null, and null already failed.) A zero zoom is the expensive one. The opening
 * fit has been turned off because a viewport was restored; the restore effect
 * hands the zero to applyViewport, whose d3 path declines a non-positive zoom
 * and falls through to `rf.setViewport` with it regardless; and drift.ts's
 * watchdog, which exists to fetch back a board that has left the pane, stands
 * down for exactly this value because no fit can be computed from it. Every
 * load after that is a blank canvas beside a green connection dot, and the one
 * way out is clearing site data — the failure storage.ts names as the reason it
 * exists.
 *
 * So the value is refused at the door rather than survived downstream. The
 * bounds are the canvas's own: its gestures are clamped to them and fitLeft
 * clamps inside them, so a zoom outside them came from somewhere other than
 * this canvas, and the opening fit is the better guess. x and y are only
 * required to be finite. A viewport panned a long way off is still a viewport,
 * and bringing the board back from one is what drift.ts does, once the zoom is
 * one it can work with.
 */
export function parseStoredViewport(raw: string | null): StoredViewport | null {
  if (!raw) return null;
  let vp: unknown;
  try { vp = JSON.parse(raw); } catch { return null; }
  if (!vp || typeof vp !== "object") return null;
  const { x, y, zoom } = vp as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || typeof zoom !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  if (zoom < CANVAS_MIN_ZOOM || zoom > CANVAS_MAX_ZOOM) return null;
  return { x, y, zoom };
}
