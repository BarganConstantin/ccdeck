// Where a session's name may be drawn on the pane, and where it may not.
//
// The pill over a session's box lives in the cluster layer and moves with the
// camera, so a pan or a zoom-out could carry it anywhere — above the canvas's
// top edge, where the top bar cut it through its text, or under the category
// filter bar floating over the canvas. Either way it kept its Tab stop, so the
// keyboard's focus ring landed on a pill whose ring and half its words were
// behind the chrome.
//
// So a pill is drawn whole inside the pane and clear of the chrome over it, or
// not drawn at all. It never moves to stay in view: pinned to the pane's top,
// the way a design canvas pins a frame's title, it would ride down over its own
// session's cards, which paint above this layer, and it has no plate to be read
// over them by — it is a caption on the quietest object in the cluster, not a
// slab. Horizontally it can give up width instead, and does: its right end
// stops at the pane's edge and at chrome to its right on its row, and the
// sheet's ellipsis says where it was cut. Its title holds the whole text.
//
// Worked out per frame from the camera, the pane's size and the chrome measured
// over the pane, all in screen px relative to the pane — the unit the pill is
// drawn in, since the layer's scale is divided back out of it (#846).
import { labelMaxWidth, LABEL_INDENT, type Cluster } from "./cluster-bounds";
import { LABEL_LIFT } from "./session-chrome";

/** A box in screen px, relative to the pane's top-left corner. */
export interface PaneBox { left: number; top: number; right: number; bottom: number }

/** What the pill is allowed: how wide it may draw, and whether it is drawn. */
export interface LabelRoom { maxWidth: number; hidden: boolean }

/**
 * The pill's height on screen at its tallest. 10px text at line-height 1,
 * 3px of padding and a 1px border on each side is 18px; the waiting triangle
 * is 10px tall and sits 1px low, which opens the line box to 20.
 */
export const LABEL_H = 20;

/**
 * How far inside the pane, and off any chrome, the pill's box has to stay:
 * the focus ring is a 2px outline 1px off a button, so 3px past the box, and
 * one pixel of air. A pill closer than this would take focus with its ring cut.
 */
export const LABEL_EDGE = 4;

/**
 * The narrowest the pill is drawn. Under this an edge has left room for fewer
 * than six characters of a workspace name beside its padding (fewer than three
 * beside the waiting triangle), which names nothing; the pill waits until the
 * pan brings it back instead.
 */
export const LABEL_MIN_W = 64;

/**
 * The furniture drawn over the pane, which a pill keeps clear of: the
 * category filter bar, React Flow's panels (the control stack and the
 * minimap), the auto-fit chip and Re-arrange's Undo above it, and the panels
 * that float over the canvas —
 * usage, machine, and the detail panel where a narrow window floats it. A
 * selector that matches beside the pane rather than over it measures to
 * nothing and drops out. The open git view counts too, by the width it covers
 * rather than by a measure (withGitViewCover).
 */
export const PANE_CHROME = ".cat-filter-bar, .react-flow__panel, .autofit-chip, .rearrange-undo, .usage-panel, .sysdetail, .detail";

/**
 * How wide `c`'s pill may draw at this camera, and whether it is drawn at all.
 *
 * `view` is React Flow's viewport, `pane` its measured size (0×0 until the
 * first measure, when every pill is drawn as it always was rather than none),
 * `chrome` what paneChrome measured over it.
 */
export function labelRoom(
  c: Cluster,
  view: { x: number; y: number; zoom: number },
  pane: { width: number; height: number },
  chrome: readonly PaneBox[],
): LabelRoom {
  const zoom = view.zoom || 1;
  const cap = labelMaxWidth(c.w, zoom);
  if (pane.width <= 0 || pane.height <= 0) return { maxWidth: cap, hidden: false };
  // Where clusterLabelStyle puts the pill, brought through the camera.
  const left = (c.x + LABEL_INDENT) * zoom + view.x;
  const top = c.y * zoom + view.y - LABEL_LIFT;
  const bottom = top + LABEL_H;
  let room = Math.min(cap, pane.width - LABEL_EDGE - left);
  let hidden = left < LABEL_EDGE || top < LABEL_EDGE || bottom > pane.height - LABEL_EDGE;
  for (const b of chrome) {
    if (b.top - LABEL_EDGE >= bottom || b.bottom + LABEL_EDGE <= top) continue; // not on this row
    if (b.right + LABEL_EDGE <= left) continue; // wholly behind where it starts
    if (b.left - LABEL_EDGE <= left) { hidden = true; break; } // covers where it starts
    room = Math.min(room, b.left - LABEL_EDGE - left); // ahead of it on its row
  }
  if (room < LABEL_MIN_W) hidden = true;
  return { maxWidth: Math.max(0, room), hidden };
}

/**
 * Every PANE_CHROME element's box over `pane`, relative to it and clipped to
 * it, rounded to whole px; one beside the pane, or not laid out, is left out.
 */
export function paneChrome(pane: Element): PaneBox[] {
  const p = pane.getBoundingClientRect();
  const out: PaneBox[] = [];
  for (const el of pane.ownerDocument.querySelectorAll(PANE_CHROME)) {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, p.left) - p.left;
    const top = Math.max(r.top, p.top) - p.top;
    const right = Math.min(r.right, p.right) - p.left;
    const bottom = Math.min(r.bottom, p.bottom) - p.top;
    if (right - left < 1 || bottom - top < 1) continue;
    out.push({ left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) });
  }
  return out;
}

/**
 * `chrome` with the open git view's panel as one more piece of it: a band
 * `cover` px wide down the pane's right edge, the width the view settles at
 * (gitViewCover in git-view-fit.ts). The panel is mounted outside the pane and
 * slides in and out, so a box measured off it would be taken mid-slide, and
 * kept after it has gone; the width it covers once settled says where a name
 * is hidden by it. Nothing is added while the view is shut.
 */
export function withGitViewCover(chrome: PaneBox[], pane: { width: number; height: number }, cover: number): PaneBox[] {
  if (!(cover > 0) || pane.width <= 0 || pane.height <= 0) return chrome;
  return [...chrome, { left: Math.max(0, Math.round(pane.width - cover)), top: 0, right: Math.round(pane.width), bottom: Math.round(pane.height) }];
}

/** Whether two measures are the same boxes in the same order. */
export function sameBoxes(a: readonly PaneBox[], b: readonly PaneBox[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return x.left === y.left && x.top === y.top && x.right === y.right && x.bottom === y.bottom;
  });
}
