// Whether Usage and the machine panel stand in a column of their own beside the
// canvas, or float over it.
//
// DOCKED BESIDE THE RIGHT STRIPE (owner, 2026-10-23). The two right panels were
// the only ones that floated: the session list, Accounts and the detail panel
// each take a column, and Usage and the machine panel lay over the canvas and
// its minimap, so the same stripe press gave a column on one edge and a card
// over the board on the other. They stand in a column now, next to the stripe
// their buttons are on, the way Sessions and Accounts stand beside the left
// one, and the canvas narrows by them. Side by side when both are open, as
// #910 kept them: #847 had stacked the two in one column, and on 2026-09-14
// the owner chose the pair side by side over that. Shown that history on
// 2026-10-23, the owner chose this.
//
// A window that cannot keep the board DOCK_MIN_CANVAS of canvas beside every
// column that is open floats the two over the canvas as before, rather than
// pushing the page past the window's edge: styles/rail-dock.css draws both.
import { useLayoutEffect, useRef, useState } from "react";

/** The least canvas the board keeps beside the docked panels: the control
 *  stack, the minimap and a session's cards still fit in it. */
export const DOCK_MIN_CANVAS = 360;
/** A stripe's width, on each side of the window (tokens.css --edge-w). */
const EDGE_W = 40;
/** The detail panel's column (tokens.css). */
const DETAIL_W = 360;
/** Usage's and the machine panel's width before larger text widens them
 *  (usage-panel.css, machine-panel.css). */
const PANEL_W = 280;

/** Whether the docked column leaves the board its canvas. Every width is the
 *  one drawn: `leftW` is the left column's, 0 when it is shut, and `dockW` the
 *  panels' in the dock together. */
export function railDocks({ windowW, leftW, detailShown, dockW }: {
  windowW: number;
  leftW: number;
  detailShown: boolean;
  dockW: number;
}): boolean {
  return windowW - 2 * EDGE_W - leftW - (detailShown ? DETAIL_W : 0) - dockW >= DOCK_MIN_CANVAS;
}

/**
 * The dock's element and whether it docks. Measured from the panels in it, so
 * larger text, which widens them, is counted; the left column's width is its
 * target plus the same increase, which widens it too (LeftColumn.tsx).
 * Decided before the first paint and again on every resize. Never on a phone,
 * where nothing stands beside the canvas and both panels are sheets.
 */
export function useRailDock({ phone, leftW, detailShown, usage, machine }: {
  phone: boolean;
  /** The left column's target width, 0 when it is shut (use-left-column.ts). */
  leftW: number;
  detailShown: boolean;
  usage: boolean;
  machine: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  useLayoutEffect(() => {
    const dock = ref.current;
    if (!dock || phone) { setDocked(false); return; }
    const measure = () => {
      let dockW = 0;
      let grow = 0;
      for (const panel of Array.from(dock.children) as HTMLElement[]) {
        dockW += panel.offsetWidth;
        grow = Math.max(grow, panel.offsetWidth - PANEL_W);
      }
      setDocked(railDocks({ windowW: window.innerWidth, leftW: leftW > 0 ? leftW + grow : 0, detailShown, dockW }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [phone, leftW, detailShown, usage, machine]);
  return { ref, docked };
}
