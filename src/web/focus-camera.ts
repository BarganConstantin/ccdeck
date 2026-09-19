import { FOCUS_MAX_ZOOM, FOCUS_MIN_ZOOM } from "./semantic-zoom";

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
 * WHERE THE CAMERA GOES WHEN THE READER ASKS FOR ONE SESSION.
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
