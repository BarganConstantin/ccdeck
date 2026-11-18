// Where the Claude FM character stands: on the control bar's left end, its
// feet on the bar's top edge (V4 critique, round 3, point 6). It stood on the
// minimap, which put it over the board's tool bubbles, and the minimap now
// comes and goes with the board (minimap-place.ts). The bar is always there
// while there is a session, at every zoom.
//
// The ledge is the bar's top from its left end, as long as the minimap's top
// edge was (the walks in claude-fm.ts were sized on it), and never past the
// part of the bar the minimap stands over when it takes the right corner. The
// sheet (claude-fm.css) does the rest from the bar's height, which is tokens;
// only the bar's width is measured, since it holds a different set of buttons
// on an empty board or without the Command Panel.
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { MINIMAP_BOX } from "./minimap-place";

/** Before paint in the browser; on the server, where the suite draws to
 *  markup, a plain effect, which does not run there. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The character's width: 18 columns at 3px (claude-fm.css .fm-sprite). */
export const FM_SPRITE_PX = 54;
/** The air the ledge keeps from the minimap over the bar's right end
 *  (react-flow.css --board-controls-gap). */
export const LEDGE_GAP = 8;
/** Where the canvas floor's walk ends on the left (claude-fm.css: the floor
 *  scene's `left`, react-flow.css --board-controls-edge). */
export const FLOOR_EDGE = 12;

/** The scene's box: its right edge from the canvas's right, and its width. */
export interface BarLedge { right: number; width: number }

/** The ledge on a bar at `bar`, in a canvas whose right edge is `canvasRight`,
 *  or null when the bar is too short to stand on. */
export function barLedge(canvasRight: number, bar: { left: number; width: number }): BarLedge | null {
  if (!(bar.width >= FM_SPRITE_PX)) return null;
  const width = Math.round(Math.max(FM_SPRITE_PX, Math.min(MINIMAP_BOX.width, bar.width - MINIMAP_BOX.width - LEDGE_GAP)));
  return { right: Math.round(canvasRight - bar.left - width), width };
}

const same = (a: BarLedge | null, b: BarLedge | null) => a === b || (!!a && !!b && a.right === b.right && a.width === b.width);

/**
 * The ledge for the scene in `scene`, measured before paint and again when the
 * canvas or the bar changes size, or the bar comes or goes (an empty board
 * draws only the Command Panel's button, or none). Null without a bar: the
 * sheet then stands the character in the corner, on the floor line.
 */
export function useBarLedge(scene: RefObject<HTMLElement | null>, live: boolean): BarLedge | null {
  const [ledge, setLedge] = useState<BarLedge | null>(null);
  useBeforePaint(() => {
    const host = live ? scene.current?.parentElement : null;
    if (!host) { setLedge(null); return; }
    let bar: Element | null = null;
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    const measure = () => {
      const now = host.querySelector(".react-flow__controls");
      if (now !== bar) {
        if (bar) sizes?.unobserve(bar);
        bar = now;
        if (bar) sizes?.observe(bar);
      }
      const next = now ? barLedge(host.getBoundingClientRect().right, now.getBoundingClientRect()) : null;
      setLedge(prev => (same(prev, next) ? prev : next));
    };
    const kids = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    sizes?.observe(host);
    kids?.observe(host, { childList: true });
    measure();
    return () => { sizes?.disconnect(); kids?.disconnect(); };
  }, [scene, live]);
  return ledge;
}
