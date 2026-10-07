// The canvas beside the open git view.
//
// The panel stands over the right of the canvas rather than squeezing its
// column, so the board keeps its arrangement and the camera its one transform:
// what changes is where the camera frames. Beside the view it frames the
// selected agent's session plus every agent that is waiting on the reader or
// has failed — the deck's sharpest job does not pause for a diff — as long as
// every card keeps its full face. When they cannot all fit at that size the
// session wins, and a marker on the canvas edge names each agent left out
// (amber for waiting, the error colour for failed), one click from it.
//
// Cards the panel covers wholly leave the Tab order, and while the view is
// open every fit the deck runs on its own — the auto-fit, F — frames for the
// view instead of for the whole board, through the seam at the bottom.
import { focusViewport, unionBox, type FlowBox, type PaneInsets } from "./focus-camera";
import { DETAIL_ENTER_ZOOM, FOCUS_MAX_ZOOM, fitZoomForDrawnLanes } from "./semantic-zoom";
import { LABEL_LIFT } from "./session-chrome";

export interface FitCard extends FlowBox {
  id: string;
}

/** A card of the session, with the room its tool lane takes beside it when
 *  the lane is drawn (0 for a card with no tools). */
export interface SessionCard extends FlowBox {
  lane: number;
}

/** Why an agent outside the session is kept in view. */
export type Alarm = "waiting" | "failed";

export interface GitViewFramePlan {
  viewport: { x: number; y: number; zoom: number };
  /** The alarming agents the frame could not take without shrinking a card's face. */
  leftOut: string[];
}

/** The canvas's own furniture the frame keeps clear of, before the panel. */
export const GIT_FIT_INSETS: Readonly<PaneInsets> = { top: 56, left: 72, bottom: 32, right: 32 };
/** Room above a session's cards for its cluster's frame and name tag, in flow
 *  units, so the tag is framed with the cards it names. */
export const CLUSTER_LABEL_ROOM = 44;
/** How far out the frame may zoom to keep the whole session in view. */
export const GIT_FIT_MIN_ZOOM = 0.2;
const FILL = 0.9;

/**
 * Where the camera goes beside the open view.
 *
 * `pane` is the whole canvas, `cover` how much of its right edge the panel
 * takes. The whole session is framed, zooming out as far as that needs — its
 * tool lanes counted only at a zoom where they are drawn, the rule the board's
 * own fit follows (semantic-zoom.ts) — and the alarming agents join it when
 * the frame that takes them all still draws every card's full face. Otherwise
 * the session wins and the alarms are named as left out. `anchor`, the
 * selected card, is always kept whole and inside the frame.
 */
export function gitViewFrame({ pane, cover, top = 0, session, alarms, anchor }: {
  pane: { width: number; height: number };
  cover: number;
  /** Where the canvas's own chrome along the top (the category filter bar)
   *  ends, in px from the canvas top; the frame starts below it. */
  top?: number;
  session: SessionCard[];
  alarms: FitCard[];
  anchor: FlowBox;
}): GitViewFramePlan {
  const insets: PaneInsets = { ...GIT_FIT_INSETS, top: Math.max(GIT_FIT_INSETS.top, top + 8), right: cover + GIT_FIT_INSETS.right };
  const labelled = <T extends FlowBox>(b: T): T => ({ ...b, y: b.y - CLUSTER_LABEL_ROOM, height: b.height + CLUSTER_LABEL_ROOM });
  session = session.map(labelled);
  alarms = alarms.map(labelled);
  const width = Math.max(1, pane.width - insets.left - insets.right);
  const height = Math.max(1, pane.height - insets.top - insets.bottom);
  const fitsAt = (box: FlowBox) => Math.min(width / Math.max(1, box.width), height / Math.max(1, box.height)) * FILL;
  const withLanes = unionBox(session.map(c => ({ x: c.x, y: c.y, width: c.width + c.lane, height: c.height }))) ?? anchor;
  const bare = unionBox(session) ?? anchor;
  const laned = fitsAt(withLanes);
  const sessionZoom = fitZoomForDrawnLanes(laned, fitsAt(bare));
  // The lanes are framed whenever the zoom was chosen with them in it: at
  // that zoom they may still be drawn (the board's detail face keeps them a
  // little below where it enters).
  const sessionBox = sessionZoom <= laned + 1e-6 ? withLanes : bare;
  const together = alarms.length ? unionBox([sessionBox, ...alarms]) : null;
  const legible = together != null && fitsAt(together) >= DETAIL_ENTER_ZOOM;
  const context = legible ? together! : sessionBox;
  const zoom = Math.max(GIT_FIT_MIN_ZOOM, Math.min(FOCUS_MAX_ZOOM, legible ? fitsAt(together!) : sessionZoom));
  const viewport = focusViewport({ pane, insets, context, anchor, minZoom: zoom, maxZoom: zoom });
  return { viewport, leftOut: legible ? [] : alarms.map(a => a.id) };
}

/** Where edge markers may sit, in px from the canvas top: below the canvas's
 *  own controls, and clear of its foot. */
const MARKER_FLOOR = 72;
const MARKER_FOOT = 40;

/** The vertical place of an edge marker, in px from the canvas top: level with
 *  its card where the card is above or below the frame, kept inside the pane. */
export function markerTop(card: FlowBox, viewport: { y: number; zoom: number }, paneHeight: number): number {
  const mid = viewport.y + (card.y + card.height / 2) * viewport.zoom;
  return Math.round(Math.min(Math.max(mid - 12, MARKER_FLOOR), paneHeight - MARKER_FOOT));
}

/** A box on the canvas, in px from its top left. */
export interface PaneBox { left: number; right: number; top: number; bottom: number }

/** Whether two boxes share any area: a tag that reaches a pixel under the
 *  canvas's own chrome is under it. */
export function boxesOverlap(a: PaneBox, b: PaneBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** An edge marker's height (`.gv-edge-mark`). */
export const MARKER_H = 24;

/**
 * Where a session cluster's name tag stands once the camera has moved, in px
 * from the canvas top, given where it stands now: on the plane at its box's
 * top, lifted a fixed LABEL_LIFT above it at every zoom (cluster-bounds.ts).
 */
export function labelTopAt(shownTop: number, was: { y: number; zoom: number }, now: { y: number; zoom: number }): number {
  const planeY = (shownTop - was.y + LABEL_LIFT) / was.zoom;
  return now.y + planeY * now.zoom - LABEL_LIFT;
}

/**
 * Edge markers kept off the cluster name tags beside them. `marks` are each
 * marker's place (its top) and the span its own width takes; one that would
 * cover a tag in that span moves to just under it, or above it when under
 * would pass the pane's foot, always a row below the marker before it. Where
 * neither way is free it stays where it was.
 */
export function clearOfLabels(marks: ReadonlyArray<{ top: number; left: number; right: number }>, labels: readonly PaneBox[], paneHeight: number, row = 30, gap = 4): number[] {
  const out = marks.map(m => m.top);
  const order = marks.map((_, i) => i).sort((a, b) => marks[a].top - marks[b].top);
  const foot = paneHeight - MARKER_FOOT;
  let floor = -Infinity;
  for (const i of order) {
    const m = marks[i];
    const on = (y: number) => labels.find(l => l.left < m.right && m.left < l.right && l.top < y + MARKER_H + gap && y - gap < l.bottom);
    const start = Math.max(m.top, floor + row);
    let y = start;
    for (let hit = on(y); hit && y <= foot; hit = on(y)) y = Math.ceil(hit.bottom + gap);
    if (y > foot) {
      y = start;
      for (let hit = on(y); hit && y >= MARKER_FLOOR; hit = on(y)) y = Math.floor(hit.top - gap - MARKER_H);
      if (y < MARKER_FLOOR || y < floor + row || on(y)) y = Math.min(start, foot);
    }
    out[i] = y;
    floor = y;
  }
  return out;
}

/** Markers that would land on top of one another move a row apart: down
 *  first, then back up from the pane's foot, so the markers of several cards
 *  below the frame stand one above another instead of on one spot. */
export function stackMarkers(tops: number[], paneHeight: number, row = 30): number[] {
  const order = tops.map((t, i) => [t, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(tops.length);
  let floor = -Infinity;
  for (const [t, i] of order) {
    out[i] = Math.max(t, floor + row);
    floor = out[i];
  }
  let ceiling = paneHeight - MARKER_FOOT;
  for (const [, i] of [...order].reverse()) {
    out[i] = Math.min(out[i], ceiling);
    ceiling = out[i] - row;
  }
  return out;
}

/** How many markers fit down the canvas's edge, a row apart. */
export function markerRoom(paneHeight: number, row = 30): number {
  return Math.max(1, Math.floor((paneHeight - MARKER_FOOT - MARKER_FLOOR) / row) + 1);
}

/** The markers that get a row of their own when there are more than fit: the
 *  waiting ones first, then the failed, each top to bottom; the rest fold into
 *  one last marker that counts them, so none goes unmentioned. */
export function foldMarkers<T extends { alarm: Alarm; top: number }>(markers: T[], room: number): { kept: T[]; folded: T[] } {
  if (markers.length <= room) return { kept: markers, folded: [] };
  const ranked = [...markers].sort((a, b) => (a.alarm === b.alarm ? a.top - b.top : a.alarm === "waiting" ? -1 : 1));
  const keep = new Set(ranked.slice(0, Math.max(0, room - 1)));
  return { kept: markers.filter(m => keep.has(m)), folded: ranked.slice(Math.max(0, room - 1)) };
}

/** Whether a card on screen lies wholly outside the part of the canvas the
 *  open view leaves the reader, `sight` (screen px): under the panel, whose
 *  left edge is `sight.right`, or past the canvas's left, top or bottom edge.
 *  A card that shows by a pixel is still in sight. */
export function outOfSight(card: PaneBox, sight: PaneBox): boolean {
  return card.left >= sight.right || card.right <= sight.left || card.top >= sight.bottom || card.bottom <= sight.top;
}

// ── the seam ──────────────────────────────────────────────────────────────
// While the view is open the camera's fit (use-camera.ts) frames for it, and a
// focus on one card (use-agent-focus.ts) keeps clear of the panel. Kept outside
// React like git-open.ts: the camera is made once and asks at call time. The
// session names on the canvas are drawn per render, so they subscribe to the
// cover instead (SessionClusters.tsx): a name under the panel is not drawn.

let reframe: ((durationMs: number) => void) | null = null;
let coverPx = 0;
const coverListeners = new Set<() => void>();

/** Installed by the open view; null when it closes. */
export function setGitViewFrame(fn: ((durationMs: number) => void) | null, cover = 0): void {
  reframe = fn;
  const next = fn ? cover : 0;
  if (next === coverPx) return;
  coverPx = next;
  for (const listener of [...coverListeners]) listener();
}

/** Be told when the cover changes: as the view opens, takes a new width, or
 *  closes. Answers the unsubscribe, for useSyncExternalStore. */
export function subscribeGitViewCover(listener: () => void): () => void {
  coverListeners.add(listener);
  return () => { coverListeners.delete(listener); };
}

/** The camera's fit, while the view is open: frames for the view and says so. */
export function frameForGitView(durationMs: number): boolean {
  if (!reframe) return false;
  reframe(durationMs);
  return true;
}

/** How much of the canvas's right edge the open view covers, 0 when closed. */
export function gitViewCover(): number {
  return coverPx;
}
