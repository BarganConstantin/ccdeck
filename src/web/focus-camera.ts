import { FAR_ZOOM, FOCUS_MAX_ZOOM, FOCUS_MIN_ZOOM } from "./semantic-zoom";

/** A box in flow (layout) units. */
export interface FlowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What of the pane is not canvas, in screen px from each edge: the rail of
 *  floating panels on the right, the control stack and the filter bar on the
 *  left and top. */
export interface PaneInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FocusRequest {
  pane: { width: number; height: number };
  insets: PaneInsets;
  /** What the reader should see: the card and the session it belongs to. */
  context: FlowBox;
  /** The card the focus is ON. Always kept whole and inside the frame. */
  anchor: FlowBox;
  minZoom?: number;
  maxZoom?: number;
  /** How much of the usable frame the context may fill. */
  fill?: number;
}

/**
 * WHERE THE CAMERA GOES WHEN THE READER ASKS FOR ONE SESSION: a double-click,
 * Z, a cluster's name. (A selection only brings its card into view:
 * revealViewport, below.)
 *
 * The deck used to answer every such request — the ribbon, a cluster's name, W,
 * j/k, the session list — with React Flow's `fitView` over one node, which
 * centres on the WHOLE pane and zooms to the canvas's 1.6 ceiling. Two faults
 * came with it. The centre of the pane is under the machine and usage panels
 * whenever they are open, which is where a focused card landed. And a single
 * 260px card at 1.6 is a card at 416px with the session it belongs to off
 * screen — the relationship the reader asked to see is exactly what the frame
 * cut away.
 *
 * So: the zoom that fits the whole session into the part of the pane nobody is
 * covering, held between the zoom the full card is drawn at and 1:1; the
 * session centred there; and then slid the least distance that puts the focused
 * card itself wholly inside the frame, for the session too big to fit whole.
 * For a root, which is the left end of its session, that slide lands the root
 * at the frame's left edge with as many of its subagents as fit to its right.
 */
export function focusViewport(req: FocusRequest): { x: number; y: number; zoom: number } {
  const minZoom = req.minZoom ?? FOCUS_MIN_ZOOM;
  const maxZoom = req.maxZoom ?? FOCUS_MAX_ZOOM;
  const fill = req.fill ?? 0.9;
  const left = req.insets.left;
  const top = req.insets.top;
  const width = Math.max(1, req.pane.width - req.insets.left - req.insets.right);
  const height = Math.max(1, req.pane.height - req.insets.top - req.insets.bottom);
  const c = req.context, a = req.anchor;
  const fitZoom = Math.min(width / Math.max(1, c.width), height / Math.max(1, c.height)) * fill;
  const zoom = Math.max(minZoom, Math.min(maxZoom, fitZoom));
  const axis = (start: number, room: number, cStart: number, cSize: number, aStart: number, aSize: number) => {
    // The context's first edge on screen, centred in the room.
    let at = start + (room - cSize * zoom) / 2 - cStart * zoom;
    // Keep the anchor inside: its screen span is [aStart*zoom + at, …].
    const aFrom = aStart * zoom + at, aTo = (aStart + aSize) * zoom + at;
    if (aSize * zoom <= room) {
      if (aFrom < start) at += start - aFrom;
      else if (aTo > start + room) at -= aTo - (start + room);
    } else {
      // A card wider than the frame: its start edge is what reads first.
      at += start - aFrom;
    }
    return at;
  };
  return {
    x: axis(left, width, c.x, c.width, a.x, a.width),
    y: axis(top, height, c.y, c.height, a.y, a.height),
    zoom,
  };
}

export interface RevealRequest {
  /** Where the camera is now. */
  view: { x: number; y: number; zoom: number };
  pane: { width: number; height: number };
  insets: PaneInsets;
  /** The selected card, where the board draws it now (packed or not). */
  card: FlowBox;
  /** Its session's note, where the board draws it now, or null when the note
   *  is not drawn: it is drawn only at the full card. */
  note?: FlowBox | null;
  /** The least zoom a card's face is read at: below it the camera comes up to
   *  exactly this, never further. */
  minZoom?: number;
}

/** Under half a pixel is rounding, not a card out of view. */
const REVEAL_SLACK = 0.5;

/**
 * WHERE THE CAMERA GOES WHEN THE READER SELECTS A CARD: as near nowhere as it
 * can.
 *
 * A selection used to be a focus (focusViewport): a click on a card zoomed to
 * 80% or more and centred its session, so a reader looking at the whole board
 * lost it on every click, and on a session wider than the free canvas the
 * card's note was cut on the left and its bubbles ran under the panels on the
 * right. Canvas tools do not do that — Figma and tldraw select in place, and
 * zooming to a selection is a gesture of its own — and neither does the deck
 * now: double-click and Z still frame the session (focusViewport); a
 * selection pans, never zooms.
 *
 * So: the zoom is kept, unless the card's face cannot be read at it, and then
 * it comes up to exactly the least zoom it reads at (`minZoom`, FAR_ZOOM),
 * about the card's own centre so the card grows where it stands. Then the
 * camera slides the least distance that puts the card, with its note when
 * the note is drawn and the two fit together, inside the part of the pane
 * nobody covers. If the pair does not fit, the card wins and the note may be
 * cut; a card larger than the frame shows its start edge. And when the card
 * (and the note) are already inside: null, the camera does not move at all.
 */
export function revealViewport(req: RevealRequest): { x: number; y: number; zoom: number } | null {
  const { view, card } = req;
  const minZoom = req.minZoom ?? FAR_ZOOM;
  const raised = view.zoom < minZoom;
  const zoom = raised ? minZoom : view.zoom;
  // Raised about the card's centre: its centre stays where it is on screen.
  let x = view.x, y = view.y;
  if (raised) {
    const cx = card.x + card.width / 2, cy = card.y + card.height / 2;
    x = cx * view.zoom + view.x - cx * zoom;
    y = cy * view.zoom + view.y - cy * zoom;
  }
  // The note is drawn only at the full card, and a raised zoom stops at the
  // face's threshold, below it: there the note is not drawn, so not framed.
  const note = raised ? null : req.note ?? null;
  const left = req.insets.left, top = req.insets.top;
  const right = req.pane.width - req.insets.right, bottom = req.pane.height - req.insets.bottom;
  const pair = note ? unionBox([card, note])! : card;
  const fits = (b: FlowBox) => b.width * zoom <= right - left && b.height * zoom <= bottom - top;
  const target = fits(pair) ? pair : card;
  // The least slide along one axis that puts [from, to] inside [lo, hi].
  const slide = (from: number, to: number, lo: number, hi: number) => {
    if (to - from > hi - lo) return lo - from; // larger than the room: its start edge
    if (from < lo - REVEAL_SLACK) return lo - from;
    if (to > hi + REVEAL_SLACK) return hi - to;
    return 0;
  };
  const dx = slide(target.x * zoom + x, (target.x + target.width) * zoom + x, left, right);
  const dy = slide(target.y * zoom + y, (target.y + target.height) * zoom + y, top, bottom);
  if (!raised && dx === 0 && dy === 0) return null;
  return { x: x + dx, y: y + dy, zoom };
}

/** The union of `boxes`, or null for none. */
export function unionBox(boxes: Iterable<FlowBox>): FlowBox | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
