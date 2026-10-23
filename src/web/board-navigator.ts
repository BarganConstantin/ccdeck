// The board's compact form, for while the stage is open: where each session's
// tile goes in the navigator, and what its face says.
//
// WHY A NAVIGATOR AND NOT A SMALLER BOARD. When a session takes the stage the
// board has to give up most of its width, and the two obvious ways to give it
// up both lose something the reader relies on. Zooming the canvas out keeps
// every position and shrinks every word below reading size; re-sorting the
// sessions into a list keeps the words and throws away "paycore is top right",
// which is how people actually find a session on this board. The navigator
// keeps both: the board's own columns in the board's own order, every name at
// 1:1, each tile still showing its subagents. Geometry folds; words do not.
// (DESIGN-UI decision 1, built from the v3 prototype's board.js.)
//
// ORDER-PRESERVING, ALWAYS. A cluster never changes column or neighbour in the
// fold, so nothing crosses anything while the board gathers to the left, and a
// session's place in the navigator is the place the eye already remembers.
// When the board has more columns than the navigator has room for, columns are
// merged PAIRWISE and in order — 0+1, 2+3, … — and stacked in reading order,
// so the left-to-right truth degrades by halves instead of being re-decided.
//
// None of this touches React or the DOM. The component draws what navigatorFrame
// returns; the words on a face are the board's own (faceSignal with the words
// the card's NodeFace hands it), so the navigator cannot come to describe a
// session differently from the card it stands in for.
import { primaryDisplayFor, toolSubject } from "./tool-skin";
import { waitingLabel } from "./agent-copy";
import { faceSignal, type BranchSummary, type FaceSignal } from "./node-face";
import type { ClusterNode } from "./cluster-bounds";
import type { AgentNodeData, ToolCall, WaitingBlock } from "./types";

/** How much the navigator draws per session: a tile with its subagent rows, or
 *  the face alone in one column (a narrow window, or an expanded stage). The
 *  same two words stage-geometry.ts hands out. */
export type NavDensity = "tiles" | "rail";

export interface NavRect { x: number; y: number; w: number; h: number }

// ---------------------------------------------------------------------------
// Measurements. Every number is v3's (board.js navLayout/navHeight), named.

/** Space left and right of the tiles. */
export const NAV_PAD_X = 14;
/** Space above the first tile: its task pill sits 9px above the rim, and needs
 *  the rest to clear the header. */
export const NAV_PAD_TOP = 18;
/** Space under the last tile, so a scrolled-to-the-end list does not end on a
 *  rim pressed against the window's edge. */
export const NAV_PAD_BOTTOM = 24;
/** Between two navigator columns. */
export const NAV_COL_GAP = 12;
/** Between two tiles in one column; the next tile's pill lives in it. */
export const NAV_TILE_GAP = 26;
/** Between two faces in the rail, which carry no rows and read tighter. */
export const NAV_RAIL_GAP = 24;
/** The rim's inset round the face. */
export const TILE_PAD = 7;
/** The face: name and elapsed on one line, the signal on the next. */
export const FACE_H = 50;
/** A subagent row. Never under 22px: it is a line of 11.5px text with a mark,
 *  and the trunk edge needs the gap between two of them to read as a branch. */
export const ROW_H = 22;
/** Row to row, top to top. */
export const ROW_PITCH = 25;
/** From the face's bottom to the first row. */
export const ROWS_TOP_GAP = 5;
/** Under the last row, inside the rim. */
export const TILE_PAD_BOTTOM = 8;
/** The narrowest a tile column may be before two columns merge into one: a
 *  name, the elapsed clock and a few words of signal. The same 168 that
 *  stage-geometry.ts keeps for the rail, so a navigator wide enough to exist
 *  is wide enough for one tile column. */
export const TILE_MIN_W = 168;
/** The widest a tile is drawn. A board with one column next to a narrow stage
 *  would otherwise draw one tile the width of the window, every line of it a
 *  long way from the next. */
export const TILE_MAX_W = 360;

/** A cluster as the frame needs it: where the board put it and how many rows
 *  its tile carries. */
export interface NavCluster {
  sessionId: string;
  /** The board column it sits in, left to right. Need not be dense. */
  col: number;
  /** Its place in that column, top to bottom. Absent: the input order. */
  order?: number;
  /** How many subagent rows the tile draws at `tiles` density. */
  rows: number;
}

export interface NavTile extends NavRect {
  sessionId: string;
  /** The navigator column it is drawn in. */
  col: number;
  /** The board column it came from, made dense (0, 1, 2, … left to right). */
  boardCol: number;
  /** The top of each subagent row, from the tile's own top. Empty in the rail. */
  rows: number[];
}

export interface NavFrame {
  density: NavDensity;
  /** Navigator columns drawn. */
  columns: number;
  /** How many times the board's columns were merged pairwise to fit. */
  merges: number;
  /** The navigator's width, as asked. */
  width: number;
  /** How tall the tiles stand, padding included: what the scroller scrolls. */
  height: number;
  tileW: number;
  /** In reading order: down navigator column 0, then column 1, … */
  tiles: NavTile[];
}

/** How tall a tile is for `rows` subagents. The rail draws the face alone. */
export function tileHeight(rows: number, density: NavDensity): number {
  if (density === "rail" || rows <= 0) return TILE_PAD * 2 + FACE_H;
  return TILE_PAD + FACE_H + ROWS_TOP_GAP + (rows - 1) * ROW_PITCH + ROW_H + TILE_PAD_BOTTOM;
}

/**
 * A face's clock as the rail prints it: "17m" for the card's "16m 59s".
 *
 * A rail tile is 150px of face, and the card's clock (duration.ts `elapsed`)
 * takes the seconds out of the name's room — "orche…" beside "16m 59s" —
 * while a seconds count that ticks on every tile in a column says nothing a
 * glance at the rail is for (v3's rail prints "18m"). Rounded down, like the
 * card, so a rail never claims a minute the card has not reached. Everything
 * else the card prints — "353ms", "45s", "1h 12m" — is already one unit.
 */
export function railClock(text: string): string {
  return text.replace(/^(\d+m) \d+s$/, "$1");
}

/** Where each of `rows` subagent rows starts, from the tile's top. */
export function rowOffsets(rows: number, density: NavDensity): number[] {
  if (density === "rail") return [];
  const out: number[] = [];
  for (let i = 0; i < rows; i++) out.push(TILE_PAD + FACE_H + ROWS_TOP_GAP + i * ROW_PITCH);
  return out;
}

/** How many tile columns a navigator `navW` wide has room for. Always one at
 *  least: a navigator too narrow even for that still draws its tiles. */
export function fitColumns(navW: number): number {
  return Math.max(1, Math.floor((navW - NAV_PAD_X * 2 + NAV_COL_GAP) / (TILE_MIN_W + NAV_COL_GAP)));
}

/**
 * Where every tile goes in a navigator `navW` wide.
 *
 * Order-preserving: tiles are taken in (board column, place in column) order,
 * and a navigator column is always a run of whole board columns, so no tile
 * changes column relative to another or overtakes one. When the board has more
 * columns than fit, they are merged pairwise — the pair stacked left column
 * first — as many times as it takes. The rail is that merge taken all the way:
 * one column, in the board's reading order.
 */
export function navigatorFrame(clusters: readonly NavCluster[], navW: number, density: NavDensity): NavFrame {
  // Board columns made dense, so a column left empty by a session that went
  // away does not hold a navigator column open for nobody.
  const dense = new Map([...new Set(clusters.map(c => c.col))].sort((a, b) => a - b).map((col, i) => [col, i]));
  const sorted = clusters
    .map((c, i) => ({ c, boardCol: dense.get(c.col)!, order: c.order ?? i, i }))
    .sort((a, b) => a.boardCol - b.boardCol || a.order - b.order || a.i - b.i);

  const boardCols = dense.size;
  let merges = 0;
  let columns = Math.max(1, boardCols);
  if (density === "rail") {
    // Every column merged into one: the reading order, which is the order
    // `sorted` is already in.
    while (columns > 1) { columns = Math.ceil(columns / 2); merges += 1; }
  } else {
    const fit = fitColumns(navW);
    while (columns > fit) { columns = Math.ceil(columns / 2); merges += 1; }
  }

  const tileW = density === "rail"
    ? Math.max(0, Math.floor(navW - NAV_PAD_X * 2))
    : Math.max(0, Math.min(TILE_MAX_W, Math.floor((navW - NAV_PAD_X * 2 - NAV_COL_GAP * (columns - 1)) / columns)));
  const gap = density === "rail" ? NAV_RAIL_GAP : NAV_TILE_GAP;

  const cursor: number[] = Array.from({ length: columns }, () => NAV_PAD_TOP);
  const byColumn: NavTile[][] = Array.from({ length: columns }, () => []);
  for (const { c, boardCol } of sorted) {
    // A pairwise merge, `merges` times over, is a shift: board columns 2k and
    // 2k+1 become column k, and so on up.
    const col = density === "rail" ? 0 : boardCol >> merges;
    const h = tileHeight(c.rows, density);
    byColumn[col].push({
      sessionId: c.sessionId,
      col,
      boardCol,
      x: NAV_PAD_X + col * (tileW + NAV_COL_GAP),
      y: cursor[col],
      w: tileW,
      h,
      rows: rowOffsets(c.rows, density),
    });
    cursor[col] += h + gap;
  }

  const tiles = byColumn.flat();
  const bottom = Math.max(0, ...tiles.map(t => t.y + t.h));
  return {
    density,
    columns,
    merges,
    width: navW,
    height: tiles.length ? bottom + NAV_PAD_BOTTOM : 0,
    tileW,
    tiles,
  };
}

/** The part of a cluster's box the column reading needs. */
export interface BoardBox { sessionId: string; x: number; y: number; w: number; h: number }

/**
 * Which board column each cluster sits in, and its place in it, read off the
 * clusters' boxes as the board drew them.
 *
 * Read from the geometry rather than from layout.ts's packing, because the
 * geometry is what the reader saw: a session dragged across, or pushed aside
 * by a neighbour that grew, is in the column it is DRAWN in. Two boxes whose
 * horizontal spans overlap are one column — layout.ts starts every session of
 * a column at the same x and the next column clear of the widest of them — and
 * a column's sessions are taken top to bottom.
 */
export function boardColumns(boxes: readonly BoardBox[]): { sessionId: string; col: number; order: number }[] {
  const byX = [...boxes].sort((a, b) => a.x - b.x || a.y - b.y);
  const columns: BoardBox[][] = [];
  let right = -Infinity;
  for (const b of byX) {
    if (columns.length === 0 || b.x >= right) {
      columns.push([b]);
      right = b.x + b.w;
    } else {
      columns[columns.length - 1].push(b);
      right = Math.max(right, b.x + b.w);
    }
  }
  return columns.flatMap((col, c) =>
    [...col].sort((a, b) => a.y - b.y || a.x - b.x).map((b, order) => ({ sessionId: b.sessionId, col: c, order })));
}

/**
 * The tile the arrow keys move to from `sessionId`: the one beside it in the
 * next column over — the nearest by height, so → from a short tile lands where
 * the eye already is — or the one above or below it in its own column. Null at
 * an edge; the rail has no columns to the side.
 */
export function neighbourTile(frame: NavFrame, sessionId: string, dir: "left" | "right" | "up" | "down"): string | null {
  const me = frame.tiles.find(t => t.sessionId === sessionId);
  if (!me) return null;
  if (dir === "up" || dir === "down") {
    const column = frame.tiles.filter(t => t.col === me.col);
    const i = column.indexOf(me) + (dir === "down" ? 1 : -1);
    return column[i]?.sessionId ?? null;
  }
  const col = me.col + (dir === "right" ? 1 : -1);
  const mid = me.y + me.h / 2;
  let best: NavTile | null = null;
  for (const t of frame.tiles) {
    if (t.col !== col) continue;
    if (!best || Math.abs(t.y + t.h / 2 - mid) < Math.abs(best.y + best.h / 2 - mid)) best = t;
  }
  return best?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// What a tile says.

/** A card's data as the board's node carries it: the agent, plus the summary
 *  of its subagents App puts on a root (canvas-flow.ts nodeDataFor). */
export type NavAgent = AgentNodeData & { branch?: BranchSummary };

/** One session as the navigator draws it: its root card and the subagent cards
 *  the board shows under it, in the board's top-to-bottom order. */
export interface NavSession {
  sessionId: string;
  /** Null for a session whose root is not on the board — its subagents still
   *  make a cluster there, so they make a tile here. */
  root: NavAgent | null;
  subs: NavAgent[];
}

/**
 * The sessions on the board, from the same nodes the cluster boxes are built
 * from (cluster-bounds.ts clusterBounds), skipping what it skips: anything that
 * is not an agent card, and a card on its way out. So a tile carries exactly
 * the subagents the cluster beside it draws, in the order they stand there.
 */
export function navigatorSessions(nodes: Iterable<ClusterNode>): Map<string, NavSession> {
  const roots = new Map<string, NavAgent>();
  const subs = new Map<string, { d: NavAgent; x: number; y: number }[]>();
  for (const n of nodes) {
    if (n.type !== "agent") continue;
    const d = n.data as NavAgent | undefined;
    if (!d?.sessionId || d.exitAt != null) continue;
    if (d.kind === "root") { roots.set(d.sessionId, d); continue; }
    const list = subs.get(d.sessionId) ?? [];
    list.push({ d, x: n.position.x, y: n.position.y });
    subs.set(d.sessionId, list);
  }
  const out = new Map<string, NavSession>();
  for (const id of new Set([...roots.keys(), ...subs.keys()])) {
    const placed = (subs.get(id) ?? []).sort((a, b) => a.y - b.y || a.x - b.x);
    out.set(id, { sessionId: id, root: roots.get(id) ?? null, subs: placed.map(p => p.d) });
  }
  return out;
}

/** Two readings of the sessions are the same when every card is the same
 *  object in the same place. Node data keeps its identity until the board's
 *  revision moves (canvas-flow.ts nodeDataFor), so this is what lets the
 *  navigator skip the renders the board's 250ms tick would otherwise cost it. */
export function sameSessions(a: Map<string, NavSession>, b: Map<string, NavSession>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y || x.root !== y.root || x.subs.length !== y.subs.length) return false;
    for (let i = 0; i < x.subs.length; i++) if (x.subs[i] !== y.subs[i]) return false;
  }
  return true;
}

/** The clusters the frame lays out: the board's boxes, read into columns, with
 *  each tile's row count. */
export function navigatorClusters(boxes: readonly BoardBox[], sessions: Map<string, NavSession>): NavCluster[] {
  return boardColumns(boxes).map(({ sessionId, col, order }) => ({
    sessionId,
    col,
    order,
    rows: sessions.get(sessionId)?.subs.length ?? 0,
  }));
}

/**
 * The words faceSignal is handed, which are the card's: its waiting label, and
 * the bubbles' own name and subject for a call. The same pair NodeFace passes
 * in AgentNode.tsx, so a face here and a face on the board word the same block
 * and the same call the same way — a test renders both and compares.
 */
export const FACE_WORDS: {
  sayWaiting: (w: WaitingBlock) => string;
  describeCall: (t: ToolCall) => { name: string; subject?: string | null };
} = {
  sayWaiting: waitingLabel,
  describeCall: t => ({ name: primaryDisplayFor(t.name).label, subject: toolSubject(t.name, t.input) }),
};

/** What a face's second line says: the board face's own signal for the agent
 *  — faceSignal, with the subagent summary a root carries — or nothing for an
 *  agent the board has nothing to interrupt about. */
export function navSignal(agent: NavAgent): FaceSignal | null {
  return faceSignal(agent, agent.kind === "root" ? agent.branch : undefined, FACE_WORDS);
}

/** "1 session" / "7 sessions", for the navigator's header. */
export function sessionCount(n: number): string {
  return n === 0 ? "No sessions" : `${n} ${n === 1 ? "session" : "sessions"}`;
}
