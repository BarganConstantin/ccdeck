// Auto-layout helper using dagre. Pure: input nodes/edges -> positioned nodes.
//
// Each session is laid out as its own dagre subgraph, and the subgraphs flow
// into columns in the board's reading order — down a column, then across — as
// many columns as let a fit show every card largest, at most four. This
// guarantees the per-session cluster boxes drawn by <SessionClusters/> never
// overlap, no matter how many sessions are live at once.
import dagre from "dagre";
import type { Node, Edge } from "reactflow";
import {
  cardSize, COLUMN_GAP, fitZoom, footprint, FULL_SIZE, groupBySession, MAX_COLUMNS, ONE_COLUMN_ZOOM, SESSION_GAP, SIBLING_GAP,
  TOOL_LANE_W, type Lanes,
} from "./layout-geometry";
import { fitZoomForDrawnLanes } from "./semantic-zoom";

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
   * Session ids in the order the board reads them, down a column and then
   * across: the rail's, attention first (board-order.ts). Sessions it leaves
   * out follow in id order; omitted, every session is in id order.
   */
  order?: readonly string[];
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

/** dagre's gap between two ranks: the room an edge takes to turn from a parent
 *  card to its children when nothing else stands between them. */
const RANK_SEP = 160;

/** Clear canvas kept between the end of a parent's bubble trail and its
 *  children's cards. */
export const LANE_CLEARANCE = 40;

/**
 * How much wider than NODE_W a card that has not been measured yet can turn
 * out: agent-node.css draws it 260 wide, plus 60 at the largest text size.
 *
 * A board laid out before its cards measured — a page replaying the log, R —
 * keeps those slots once they measure, and the overlap pass then compares the
 * real width. Without this a root measured 20 wider than the 240 it was laid
 * out at reached its middle subagent with its bubble lane, and the pass slid
 * that subagent and every one under it down past the lane, leaving a column
 * with a hole in it. A card already measured needs no slack.
 */
const UNMEASURED_SLACK = 80;

/**
 * The box dagre is handed for an agent: its card plus its burst lane, LESS the
 * rank gap the lane already provides.
 *
 * Handed the whole card+lane box, dagre added its 160 rank gap after the 420 of
 * lane, so every subagent landed 580 units from its parent's card — 160 past
 * the furthest a trail of bubbles can reach, and more than twice the card it
 * was spawned from. A session that fanned out once was 1,900 units wide for two
 * columns of 240px cards, the fit could not frame it at the full card on a
 * 1440px window even with every panel shut, and with the default panels open
 * it framed it at the 0.2 floor: the report was "Default layout for spawning
 * new nodes make no sense". The edge's turn fits inside the lane, through the
 * same space the bubbles are drawn in, so a laned card's children now start
 * LANE_CLEARANCE past the lane, and UNMEASURED_SLACK more while the card has
 * not measured. A card with no bubbles keeps the full rank gap.
 */
function rankBox(id: string, measured: Map<string, { width: number; height: number }>, lanes?: Lanes): { w: number; h: number } {
  const card = cardSize(id, measured);
  const box = footprint(id, measured, lanes);
  const lane = box.w - card.w;
  const clearance = LANE_CLEARANCE + (measured.has(id) ? 0 : UNMEASURED_SLACK);
  return lane > 0 ? { w: card.w + Math.max(0, lane + clearance - RANK_SEP), h: box.h } : box;
}

function layoutSession(
  ids: string[],
  edges: Edge[],
  direction: "LR" | "TB",
  measured: Map<string, { width: number; height: number }>,
  pinned: Map<string, { x: number; y: number }>,
  lanes?: Lanes,
  notes: { has(id: string): boolean } = new Set<string>(),
): {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  /** How far in from the session's left edge its first card stands: the room
   *  its recap note takes, which is empty canvas below the full card. */
  cardLeft: number;
  pinnedBox: PinnedBox | null;
} {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    marginx: 0,
    marginy: 0,
    nodesep: SIBLING_GAP,
    ranksep: RANK_SEP,
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
    // Reserving the lane here moves the children clear of it instead — by the
    // lane and LANE_CLEARANCE, not the lane and a whole rank gap (rankBox).
    const { w, h } = rankBox(id, measured, lanes);
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
    const box = rankBox(id, measured, lanes);
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
  let cardLeft = Infinity;
  for (const [id, p] of positions) if (!notes.has(id)) cardLeft = Math.min(cardLeft, p.x);
  if (!Number.isFinite(cardLeft)) cardLeft = 0;

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
  return { positions, width, height, cardLeft, pinnedBox };
}

/** One session after dagre, waiting to be packed into a column. */
type LaidSession = ReturnType<typeof layoutSession> & { sid: string };
type Column = LaidSession[];

/** Every session run through dagre on its own, in the order the board reads them. */
function laySessions(nodes: Node[], edges: Edge[], opts: LayoutOptions): LaidSession[] {
  const direction = opts.direction ?? "LR";
  const pinned = opts.pinned ?? new Map();
  const measured = opts.measured ?? new Map();
  const lanes = opts.lanes;

  const sessions = groupBySession(nodes);

  // Lay out each session in its own dagre graph, then pack the subgraphs into
  // columns: in the order given, the rest after them by id, so the layout is
  // stable across events.
  const place = new Map<string, number>();
  for (const sid of opts.order ?? []) if (!place.has(sid)) place.set(sid, place.size);
  const rank = (sid: string) => place.get(sid) ?? place.size;
  const sessionOrder = Array.from(sessions.keys()).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const notes = new Set(nodes.filter(n => n.type === "recapNote").map(n => n.id));
  return sessionOrder.map(sid => ({
    sid,
    ...layoutSession(sessions.get(sid)!.map(n => n.id), edges, direction, measured, pinned, lanes, notes),
  }));
}

/** Where a column's cards stand from its left edge: as far in as its deepest
 *  note takes them. Every session in it is set on that line, with a note or
 *  without — a column whose cards stepped in and out by a note's width read as
 *  a zigzag down the board. */
const leadOf = (col: Column) => col.reduce((m, s) => Math.max(m, s.cardLeft), 0);

/** How wide a run of sessions is once they stand on one card line: the deepest
 *  note's room, then the widest stretch of cards from the line. */
const lineWidth = (col: Column) => leadOf(col) + col.reduce((w, s) => Math.max(w, s.width - s.cardLeft), 0);

/** A column is as wide as what landed in it: sizing every column to the widest
 *  session in the graph made one wide session set the pitch for all of them.
 *  Its cards, and with the lane their bubbles take at full size. */
const widthOf = (col: Column) => lineWidth(col) + TOOL_LANE_W;

/**
 * The columns these sessions want in a frame of this shape.
 *
 * Sessions are cut into columns in the order given, so they read down and then
 * across, and a session is never split across a boundary — each one is read as
 * a block, the thing the canvas exists to show.
 *
 * One column while it already shows the board at ONE_COLUMN_ZOOM or more.
 * Past that, every way of cutting the order into at most MAX_COLUMNS runs is
 * scored by the zoom fitLeft will show it at (use-camera.ts); a tie goes to
 * fewer columns, then to the evener cut. Every cut, not the evenest one per
 * count: a session fanned out to subagents is several cards wide, and the
 * evenest cut can stand two of those side by side where a cut one session on
 * keeps a column narrow and wins the frame's width back.
 *
 * The score counts each column's cards, and the lane and gap before the next
 * one — and the last column's lane only where the fit draws bubbles
 * (fitZoomForDrawnLanes). Charged at every zoom, as it was, it priced room the
 * fit never framed.
 *
 * The notes go with the bubbles. Below the full card the fit frames the cards
 * alone, and the room left of the first column's cards, where their notes
 * stand at the full card, is not in that frame. Charged there anyway, a session
 * with a note cost 400px of width the moment it opened a column of its own, so
 * five sessions with notes and two without were cut 5 + 2 — one tall column at
 * 44% beside an empty half of the stage, where 4 + 3 shows them larger. The
 * columns are still set that far apart (widthOf): what the fit does not frame
 * from afar is drawn when the board is read close.
 */
function packColumns(laid: LaidSession[], frameW: number, frameH: number): Column[] {
  const n = laid.length;
  const one: Column[] = [laid];
  if (!(frameW > 0 && frameH > 0) || n < 2) return one;

  // A run of sessions [i, j): its height from running sums, its width from a
  // table, so each cut is scored in a step per column.
  const tops = [0];
  for (const s of laid) tops.push(tops[tops.length - 1] + s.height + SESSION_GAP);
  // The width of the run [i, j] on one card line (lineWidth), grown a session
  // at a time.
  const widest = laid.map((_, i) => {
    const row: number[] = [];
    for (let j = i, lead = 0, tail = 0; j < n; j++) {
      lead = Math.max(lead, laid[j].cardLeft);
      tail = Math.max(tail, laid[j].width - laid[j].cardLeft);
      row.push(lead + tail);
    }
    return row;
  });
  // The first column of [0, j): where its card line stands, which is where the
  // fit's frame of the cards alone begins.
  const lead = [0];
  for (let j = 0, m = 0; j < n; j++) lead.push(m = Math.max(m, laid[j].cardLeft));
  const firstLine = (starts: readonly number[]) => lead[starts.length > 1 ? starts[1] : n];
  const score = (starts: readonly number[]) => {
    let w = 0, h = 0;
    for (let c = 0; c < starts.length; c++) {
      const i = starts[c], j = c + 1 < starts.length ? starts[c + 1] : n;
      w += widest[i][j - 1 - i] + (c + 1 < starts.length ? TOOL_LANE_W + COLUMN_GAP : 0);
      h = Math.max(h, tops[j] - tops[i] - SESSION_GAP);
    }
    const bare = fitZoom(w - firstLine(starts), h, frameW, frameH);
    return { shows: fitZoomForDrawnLanes(fitZoom(w + TOOL_LANE_W, h, frameW, frameH), bare), bare, h };
  };

  let best: readonly number[] = [0];
  let top = score(best);
  if (top.bare >= ONE_COLUMN_ZOOM) return one;
  const EPS = 1e-9;
  // `fixed` and `tallest` are the width and the height of the columns before
  // the last: cutting the last again never takes from either, so a branch
  // whose fixed columns alone, or the rest shared out over the columns left,
  // already show less than the best cut so far is not walked.
  const walk = (starts: number[], fixed: number, tallest: number) => {
    if (starts.length > 1) {
      const s = score(starts);
      const tie = Math.abs(s.shows - top.shows) <= EPS;
      if (s.shows > top.shows + EPS || (tie && (starts.length < best.length || (starts.length === best.length && s.h < top.h - EPS)))) {
        best = starts;
        top = s;
      }
    }
    if (starts.length === MAX_COLUMNS) return;
    const last = starts[starts.length - 1];
    const left = MAX_COLUMNS - starts.length;
    for (let at = last + 1; at < n; at++) {
      const next = fixed + widest[last][at - 1 - last] + TOOL_LANE_W + COLUMN_GAP;
      const high = Math.max(tallest, tops[at] - tops[last] - SESSION_GAP);
      // The cut at `at` closes the first column when there is none yet.
      const inset = lead[starts.length > 1 ? starts[1] : at];
      if (Math.min(FULL_SIZE, frameW / (next - inset), frameH / high) < top.shows - EPS) break;
      const rest = (tops[n] - tops[at] - left * SESSION_GAP) / left;
      if (Math.min(FULL_SIZE, frameH / Math.max(high, rest)) < top.shows - EPS) continue;
      walk([...starts, at], next, high);
    }
  };
  walk([0], 0, 0);
  return best.map((i, c) => laid.slice(i, c + 1 < best.length ? best[c + 1] : n));
}

/** The frame a fit shows the board in, in flow units at full size. */
export interface Frame { width: number; height: number }

export function autoLayout(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): Node[] {
  const pinned = opts.pinned ?? new Map();
  const laid = laySessions(nodes, edges, opts);
  const columns = packColumns(laid, opts.availableWidth ?? 0, opts.availableHeight ?? 0);

  const finalPositions = new Map<string, { x: number; y: number }>();
  let offsetX = 0;
  for (const col of columns) {
    const colW = widthOf(col);
    const line = leadOf(col);
    let cursorY = 0;
    for (const { positions, height, cardLeft, pinnedBox } of col) {
      // On the column's card line, whether this session has a note or not.
      const inset = offsetX + line - cardLeft;
      for (const [id, p] of positions) finalPositions.set(id, { x: p.x + inset, y: p.y + cursorY });
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
    offsetX += colW + COLUMN_GAP;
  }

  return nodes.map(n => {
    const manual = pinned.get(n.id);
    if (manual) return { ...n, position: manual };
    const p = finalPositions.get(n.id);
    if (!p) return n;
    return { ...n, position: p };
  });
}

