// Auto-layout helper using dagre. Pure: input nodes/edges -> positioned nodes.
//
// Each session is laid out as its own dagre subgraph, and the subgraphs are
// stacked into columns with a fixed gap — as many columns as let a fit show
// the board largest on the canvas it is drawn on. This guarantees the
// per-session cluster boxes drawn by <SessionClusters/> never overlap, no
// matter how many sessions are live at once.
import dagre from "dagre";
import type { Node, Edge } from "reactflow";

const NODE_W = 240;
const NODE_H = 130;

// Chrome drawn around a session beyond its cards: outer padding on both sides,
// the label header, and the label tab that sits above the box's top edge
// (PAD 18, HEADER_H 26, LABEL_LIFT 12 in SessionClusters.tsx).
const SESSION_CHROME = 18 * 2 + 26 + 12;

// Clear space wanted between one session's box and the next one's label tab.
// Measured as what the eye sees, not as the distance between card origins —
// the chrome is added on top, so changing this changes the visible gap by the
// same amount.
const SESSION_VISIBLE_GAP = 72;
const SESSION_GAP = SESSION_CHROME + SESSION_VISIBLE_GAP;

// Horizontal room between two session columns: a full card width. At 80px the
// columns read as one crowded field, with cluster boxes and their label tabs
// close enough to look joined. A whole node of clear space is where the eye
// stops trying to relate them. Measured from the widest card actually on
// screen rather than the default, so the gap holds when cards are wider.
//
// Read per node id, the way every other pass here reads `measured`. Walking
// the map's values instead took in the invisible per-session drag handles,
// which React Flow measures like any other node and which are as wide as the
// whole session box: one session fanned out to subagents reported ~1100px, and
// that became the pitch between two 240px columns. Either the fit check below
// then failed and every session collapsed into one very tall strip that
// fit-to-view had to shrink to cover, or the columns survived with an ~850px
// band of dead canvas between them.
function columnGap(
  nodes: Node[],
  measured: Map<string, { width: number; height: number }>,
): number {
  let widest = NODE_W;
  for (const n of nodes) widest = Math.max(widest, measured.get(n.id)?.width ?? NODE_W);
  return widest;
}

/**
 * Width the tool-burst lane needs to the right of every agent card.
 *
 * Bursts are drawn by <ToolBursts/> as an overlay, not as React Flow nodes, so
 * dagre cannot see them and a session measured from its cards alone reports a
 * width that stops at the card's right edge. Packing columns on that number
 * puts the next column straight through this session's tool chips — which is
 * exactly what a second column made visible.
 *
 * Derived from ToolBursts: BUBBLE_OFFSET_X (60) + a primary bubble + SUB_GAP
 * (28) + a chained sub-bubble, with headroom for the long Codex labels that
 * size themselves from the label text.
 */
const TOOL_LANE_W = 420;

/**
 * The closest a fit ever frames the board — fitLeft's MAX_ZOOM. Cards are drawn
 * at their natural size, so two arrangements that both show them 1:1 are
 * equally readable, and the one with fewer columns is the easier read.
 */
const FULL_SIZE = 1;

/**
 * The zoom a fit would show a `w` x `h` board at, on a frame `canvasW` x
 * `canvasH` that shows it at full size.
 *
 * This is what picks the number of columns and where a new session goes. A cap
 * of two columns, and a second one only when both fitted the canvas at full
 * size, used to decide it instead — so one session fanning out to subagents
 * made two columns "not fit", everything collapsed into one strip several
 * screens tall, and the fit shrank the whole board to a third of its size
 * beside an empty right half. Scoring an arrangement by what the fit will
 * actually show spreads the board sideways exactly as far as the canvas's own
 * shape asks, and stops once the cards are at full size.
 */
function fitZoom(w: number, h: number, canvasW: number, canvasH: number): number {
  return Math.min(FULL_SIZE, canvasW / Math.max(1, w), canvasH / Math.max(1, h));
}

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

function sessionOfNode(n: Node): string {
  const sid = (n.data as { sessionId?: string } | undefined)?.sessionId;
  return sid ?? "_default";
}

/** Bubbles currently drawn beside an agent, by agent id. Absent = none. */
export type Lanes = Map<string, number>;

/** Horizontal room this agent's bubbles need, or 0 when it has none. */
function laneWidth(id: string, lanes: Lanes | undefined): number {
  return (lanes?.get(id) ?? 0) > 0 ? TOOL_LANE_W : 0;
}

/** Vertical room, from ToolBursts: 6px inset then 36px per bubble. */
function laneHeight(id: string, lanes: Lanes | undefined): number {
  const n = lanes?.get(id) ?? 0;
  return n > 0 ? 6 + n * 36 : 0;
}

/**
 * The ground an agent actually covers: its card PLUS its burst lane.
 *
 * `measured` is what React Flow measured, and React Flow measures nodes —
 * bursts are an overlay, so a card with four chips streaming off its right edge
 * measures exactly as wide as one with none. Every pass that places or pushes a
 * box has to add the lane back itself, or it packs neighbours into space the
 * chips are already using and quietly undoes the reservation `layoutSession`
 * made — which is what a screenshot of tool chips drawn across the cards beside
 * them was. Sizing from `measured` alone is the bug; this is the size to use.
 */
function footprint(
  id: string,
  measured: Map<string, { width: number; height: number }>,
  lanes: Lanes | undefined,
): { w: number; h: number } {
  const m = measured.get(id);
  return {
    w: (m?.width ?? NODE_W) + laneWidth(id, lanes),
    h: Math.max(m?.height ?? NODE_H, laneHeight(id, lanes)),
  };
}

/**
 * Canonical string for a lane map, so a caller that caches its layout can tell
 * when the lanes have moved.
 *
 * An agent gaining its first bubble is as real a change in size as its card
 * being measured wider, and it has to invalidate a cached arrangement the same
 * way. The count is clamped by the caller at the four bubbles ToolBursts keeps,
 * so this settles after an agent's fourth tool call however many thousand it
 * goes on to make.
 */
export function laneSignature(lanes: Lanes): string {
  return [...lanes.keys()].sort().map(id => `${id}:${lanes.get(id)}`).join("|");
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
    const m = measured.get(id);
    const w = m?.width ?? NODE_W;
    const h = m?.height ?? NODE_H;
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
    const m = measured.get(id);
    const w = m?.width ?? NODE_W;
    const h = m?.height ?? NODE_H;
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

  const sessions = new Map<string, string[]>();
  for (const n of nodes) {
    const sid = sessionOfNode(n);
    const list = sessions.get(sid);
    if (list) list.push(n.id);
    else sessions.set(sid, [n.id]);
  }

  // Lay out each session in its own dagre graph, then pack the subgraphs into
  // columns. Sessions are ordered by id so the layout is stable across events.
  const sessionOrder = Array.from(sessions.keys()).sort();
  const laid = sessionOrder.map(sid => ({
    sid,
    ...layoutSession(sessions.get(sid)!, edges, direction, measured, pinned, lanes),
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


/**
 * Push apart only the nodes that overlap, leaving everything else where it is.
 *
 * The layout pass runs once per node and then never again, so an arrangement
 * survives reloads and structural changes. The cost of that is that a newly
 * placed node can land on an older one, and two sessions can drift together.
 * This is the repair: it walks the nodes in a stable order, and the first time
 * a node covers ground already taken it slides down until it is clear.
 *
 * Deliberately minimal. Re-running the full layout would fix more and move
 * everything; this fixes the specific thing that is wrong and touches nothing
 * else, which is what makes it safe to run on every structural change.
 *
 * Pinned nodes are obstacles but never move — the user put them there. Mutates
 * `positions`; returns the ids it had to move.
 *
 * `lanes` is the same map `autoLayout` gets. It has to be, because this runs on
 * every structural change and dagre runs once: reserving the lane there and
 * omitting it here means the repair packs the cards back to card clearance and
 * a 420px lane runs straight through the neighbour. Resolution is still on Y
 * alone, so a lane overhanging to the right is cleared by sliding the node it
 * covers below it rather than further out.
 */
export function separateOverlaps(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  lanes?: Lanes,
): string[] {
  const MARGIN = 24;
  // Two cards in DIFFERENT sessions need more than card clearance: each is
  // drawn inside a cluster box that extends past it — padding on every side,
  // a header strip, and a label tab above that. Cards 30px apart look fine and
  // their boxes still cross, which is what "one on another" actually was.
  const CROSS_SESSION_Y = SESSION_CHROME + SESSION_VISIBLE_GAP;
  const CROSS_SESSION_X = 18 * 2 + MARGIN;

  const sizeOf = (id: string) => footprint(id, measured, lanes);

  // Stable order: by y, then x, then id. Same input always yields the same
  // result, so a re-render cannot make nodes drift.
  const sessionOf = new Map(nodes.map(n => [n.id, sessionOfNode(n)]));

  const placed: Array<{ x: number; y: number; w: number; h: number; sid: string }> = [];
  const ordered = nodes
    .map(n => ({ id: n.id, pos: pinned.get(n.id) ?? positions.get(n.id) }))
    .filter((n): n is { id: string; pos: { x: number; y: number } } => n.pos != null)
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));

  const moved: string[] = [];
  for (const { id, pos } of ordered) {
    const { w, h } = sizeOf(id);
    const sid = sessionOf.get(id) ?? "_default";
    // A dragged node is an obstacle for everything else but is never itself
    // relocated.
    if (pinned.has(id)) { placed.push({ x: pos.x, y: pos.y, w, h, sid }); continue; }

    let y = pos.y;
    // Re-check from the start after each shift: sliding clear of one node can
    // push into another that was already checked.
    for (let guard = 0; guard < placed.length + 1; guard++) {
      const clash = placed.find(r => {
        const mx = r.sid === sid ? MARGIN : CROSS_SESSION_X;
        const my = r.sid === sid ? MARGIN : CROSS_SESSION_Y;
        return pos.x < r.x + r.w + mx && r.x < pos.x + w + mx &&
               y     < r.y + r.h + my && r.y < y     + h + my;
      });
      if (!clash) break;
      y = clash.y + clash.h + (clash.sid === sid ? MARGIN : CROSS_SESSION_Y);
    }
    if (y !== pos.y) { positions.set(id, { x: pos.x, y }); moved.push(id); }
    placed.push({ x: pos.x, y, w, h, sid });
  }
  return moved;
}


/**
 * Drop newly-arrived sessions into the gaps left by ones that finished.
 *
 * Sessions are pruned as they complete, which punches holes in a column while
 * new work keeps being appended below the last thing placed. Left alone the
 * canvas grows downward forever with empty bands through the middle, and the
 * fit zoom shrinks to cover space that holds nothing.
 *
 * A session is moved as a whole — its cards keep their arrangement relative to
 * each other, only the block moves — and it is only ever moved into a gap that
 * fits it outright. Anything that does not fit stays where the layout put it,
 * below everything else.
 *
 * A gap is measured against real footprints, lanes included — a band that looks
 * empty because the session above it has been pruned may still be covered by
 * the chips of the session beside it, and dropping an arrival into it would
 * land it under them.
 *
 * Given the `frame` a fit shows the board in, a gap is not the only choice. The
 * board used to grow only downward — into a gap in a column that already
 * existed, or below it, never into a column that did not — so a board that
 * started as one column stayed one column however many sessions arrived, and
 * the fit shrank it beside an empty right half. With a frame, every clear slot
 * is scored instead: each column's gaps and its foot, and the top of a new
 * column to the right, by the zoom the fit would show the board at with the
 * arrival in it. A slot inside the board costs nothing, so a hole is still
 * filled first; past that the board grows whichever way keeps its cards
 * largest. Between slots the fit would show at the same zoom, the one leaving
 * the most room on the tighter axis wins, then the most on the other, then the
 * leftmost and topmost. When nothing is settled yet the whole board is
 * arriving at once, and autoLayout's arrangement of it stands.
 *
 * Mutates `positions`; returns the session ids it relocated.
 */
export function fillGapsWithNewSessions(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  newIds: Set<string>,
  lanes?: Lanes,
  /** The frame a fit shows the board in, as autoLayout is given it. */
  frame?: { width: number; height: number },
): string[] {
  const sizeOf = (id: string) => footprint(id, measured, lanes);
  const posOf = (id: string) => pinned.get(id) ?? positions.get(id);
  // The fit frames cards, not lanes, so the board it scores is card-sized.
  const cardOf = (id: string) => {
    const m = measured.get(id);
    return { cw: m?.width ?? NODE_W, ch: m?.height ?? NODE_H };
  };
  const scoring = frame != null && frame.width > 0 && frame.height > 0;

  // Only a session that arrived WHOLE may be relocated.
  //
  // The caller hands over every node that had no stored position, which for a
  // session already on screen that spawns a subagent is just that one child.
  // Treating it as an arrival makes it a one-card block whose own parent sits
  // in `settled` as a cross-session obstacle, so the child gets dropped into
  // some distant gap hundreds of pixels from the session it belongs to: the
  // cluster box stretches across the canvas to reach it and the parent→child
  // edge runs the length of the screen. A partially-new session keeps the slot
  // dagre just gave its new cards, beside their siblings.
  const membersBySession = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!posOf(n.id)) continue;
    const sid = sessionOfNode(n);
    const list = membersBySession.get(sid);
    if (list) list.push(n);
    else membersBySession.set(sid, [n]);
  }
  const wholeSessionArrived = new Set<string>();
  for (const [sid, members] of membersBySession) {
    if (members.every(n => newIds.has(n.id) && !pinned.has(n.id))) wholeSessionArrived.add(sid);
  }

  // Group the arrivals, and keep anything already placed as an obstacle.
  const arriving = new Map<string, Node[]>();
  const settled: Array<{ x: number; y: number; w: number; h: number; cw: number; ch: number }> = [];
  for (const n of nodes) {
    const p = posOf(n.id);
    if (!p) continue;
    const { w, h } = sizeOf(n.id);
    const sid = sessionOfNode(n);
    if (wholeSessionArrived.has(sid)) {
      (arriving.get(sid) ?? arriving.set(sid, []).get(sid)!).push(n);
    } else {
      settled.push({ x: p.x, y: p.y, w, h, ...cardOf(n.id) });
    }
  }
  if (arriving.size === 0 || (scoring && settled.length === 0)) return [];

  // Session boxes are what must not touch, so obstacles are inflated by the
  // chrome and the gap the layout would have left between two sessions.
  const PADDING = SESSION_CHROME + SESSION_VISIBLE_GAP;
  const clashes = (x: number, y: number, w: number, h: number) =>
    settled.some(r =>
      x < r.x + r.w + SESSION_CHROME && r.x < x + w + SESSION_CHROME &&
      y < r.y + r.h + PADDING        && r.y < y + h + PADDING);
  const gap = columnGap(nodes, measured);

  const moved: string[] = [];
  // Id order, the same order autoLayout packs sessions in, so gap placement is
  // deterministic across renders. Not arrival order: session ids are random
  // UUIDs and no timestamp reaches this function, so which arrival gets first
  // pick of the gaps is arbitrary-but-stable rather than oldest-first.
  for (const sid of [...arriving.keys()].sort()) {
    const members = arriving.get(sid)!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let cardRight = -Infinity, cardBottom = -Infinity;
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w, h } = sizeOf(n.id);
      const { cw, ch } = cardOf(n.id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      cardRight = Math.max(cardRight, p.x + cw); cardBottom = Math.max(cardBottom, p.y + ch);
    }
    const w = maxX - minX, h = maxY - minY;

    // Candidate tops: the very top of a column, and just under everything
    // already there. Any gap big enough starts at one of those edges, so
    // there is nothing to gain from stepping pixel by pixel.
    const columns = [...new Set(settled.map(r => Math.round(r.x)))].sort((a, b) => a - b);
    const xs = columns.length ? columns : [minX];
    const ys = [0, ...settled.map(r => r.y + r.h + PADDING)].sort((a, b) => a - b);

    let target: { x: number; y: number } | null = null;
    if (scoring) {
      // The board as the fit frames it: its cards, plus the burst lane fitLeft
      // leaves beside the rightmost one.
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const r of settled) {
        left = Math.min(left, r.x); top = Math.min(top, r.y);
        right = Math.max(right, r.x + r.cw); bottom = Math.max(bottom, r.y + r.ch);
      }
      // Scored by the zoom the fit would show the board at, and between slots
      // that tie on it — every slot under a board already bound by its width
      // is a tie — by how much room each leaves on the tighter axis, then on
      // the other. Without that second look the leftmost column's foot won
      // every tie, however much taller than its neighbour it already was.
      const scoreAt = (x: number, y: number) => {
        const across = frame!.width /
          (Math.max(right, x + cardRight - minX) - Math.min(left, x) + TOOL_LANE_W);
        const down = frame!.height /
          (Math.max(bottom, y + cardBottom - minY) - Math.min(top, y));
        return [Math.min(FULL_SIZE, across, down), Math.min(across, down), Math.max(across, down)];
      };
      const beats = (s: number[], t: number[]) => {
        for (let i = 0; i < s.length; i++) {
          if (s[i] > t[i] + 1e-9) return true;
          if (s[i] < t[i] - 1e-9) return false;
        }
        return false;
      };
      // A new column starts a burst lane and a column gap past the rightmost
      // card — the pitch autoLayout packs its columns at — level with the top
      // of the board.
      const fresh = Math.round(right + TOOL_LANE_W + gap);
      const tops = [...new Set([...ys, top])].sort((a, b) => a - b);
      let best: number[] | null = null;
      for (const x of [...xs, fresh]) {
        for (const y of tops) {
          if (clashes(x, y, w, h)) continue;
          const score = scoreAt(x, y);
          if (best === null || beats(score, best)) { best = score; target = { x, y }; }
        }
      }
      if (target && target.x === minX && target.y === minY) target = null;
    } else {
      outer: for (const x of xs) {
        for (const y of ys) {
          if (y >= minY) break;               // not a gap — that is where it already is
          if (!clashes(x, y, w, h)) { target = { x, y }; break outer; }
        }
      }
    }

    if (target) {
      const dx = target.x - minX, dy = target.y - minY;
      for (const n of members) {
        const p = posOf(n.id)!;
        positions.set(n.id, { x: p.x + dx, y: p.y + dy });
      }
      moved.push(sid);
    }
    // Placed or not, it is an obstacle for the next arrival.
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w: nw, h: nh } = sizeOf(n.id);
      settled.push({ x: p.x, y: p.y, w: nw, h: nh, ...cardOf(n.id) });
    }
  }
  return moved;
}


/**
 * Keep the cards a session gains beside that session, wherever it now sits.
 *
 * autoLayout places every card as if the whole board were being laid out from
 * scratch, and the caller keeps only the slots of cards that had none. For a
 * session already on the canvas that is the subagent it just spawned — and the
 * scratch slot is where the session WOULD sit, not where it does. The two part
 * as soon as anything moves a session: a gap it was dropped into, a push from a
 * neighbour that grew, a column count that changed with the canvas. The child
 * then landed wherever the scratch layout had its session, and the repair pass
 * slid it down until it cleared something — a live board had three subagents
 * strung out a screen below their parent, and to the left of it.
 *
 * So a new card moves by however far its session has: the offset between an
 * already-placed member's real position and its scratch one. That member is the
 * card's parent when the parent has a place, because the edge to it is what the
 * eye follows, and otherwise the lowest id, so the choice is stable. A pinned
 * card is never the anchor — dagre does not lay pins out, so a pin's scratch
 * position is the pin itself and says nothing about where the session went —
 * and is never moved.
 *
 * `placedAt` answers for cards that already have a real position. Returns
 * `laidOut` with the unplaced cards of those sessions shifted.
 */
export function joinSessions(
  laidOut: Node[],
  pinned: Map<string, { x: number; y: number }>,
  placedAt: (id: string) => { x: number; y: number } | undefined,
): Node[] {
  const anchors = new Map<string, Node[]>();
  for (const n of laidOut) {
    if (pinned.has(n.id) || !placedAt(n.id)) continue;
    const sid = sessionOfNode(n);
    (anchors.get(sid) ?? anchors.set(sid, []).get(sid)!).push(n);
  }
  if (anchors.size === 0) return laidOut;
  for (const members of anchors.values()) members.sort((a, b) => a.id.localeCompare(b.id));

  return laidOut.map(n => {
    if (pinned.has(n.id) || placedAt(n.id)) return n;
    const members = anchors.get(sessionOfNode(n));
    if (!members) return n;
    const parentId = (n.data as { parentId?: string } | undefined)?.parentId;
    const anchor = members.find(m => m.id === parentId) ?? members[0];
    const real = placedAt(anchor.id)!;
    return {
      ...n,
      position: {
        x: n.position.x + real.x - anchor.position.x,
        y: n.position.y + real.y - anchor.position.y,
      },
    };
  });
}


/**
 * Make room for a session that just got bigger by pushing its neighbours aside.
 *
 * Eight subagents spawning at once is the case this exists for. The session's
 * cards fan out, its cluster box grows in every direction, and it swallows
 * whatever was next to it. `separateOverlaps` will clear that, but only by
 * sliding the covered session straight down until it is past the obstacle —
 * which throws a session that was sitting perfectly well half a screen away
 * because something beside it grew by 60px.
 *
 * This displaces by the smallest amount that resolves the overlap instead. For
 * each overlapping pair it finds the shallower axis of penetration and pushes
 * along that one, splitting the push between the two sessions by mass. The
 * session that grew is heavy, so it keeps its ground and its neighbours give
 * way; a session holding a node the user dragged is immovable, so the push
 * routes around it rather than undoing their placement.
 *
 * Whole sessions move, never individual cards — a session's internal
 * arrangement is what makes it readable, and shoving one card out of a cluster
 * to resolve a collision destroys more than the collision did.
 *
 * `prevSessionSize` is the caller's memory of how big each session was last
 * time; it is read to decide what grew and written back before returning. The
 * first call only records, so nothing jumps on load.
 *
 * Mutates `positions`. Returns the session ids it moved — empty when nothing
 * grew, which is almost every call.
 */
export function bubblePush(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  prevSessionSize: Map<string, { w: number; h: number }>,
  /**
   * Record the sizes and move nothing.
   *
   * Cards are measured as they mount, so during the first moment of a page
   * load a session's box grows every frame — from one measured card, to three,
   * to all of them. That is measurement catching up, not a session fanning
   * out, and pushing on it rearranges a board the user asked to have preserved
   * across refresh.
   */
  recordOnly = false,
  /**
   * Bubbles beside each agent, as `autoLayout` gets them.
   *
   * A session's size is read from `measured`, which holds cards only, so the
   * single most common way a session on this canvas grows — an agent gaining a
   * lane, 420px wide and up to 150px tall — used to register as no growth at
   * all, and the push that exists for exactly that never fired. With the lane
   * in the size both the growth test and the area-based mass follow from it:
   * the session whose chips are doing the covering is the heavy one, and it is
   * its neighbours that yield.
   */
  lanes?: Lanes,
): string[] {
  // Clearance between two session boxes — the same numbers separateOverlaps
  // uses, so the two agree on what "overlapping" means.
  // Relaxation approaches the constraint from inside and stops a hair short of
  // it, so it solves for a fraction more clearance than is actually required
  // and the converged result clears the real gap outright.
  const SOLVE_SLACK = 1;
  const GAP_X = 18 * 2 + 24 + SOLVE_SLACK;
  const GAP_Y = SESSION_CHROME + SESSION_VISIBLE_GAP + SOLVE_SLACK;

  // A session has to gain real size to count. Sub-pixel measurement noise and
  // a card gaining a digit are not worth moving the canvas for.
  const GROWTH_EPS = 8;

  // Resolving on the shallower axis alone would push sideways as readily as
  // down, and sessions are packed into columns — a sideways push breaks the
  // column, a downward one only stretches it. So horizontal penetration has to
  // be clearly the cheaper way out before it wins.
  const X_BIAS = 1.75;

  // Jacobi relaxation: collect every pair's push, then apply once. Applying
  // each pair as it is found makes the result depend on pair order and lets
  // three mutually-overlapping sessions oscillate.
  // Convergence is geometric — each pass removes DAMPING of what is left — so
  // the iteration count is about the worst mutually-overlapping case, not the
  // common one, and at a dozen sessions the whole thing is a few thousand
  // comparisons.
  const ITERATIONS = 200;
  const DAMPING = 0.7;
  const SETTLED = 0.01;     // px of total movement below which we stop

  const sizeOf = (id: string) => footprint(id, measured, lanes);
  const posOf = (id: string) => pinned.get(id) ?? positions.get(id);

  interface Box {
    sid: string;
    members: string[];
    x: number; y: number; w: number; h: number;
    anchored: boolean;      // holds a node the user dragged — never moves
    mass: number;
  }

  // ── build one box per session ────────────────────────────────────────────
  const bySession = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!posOf(n.id)) continue;
    const sid = sessionOfNode(n);
    const list = bySession.get(sid);
    if (list) list.push(n); else bySession.set(sid, [n]);
  }

  const boxes: Box[] = [];
  const grew = new Set<string>();
  const seen = new Set<string>();
  // Read before the loop below fills it in. Cards are measured as they mount,
  // so on the very first call the boxes are whatever has rendered so far —
  // usually crossing, and always about to change. Nothing is worth moving yet.
  const firstCall = prevSessionSize.size === 0;

  // Sorted so the relaxation is deterministic: same input, same output.
  for (const sid of [...bySession.keys()].sort()) {
    const members = bySession.get(sid)!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let anchored = false;
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w, h } = sizeOf(n.id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      if (pinned.has(n.id)) anchored = true;
    }
    const w = maxX - minX, h = maxY - minY;
    seen.add(sid);

    const before = prevSessionSize.get(sid);
    // Unknown sessions are recorded, not treated as growth: on first load every
    // session would qualify and the whole canvas would shove itself apart.
    if (before && (w > before.w + GROWTH_EPS || h > before.h + GROWTH_EPS)) grew.add(sid);
    prevSessionSize.set(sid, { w, h });

    boxes.push({ sid, members: members.map(n => n.id), x: minX, y: minY, w, h, anchored, mass: 1 });
  }
  for (const sid of [...prevSessionSize.keys()]) if (!seen.has(sid)) prevSessionSize.delete(sid);

  if (recordOnly || firstCall) return [];

  // Growth is the usual cause of a collision, and for a long time it was the
  // only one this bothered to look for. It is not the only one.
  //
  // separateOverlaps keeps CARDS apart, but what the user sees crossing is the
  // BOX drawn around each session — the union of its cards, plus padding, a
  // header and a label tab. A three-card session can sit in the vertical gap
  // between two cards of a twenty-card one, clash with neither, and still be
  // drawn straight through the middle of its box. Nothing grew, so nothing
  // looked; the boxes stayed crossed until something else happened to move.
  //
  // A session dropped into a gap by fillGapsWithNewSessions, a card slid clear
  // of one neighbour into another's span, and a board restored from storage all
  // land in the same place. So: run whenever boxes are actually crossing, and
  // let growth decide only who holds their ground.
  let crossing = false;
  for (let i = 0; i < boxes.length && !crossing; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.anchored && b.anchored) continue;
      if (Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) < (a.w + b.w) / 2 + GAP_X &&
          Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) < (a.h + b.h) / 2 + GAP_Y) {
        crossing = true;
        break;
      }
    }
  }
  if (grew.size === 0 && !crossing) return [];

  if (grew.size > 0) {
    // The session that grew holds its ground; everything else yields to it.
    for (const b of boxes) if (grew.has(b.sid)) b.mass = 8;
  } else {
    // Nothing changed size, so there is no culprit to hold still. Area decides
    // instead: shoving a twenty-card session aside to clear a three-card one
    // rearranges far more of the canvas than the reverse does.
    for (const b of boxes) b.mass = Math.max(1, (b.w * b.h) / (NODE_W * NODE_H));
  }

  // ── relax ────────────────────────────────────────────────────────────────
  const startX = new Map(boxes.map(b => [b.sid, b.x]));
  const startY = new Map(boxes.map(b => [b.sid, b.y]));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const dx = new Map<string, number>();
    const dy = new Map<string, number>();
    let total = 0;

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.anchored && b.anchored) continue;

        const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        const overlapX = (a.w + b.w) / 2 + GAP_X - Math.abs(acx - bcx);
        const overlapY = (a.h + b.h) / 2 + GAP_Y - Math.abs(acy - bcy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // Everything above and left of the origin is off the canvas, so a box
        // already against it cannot absorb a push that heads further out.
        const freeX = (box: Box, dir: number) => !box.anchored && !(dir < 0 && box.x <= 0);
        const freeY = (box: Box, dir: number) => !box.anchored && !(dir < 0 && box.y <= 0);

        /**
         * Which way to separate on one axis.
         *
         * Normally: apart, along the line between the centres. When the centres
         * sit on top of each other there is no such line, and the id decides so
         * the result is stable rather than left to floating-point noise — but
         * then the choice is arbitrary, so if it points somewhere neither box
         * can go, the opposite is just as valid and is tried instead. Without
         * that, a session against the top-left corner whose only neighbour is
         * pinned reports itself wedged while a clear direction was available.
         */
        const pick = (ca: number, cb: number, free: (box: Box, dir: number) => boolean) => {
          const tied = ca === cb;
          const first = tied ? (a.sid < b.sid ? -1 : 1) : Math.sign(ca - cb);
          if (free(a, first) || free(b, -first)) return first;
          if (tied && (free(a, -first) || free(b, first))) return -first;
          return 0;
        };

        const dirX = pick(acx, bcx, freeX);
        const dirY = pick(acy, bcy, freeY);
        const canX = dirX !== 0, canY = dirY !== 0;
        if (!canX && !canY) continue;   // genuinely wedged; nothing to be done

        // Prefer the shallower axis, but only among the ones that can actually
        // take the push. Without this a session against the top edge whose only
        // neighbour is pinned resolves nowhere: the cheap axis is blocked, the
        // open one is never tried, and the two just stay on top of each other.
        const useX = canX && (!canY || overlapX * X_BIAS < overlapY);

        const [dir, overlap, delta, free] = useX
          ? [dirX, overlapX, dx, freeX] as const
          : [dirY, overlapY, dy, freeY] as const;

        // Share by mass, but only across the boxes that can move on this axis —
        // a partner that is pinned or against the edge takes none of it, and
        // its share goes to the other one rather than being lost.
        const aFree = free(a, dir), bFree = free(b, -dir);
        const ma = a.mass, mb = b.mass;
        const shareA = aFree ? (bFree ? mb / (ma + mb) : 1) : 0;
        const shareB = bFree ? (aFree ? ma / (ma + mb) : 1) : 0;

        const push = overlap * DAMPING;
        delta.set(a.sid, (delta.get(a.sid) ?? 0) + dir * push * shareA);
        delta.set(b.sid, (delta.get(b.sid) ?? 0) - dir * push * shareB);
        total += push;
      }
    }

    for (const b of boxes) {
      if (b.anchored) continue;
      // A session pushed off the top-left corner is not "out of the way", it
      // is gone. freeX/freeY above keep the solver from relying on a push the
      // clamp would have swallowed.
      b.x = Math.max(0, b.x + (dx.get(b.sid) ?? 0));
      b.y = Math.max(0, b.y + (dy.get(b.sid) ?? 0));
    }
    if (total < SETTLED) break;
  }

  // ── write back ───────────────────────────────────────────────────────────
  const moved: string[] = [];
  for (const b of boxes) {
    const shiftX = b.x - startX.get(b.sid)!;
    const shiftY = b.y - startY.get(b.sid)!;
    if (Math.abs(shiftX) < 1 && Math.abs(shiftY) < 1) continue;
    for (const id of b.members) {
      if (pinned.has(id)) continue;
      const p = positions.get(id);
      if (!p) continue;
      positions.set(id, { x: p.x + shiftX, y: p.y + shiftY });
    }
    moved.push(b.sid);
  }
  return moved;
}
