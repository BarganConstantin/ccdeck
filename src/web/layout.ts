// Auto-layout helper using dagre. Pure: input nodes/edges -> positioned nodes.
//
// Each session is laid out as its own dagre subgraph, and the subgraphs are
// stacked into columns with a fixed gap — as many columns as let a fit show
// the board largest on the canvas it is drawn on. This guarantees the
// per-session cluster boxes drawn by <SessionClusters/> never overlap, no
// matter how many sessions are live at once.
import dagre from "dagre";
import type { Node, Edge } from "reactflow";
import {
  cardSize, columnGap, fitZoom, footprint, groupBySession, SESSION_GAP, TOOL_LANE_W, type Lanes,
} from "./layout-geometry";

// The shared measurements are layout-geometry.ts's. The lane map's type and
// its signature are part of what callers hand the passes, so the rest of the
// client reads them from here with the passes themselves.
export { laneSignature, type Lanes } from "./layout-geometry";
// And the passes canvas-flow runs after it, each in a file of its own and in
// the order they run: new cards joined to their sessions, whole arrivals
// dropped into gaps, overlapping cards slid apart, and the neighbours of a
// session that grew pushed aside.
export { joinSessions } from "./join-sessions";
export { fillGapsWithNewSessions } from "./fill-gaps";
export { separateOverlaps } from "./separate-overlaps";
export { bubblePush } from "./bubble-push";

export interface LayoutOptions {
  /**
   * Height of the frame a fit shows the board in, in flow units at full size.
   * Omitted or 0 keeps everything in one column.
   */
  availableHeight?: number;
  direction?: "LR" | "TB";
  /** Nodes the user has dragged — keep their position; don't re-layout. */
  pinned?: Map<string, { x: number; y: number }>;
  /** Real per-node sizes (measured by React Flow). Overrides defaults. */
  measured?: Map<string, { width: number; height: number }>;
  /**
   * Width of the same frame. Sessions are packed into however many columns
   * let the fit show them largest; omitted or 0 keeps the single column.
   */
  availableWidth?: number;
  /**
   * How many tool bubbles are drawn beside each agent right now.
   *
   * Bursts are an overlay rather than nodes, so dagre is blind to them; this is
   * how it learns that an agent occupies more than its card. Omitted means "no
   * bubbles anywhere", which is the right answer for a static layout.
   */
  lanes?: Lanes;
}

/**
 * Where a session's dragged members sit, in CANVAS coordinates.
 *
 * Deliberately kept apart from the session's own width/height, which are
 * measured from its own (0, 0) origin: the two are different frames and mixing
 * them makes a session claim its distance from the canvas origin as size.
 */
interface PinnedBox { minX: number; minY: number; maxX: number; maxY: number }

function layoutSession(
  ids: string[],
  edges: Edge[],
  direction: "LR" | "TB",
  measured: Map<string, { width: number; height: number }>,
  pinned: Map<string, { x: number; y: number }>,
  lanes?: Lanes,
): {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  pinnedBox: PinnedBox | null;
} {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    marginx: 0,
    marginy: 0,
    nodesep: 70,
    ranksep: 160,
    edgesep: 30,
  });
  // A dragged node is not part of the flow — it renders wherever the user
  // dropped it. Handing it to dagre anyway makes the session reserve an empty
  // slot at a position the node has already left, so the rest of the session
  // is laid out around a phantom and the real node lands on whatever is at
  // its saved coordinate. Lay out only what still flows.
  const free = ids.filter(id => !pinned.has(id));
  const idSet = new Set(free);
  for (const id of free) {
    // The box handed to dagre is the card PLUS the burst lane beside it.
    //
    // Bursts are an overlay, not React Flow nodes, so dagre cannot see them —
    // and ranksep (160) is far narrower than a lane (420). The next rank
    // therefore lands on top of this agent's tool bubbles, which is exactly
    // what a screenshot of five Chrome bubbles piled on each other showed.
    // Reserving the lane here moves the children clear of it instead.
    const { w, h } = footprint(id, measured, lanes);
    g.setNode(id, { width: w, height: h });
  }
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of free) {
    const p = g.node(id);
    if (!p) continue;
    const { w, h } = cardSize(id, measured);
    // dagre centred the card+lane box; the CARD sits at its left edge, so the
    // reserved space ends up where the bubbles actually are.
    const box = footprint(id, measured, lanes);
    const x = p.x - box.w / 2;
    const y = p.y - box.h / 2;
    positions.set(id, { x, y });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  // Normalise each session to its own (0, 0) origin so vertical stacking is
  // trivial.
  if (Number.isFinite(minX) && Number.isFinite(minY)) {
    for (const [id, p] of positions) positions.set(id, { x: p.x - minX, y: p.y - minY });
  }
  const width = Number.isFinite(maxX) ? maxX - minX : 0;
  const height = Number.isFinite(maxY) ? maxY - minY : 0;

  // The session's cluster box is drawn around every member, pinned ones
  // included, so the space it claims has to account for them too — otherwise
  // the next session is stacked under the flowing content and straight through
  // a node that was dragged below it.
  //
  // A pin's coordinate is the canvas one the user dropped it at, though, while
  // everything above is measured from the session's own origin. Folding p.x/p.y
  // into width/height compared the two frames: a card dragged to (1200, 800)
  // made its session report itself 1440 wide and 930 tall when its real block
  // is one card, which wraps the columns early and stacks the next session
  // below a band that holds nothing. The pinned box is reported separately and
  // reconciled by the packer, which is where the session's canvas origin is
  // finally known.
  let pinnedBox: PinnedBox | null = null;
  for (const id of ids) {
    const p = pinned.get(id);
    if (!p) continue;
    const { w, h } = cardSize(id, measured);
    pinnedBox = pinnedBox === null ? { minX: p.x, minY: p.y, maxX: p.x + w, maxY: p.y + h } : {
      minX: Math.min(pinnedBox.minX, p.x),
      minY: Math.min(pinnedBox.minY, p.y),
      maxX: Math.max(pinnedBox.maxX, p.x + w),
      maxY: Math.max(pinnedBox.maxY, p.y + h),
    };
  }
  return { positions, width, height, pinnedBox };
}

/** One session after dagre, waiting to be packed into a column. */
type LaidSession = ReturnType<typeof layoutSession> & { sid: string };
type Column = LaidSession[];

/**
 * Every session run through dagre on its own, plus the gap the packer leaves
 * between columns.
 *
 * Split out from autoLayout because this is the expensive half and the packing
 * below is the cheap one: `columnsWouldChange` scores the SAME sessions against
 * two frames, and doing that by calling autoLayout twice would run dagre twice
 * for an answer that does not depend on it.
 */
function laySessions(nodes: Node[], edges: Edge[], opts: LayoutOptions): { laid: LaidSession[]; gap: number } {
  const direction = opts.direction ?? "LR";
  const pinned = opts.pinned ?? new Map();
  const measured = opts.measured ?? new Map();
  const lanes = opts.lanes;

  const sessions = groupBySession(nodes);

  // Lay out each session in its own dagre graph, then pack the subgraphs into
  // columns. Sessions are ordered by id so the layout is stable across events.
  const sessionOrder = Array.from(sessions.keys()).sort();
  const laid = sessionOrder.map(sid => ({
    sid,
    ...layoutSession(sessions.get(sid)!.map(n => n.id), edges, direction, measured, pinned, lanes),
  }));

  return { laid, gap: columnGap(nodes, measured) };
}

/** A column is as wide as what landed in it: sizing every column to the widest
 *  session in the graph made one wide session set the pitch for all of them. */
const widthOf = (col: Column) =>
  col.reduce((w, s) => Math.max(w, s.width), 0) + TOOL_LANE_W;
const heightOf = (col: Column) =>
  col.reduce((h, s) => h + s.height, 0) + SESSION_GAP * Math.max(0, col.length - 1);

/**
 * The columns these sessions want in a frame of this shape.
 *
 * Sessions are cut into columns in id order, so they read down and then across,
 * and a session is never split across a boundary — each one is read as a block,
 * the thing the canvas exists to show.
 */
function packColumns(laid: LaidSession[], gap: number, frameW: number, frameH: number): Column[] {
  // Fill a column until the next session would take it past `limit`. Wrap only
  // when something is already in the column — a session taller than the limit
  // has to start somewhere, and a fresh column would leave the previous one
  // short and the next still over.
  const cut = (limit: number) => {
    const cols: Column[] = [[]];
    let cursorY = 0;
    for (const item of laid) {
      if (cursorY > 0 && cursorY + item.height > limit) {
        cols.push([]);
        cursorY = 0;
      }
      cols[cols.length - 1].push(item);
      cursorY += item.height + SESSION_GAP;
    }
    return cols;
  };

  // The same sessions in at most `k` columns, as even as their order allows:
  // the lowest limit that still needs no more than `k`. A column's height is
  // always the height of some run of consecutive sessions, so those runs are
  // the only limits worth trying.
  const limits: number[] = [];
  for (let i = 0; i < laid.length; i++) {
    let run = -SESSION_GAP;
    for (let j = i; j < laid.length; j++) limits.push(run += laid[j].height + SESSION_GAP);
  }
  limits.sort((a, b) => a - b);
  const balanced = (k: number) => {
    let lo = 0, hi = limits.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cut(limits[mid]).length <= k) hi = mid;
      else lo = mid + 1;
    }
    return cut(limits[lo]);
  };

  // Every column count is scored by the zoom the fit will show it at. A tie
  // goes to fewer columns, which is what stops a board already shown at full
  // size from splitting further — the worry the old cap of two answered by
  // refusing a third column however tall the other two had grown.
  let columns: Column[] = [laid];
  if (frameW > 0 && frameH > 0) {
    const zoomOf = (cols: Column[]) => fitZoom(
      cols.reduce((w, c) => w + widthOf(c), 0) + gap * (cols.length - 1),
      Math.max(...cols.map(heightOf)),
      frameW, frameH,
    );
    let best = zoomOf(columns);
    for (let k = 2; k <= laid.length; k++) {
      const cols = balanced(k);
      const zoom = zoomOf(cols);
      if (zoom > best + 1e-9) { best = zoom; columns = cols; }
    }
  }
  return columns;
}

/** The frame a fit shows the board in, in flow units at full size. */
export interface Frame { width: number; height: number }

/**
 * Would this board be cut into a different number of columns in `after` than it
 * was in `before`?
 *
 * The column count is a function of the frame and has been since the fit
 * scoring landed, but nothing recomputed it when the frame moved: the cache key
 * snapshotToFlow keeps is visible agent ids plus the two size versions, and a
 * rail panel opening or a window resize changes none of them. So a board packed
 * into one column for a 457px frame stayed one column in the 963px frame left
 * behind when the panels closed — a tall strip beside empty canvas until the
 * user pressed R (#995).
 *
 * Asked as "would the answer differ" rather than "has the frame moved" on
 * purpose. The frame moves on every 40px step of a window drag, and re-laying
 * out on each of those would throw away the arrangement `fillGapsWithNewSessions`
 * built up for a change that moves nothing. The column count, by contrast,
 * changes at a handful of widths, and at exactly those widths the board on
 * screen is the wrong shape.
 *
 * Both frames are scored against ONE dagre pass, because the sessions are the
 * same in both; only the packing differs.
 */
export function columnsWouldChange(
  nodes: Node[],
  edges: Edge[],
  opts: LayoutOptions,
  before: Frame,
  after: Frame,
): boolean {
  // A frame of zero is "not measured yet", not "a frame that wants one column".
  if (!(before.width > 0 && before.height > 0 && after.width > 0 && after.height > 0)) return false;
  const { laid, gap } = laySessions(nodes, edges, opts);
  if (laid.length < 2) return false;
  return packColumns(laid, gap, before.width, before.height).length
    !== packColumns(laid, gap, after.width, after.height).length;
}

export function autoLayout(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): Node[] {
  const pinned = opts.pinned ?? new Map();
  const { laid, gap } = laySessions(nodes, edges, opts);
  const columns = packColumns(laid, gap, opts.availableWidth ?? 0, opts.availableHeight ?? 0);

  const finalPositions = new Map<string, { x: number; y: number }>();
  let offsetX = 0;
  for (const col of columns) {
    const colW = widthOf(col);
    let cursorY = 0;
    for (const { positions, height, pinnedBox } of col) {
      for (const [id, p] of positions) finalPositions.set(id, { x: p.x + offsetX, y: p.y + cursorY });
      let bottom = cursorY + height;
      // Here the session's canvas origin is known, so a dragged member can
      // finally be compared with it: the rest of the column has to clear a card
      // the user pulled below its session. Only when the card is in this
      // column's band, though — a pin parked off to the side is not in the way
      // of anything stacked here, and treating it as if it were leaves a tall
      // empty strip that the fit zoom then has to cover.
      if (pinnedBox && pinnedBox.maxY > bottom &&
          pinnedBox.minX < offsetX + colW && offsetX < pinnedBox.maxX) {
        bottom = pinnedBox.maxY;
      }
      cursorY = bottom + SESSION_GAP;
    }
    offsetX += colW + gap;
  }

  return nodes.map(n => {
    const manual = pinned.get(n.id);
    if (manual) return { ...n, position: manual };
    const p = finalPositions.get(n.id);
    if (!p) return n;
    return { ...n, position: p };
  });
}

