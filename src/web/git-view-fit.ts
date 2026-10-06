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

/** Whether a card on screen sits wholly under the panel, whose left edge is
 *  at `coverLeft` (screen px). */
export function whollyCovered(card: { left: number; right: number }, coverLeft: number): boolean {
  return card.left >= coverLeft;
}

// ── the seam ──────────────────────────────────────────────────────────────
// While the view is open the camera's fit (use-camera.ts) frames for it, and a
// focus on one card (use-agent-focus.ts) keeps clear of the panel. Kept outside
// React like git-open.ts: the camera is made once and asks at call time.

let reframe: ((durationMs: number) => void) | null = null;
let coverPx = 0;

/** Installed by the open view; null when it closes. */
export function setGitViewFrame(fn: ((durationMs: number) => void) | null, cover = 0): void {
  reframe = fn;
  coverPx = fn ? cover : 0;
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
