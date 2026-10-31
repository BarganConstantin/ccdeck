// The navigator is the board folded to the left while a session has the stage
// (DESIGN-UI decision 1), and the whole design rests on one promise: the fold
// keeps the board's shape. Every session stays in its column and in its place
// in that column, so "paycore is top right" is still true beside the stage and
// nothing crosses anything on the way there. When the navigator is too narrow
// for the board's columns they merge pairwise, in order — and the rail is that
// merge taken all the way, the board's reading order in one column.
//
// So these cases pin the geometry as a set of facts a reader relies on — no
// two tiles overlap, no tile leaves its column or overtakes a neighbour, a
// subagent row is never under 22px, a tile is exactly as tall as what it holds
// — rather than as the particular numbers the prototype happened to use.
import { describe, expect, it } from "vitest";
import {
  FACE_H, NAV_COL_GAP, NAV_PAD_BOTTOM, NAV_PAD_TOP, NAV_PAD_X, NAV_TILE_GAP, ROW_H, ROW_PITCH, TILE_MAX_W,
  TILE_MIN_W, TILE_PAD, TILE_PAD_BOTTOM, boardColumns, fitColumns, navigatorClusters, navigatorFrame,
  navigatorSessions, neighbourTile, railClock, sameSessions, sessionCount, tileHeight,
  type NavCluster, type NavFrame, type NavTile,
} from "../board-navigator";
import type { ClusterNode } from "../cluster-bounds";
import type { AgentNodeData } from "../types";

/** A board, column by column: each column a list of subagent counts, top to
 *  bottom. Session ids say where they came from: `c1r0` is column 1, row 0. */
function board(columns: number[][]): NavCluster[] {
  return columns.flatMap((col, c) => col.map((rows, order) => ({ sessionId: `c${c}r${order}`, col: c, order, rows })));
}

const overlaps = (a: NavTile, b: NavTile) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function pairs<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

/** The tiles of one navigator column, top to bottom. */
const column = (f: NavFrame, col: number) => f.tiles.filter(t => t.col === col).sort((a, b) => a.y - b.y);

const SHAPES: { name: string; columns: number[][] }[] = [
  { name: "the prototype's two columns", columns: [[7, 3, 0], [0, 0, 5, 3]] },
  { name: "one tall column", columns: [[2, 0, 9, 1, 0, 0]] },
  { name: "five columns", columns: [[1], [0, 4], [2, 2, 2], [0], [6, 0]] },
  { name: "three uneven columns", columns: [[12], [0, 0, 0, 0], [3]] },
];
const WIDTHS = [168, 320, 436, 560, 700, 1000];

describe("the navigator keeps the board's shape", () => {
  it("never draws one tile over another, at any width or density", () => {
    for (const { name, columns } of SHAPES) {
      for (const navW of WIDTHS) {
        for (const density of ["tiles", "rail"] as const) {
          const f = navigatorFrame(board(columns), navW, density);
          const hit = pairs(f.tiles).filter(([a, b]) => overlaps(a, b)).map(([a, b]) => `${a.sessionId}/${b.sessionId}`);
          expect(hit, `${name} at ${navW}px, ${density}`).toEqual([]);
        }
      }
    }
  });

  it("leaves room for the next tile's task pill between two tiles of a column", () => {
    // The pill sits 9px above its rim; a gap smaller than that would put it
    // on the tile above.
    for (const { columns } of SHAPES) {
      const f = navigatorFrame(board(columns), 436, "tiles");
      for (let c = 0; c < f.columns; c++) {
        const tiles = column(f, c);
        for (let i = 1; i < tiles.length; i++) {
          expect(tiles[i].y - (tiles[i - 1].y + tiles[i - 1].h)).toBe(NAV_TILE_GAP);
        }
      }
    }
    expect(NAV_TILE_GAP).toBeGreaterThan(9);
    expect(NAV_PAD_TOP).toBeGreaterThan(9);
  });

  it("keeps every cluster in its own board column when the columns fit", () => {
    const f = navigatorFrame(board([[7, 3, 0], [0, 0, 5, 3]]), 436, "tiles");
    expect(f.columns, "two board columns, two navigator columns at 436px").toBe(2);
    expect(f.merges).toBe(0);
    for (const t of f.tiles) expect(t.col, t.sessionId).toBe(t.boardCol);
    // And in the board's order, top to bottom.
    expect(column(f, 0).map(t => t.sessionId)).toEqual(["c0r0", "c0r1", "c0r2"]);
    expect(column(f, 1).map(t => t.sessionId)).toEqual(["c1r0", "c1r1", "c1r2", "c1r3"]);
  });

  it("does not split a board column across navigator columns, however wide the navigator", () => {
    const f = navigatorFrame(board([[2, 0, 9, 1, 0, 0]]), 1000, "tiles");
    expect(f.columns).toBe(1);
    expect(new Set(f.tiles.map(t => t.col))).toEqual(new Set([0]));
  });

  it("merges columns pairwise and in order when they do not fit, and moves no cluster past another", () => {
    for (const { name, columns } of SHAPES) {
      for (const navW of WIDTHS) {
        const f = navigatorFrame(board(columns), navW, "tiles");
        expect(f.columns, `${name} at ${navW}px`).toBeLessThanOrEqual(fitColumns(navW));
        // Pairwise, `merges` times: board columns 2k and 2k+1 become one.
        for (const t of f.tiles) expect(t.col, `${name} ${t.sessionId} at ${navW}px`).toBe(t.boardCol >> f.merges);
        // Each navigator column reads down its board columns in order — the
        // left one first — and keeps every cluster's place inside them.
        for (let c = 0; c < f.columns; c++) {
          const ids = column(f, c).map(t => t.sessionId);
          const expected = [...ids].sort((a, b) => {
            const [ca, ra] = a.slice(1).split("r").map(Number);
            const [cb, rb] = b.slice(1).split("r").map(Number);
            return ca - cb || ra - rb;
          });
          expect(ids, `${name} at ${navW}px, column ${c}`).toEqual(expected);
        }
      }
    }
  });

  it("merges five board columns into two at the prototype's 436px", () => {
    const f = navigatorFrame(board([[1], [0, 4], [2, 2, 2], [0], [6, 0]]), 436, "tiles");
    expect(f.merges).toBe(2);
    expect(f.columns).toBe(2);
    expect(column(f, 0).map(t => t.boardCol)).toEqual([0, 1, 1, 2, 2, 2, 3]);
    expect(column(f, 1).map(t => t.boardCol)).toEqual([4, 4]);
  });

  it("reads a board column left empty as no column at all", () => {
    // Columns 0 and 3 only — the sessions between went away.
    const f = navigatorFrame([
      { sessionId: "a", col: 0, rows: 0 },
      { sessionId: "b", col: 3, rows: 1 },
    ], 436, "tiles");
    expect(f.columns).toBe(2);
    expect(f.tiles.map(t => [t.sessionId, t.col])).toEqual([["a", 0], ["b", 1]]);
  });

  it("orders a column by the place each cluster was given, not by the order it was handed in", () => {
    const f = navigatorFrame([
      { sessionId: "lower", col: 0, order: 1, rows: 0 },
      { sessionId: "upper", col: 0, order: 0, rows: 2 },
    ], 436, "tiles");
    expect(f.tiles.map(t => t.sessionId)).toEqual(["upper", "lower"]);
    expect(f.tiles[0].y).toBeLessThan(f.tiles[1].y);
  });

  it("keeps every tile inside the navigator's width", () => {
    for (const { columns } of SHAPES) {
      for (const navW of WIDTHS) {
        for (const density of ["tiles", "rail"] as const) {
          for (const t of navigatorFrame(board(columns), navW, density).tiles) {
            expect(t.x).toBeGreaterThanOrEqual(NAV_PAD_X);
            expect(t.x + t.w, `${t.sessionId} at ${navW}px, ${density}`).toBeLessThanOrEqual(navW - NAV_PAD_X);
          }
        }
      }
    }
  });

  it("gives a tile column at least the narrowest a face reads at, and no more than the widest", () => {
    for (const navW of WIDTHS.filter(w => w >= TILE_MIN_W + NAV_PAD_X * 2)) {
      const f = navigatorFrame(board([[1], [2], [3], [4]]), navW, "tiles");
      expect(f.tileW, `${navW}px`).toBeGreaterThanOrEqual(TILE_MIN_W);
      expect(f.tileW, `${navW}px`).toBeLessThanOrEqual(TILE_MAX_W);
    }
    expect(navigatorFrame(board([[1]]), 1000, "tiles").tileW).toBe(TILE_MAX_W);
  });

  it("answers how many tile columns fit at the widths stage-geometry hands out", () => {
    expect(fitColumns(168)).toBe(1);
    expect(fitColumns(320)).toBe(1);
    expect(fitColumns(436)).toBe(2);
    expect(fitColumns(700)).toBe(3);
    expect(fitColumns(0), "a navigator too narrow for any still draws one").toBe(1);
  });

  it("spaces columns by the column gap", () => {
    const f = navigatorFrame(board([[0], [0]]), 436, "tiles");
    const [a, b] = f.tiles;
    expect(b.x - (a.x + a.w)).toBe(NAV_COL_GAP);
  });
});

describe("a tile is as tall as what it holds", () => {
  it("draws subagent rows no shorter than 22px, one under another, under the face", () => {
    expect(ROW_H).toBeGreaterThanOrEqual(22);
    expect(ROW_PITCH).toBeGreaterThanOrEqual(ROW_H);
    for (const { columns } of SHAPES) {
      for (const t of navigatorFrame(board(columns), 436, "tiles").tiles) {
        if (t.rows.length === 0) continue;
        expect(t.rows[0], t.sessionId).toBeGreaterThanOrEqual(TILE_PAD + FACE_H);
        for (let i = 1; i < t.rows.length; i++) expect(t.rows[i] - t.rows[i - 1]).toBeGreaterThanOrEqual(ROW_H);
        expect(t.rows.at(-1)! + ROW_H, t.sessionId).toBeLessThanOrEqual(t.h);
      }
    }
  });

  it("ends a tile its padding below its last row, and a face-only tile its padding below the face", () => {
    for (const { columns } of SHAPES) {
      const flat = columns.flat();
      const f = navigatorFrame(board(columns), 436, "tiles");
      for (const t of f.tiles) {
        const [c, r] = t.sessionId.slice(1).split("r").map(Number);
        expect(t.rows.length, t.sessionId).toBe(columns[c][r]);
        const content = t.rows.length ? t.rows.at(-1)! + ROW_H + TILE_PAD_BOTTOM : TILE_PAD + FACE_H + TILE_PAD;
        expect(t.h, t.sessionId).toBe(content);
      }
      expect(f.tiles.length).toBe(flat.length);
    }
  });

  it("is the prototype's 64px face and 67 + 25px a row", () => {
    expect(tileHeight(0, "tiles")).toBe(64);
    expect(tileHeight(1, "tiles")).toBe(92);
    expect(tileHeight(7, "tiles")).toBe(242);
    expect(tileHeight(7, "rail"), "the rail draws the face alone").toBe(64);
  });

  it("stands as tall as its tallest column, padding included, and is empty with no sessions", () => {
    const f = navigatorFrame(board([[7, 3, 0], [0, 0, 5, 3]]), 436, "tiles");
    const bottom = Math.max(...f.tiles.map(t => t.y + t.h));
    expect(f.height).toBe(bottom + NAV_PAD_BOTTOM);
    expect(Math.min(...f.tiles.map(t => t.y))).toBe(NAV_PAD_TOP);
    const empty = navigatorFrame([], 436, "tiles");
    expect(empty.tiles).toEqual([]);
    expect(empty.height).toBe(0);
  });
});

describe("the rail", () => {
  it("is one column in the board's reading order: down column 0, then column 1", () => {
    const f = navigatorFrame(board([[7, 3, 0], [0, 0, 5, 3]]), 180, "rail");
    expect(f.columns).toBe(1);
    expect(f.tiles.map(t => t.sessionId)).toEqual(["c0r0", "c0r1", "c0r2", "c1r0", "c1r1", "c1r2", "c1r3"]);
    for (let i = 1; i < f.tiles.length; i++) expect(f.tiles[i].y).toBeGreaterThan(f.tiles[i - 1].y);
  });

  it("draws faces only: no rows, every tile the face's height", () => {
    const f = navigatorFrame(board([[7, 3, 0], [0, 0, 5, 3]]), 180, "rail");
    for (const t of f.tiles) {
      expect(t.rows, t.sessionId).toEqual([]);
      expect(t.h).toBe(TILE_PAD * 2 + FACE_H);
      expect(t.col).toBe(0);
    }
  });

  it("prints a face's clock to the minute, leaving the name its room", () => {
    expect(railClock("16m 59s")).toBe("16m");
    expect(railClock("0m 05s")).toBe("0m");
    for (const one of ["353ms", "45s", "1h 12m", "≥ 3m"]) expect(railClock(one), one).toBe(one);
  });

  it("is the same order a pairwise merge to one column gives", () => {
    const shape = board([[1], [0, 4], [2, 2, 2], [0], [6, 0]]);
    const rail = navigatorFrame(shape, 600, "rail").tiles.map(t => t.sessionId);
    const merged = navigatorFrame(shape, 200, "tiles");
    expect(merged.columns).toBe(1);
    expect(rail).toEqual(merged.tiles.map(t => t.sessionId));
  });
});

describe("reading the board's columns off its cluster boxes", () => {
  it("puts boxes that share a left edge in one column, top to bottom, and the next column to their right", () => {
    // layout.ts starts every session of a column at the same x; the next
    // column starts clear of the widest of them.
    const cols = boardColumns([
      { sessionId: "paycore", x: 900, y: 0, w: 300, h: 100 },
      { sessionId: "ccdeck", x: 0, y: 500, w: 700, h: 200 },
      { sessionId: "boom", x: 0, y: 0, w: 640, h: 400 },
      { sessionId: "travel", x: 900, y: 160, w: 300, h: 100 },
    ]);
    expect(cols).toEqual([
      { sessionId: "boom", col: 0, order: 0 },
      { sessionId: "ccdeck", col: 0, order: 1 },
      { sessionId: "paycore", col: 1, order: 0 },
      { sessionId: "travel", col: 1, order: 1 },
    ]);
  });

  it("keeps a box whose span overlaps the column's in that column, as it is drawn", () => {
    // A session pushed a little right by a neighbour that grew is still in the
    // column the reader sees it in.
    const cols = boardColumns([
      { sessionId: "a", x: 0, y: 0, w: 600, h: 100 },
      { sessionId: "b", x: 120, y: 200, w: 300, h: 100 },
      { sessionId: "c", x: 800, y: 0, w: 300, h: 100 },
    ]);
    expect(cols.map(c => [c.sessionId, c.col])).toEqual([["a", 0], ["b", 0], ["c", 1]]);
  });

  it("turns the boxes and the cards behind them into what the frame lays out", () => {
    const sessions = new Map([
      ["a", { sessionId: "a", root: null, subs: [{} as AgentNodeData, {} as AgentNodeData] }],
    ]);
    expect(navigatorClusters([
      { sessionId: "b", x: 900, y: 0, w: 300, h: 100 },
      { sessionId: "a", x: 0, y: 0, w: 300, h: 100 },
    ], sessions)).toEqual([
      { sessionId: "a", col: 0, order: 0, rows: 2 },
      { sessionId: "b", col: 1, order: 0, rows: 0 },
    ]);
  });
});

describe("the arrow keys walk the tiles spatially", () => {
  const f = navigatorFrame(board([[7, 0], [0, 0, 0, 0]]), 436, "tiles");

  it("moves across to the tile at the nearest height in the next column", () => {
    // c0r0 is a tall tile (seven rows); its middle sits beside c1r1 or c1r2.
    const me = f.tiles.find(t => t.sessionId === "c0r0")!;
    const mid = me.y + me.h / 2;
    const right = f.tiles.find(t => t.sessionId === neighbourTile(f, "c0r0", "right"))!;
    for (const t of column(f, 1)) {
      expect(Math.abs(right.y + right.h / 2 - mid)).toBeLessThanOrEqual(Math.abs(t.y + t.h / 2 - mid));
    }
    expect(neighbourTile(f, "c1r0", "left")).toBe("c0r0");
  });

  it("moves up and down within a column, and stops at its ends", () => {
    expect(neighbourTile(f, "c1r0", "down")).toBe("c1r1");
    expect(neighbourTile(f, "c1r1", "up")).toBe("c1r0");
    expect(neighbourTile(f, "c1r0", "up")).toBeNull();
    expect(neighbourTile(f, "c1r3", "down")).toBeNull();
    expect(neighbourTile(f, "c0r0", "left")).toBeNull();
    expect(neighbourTile(f, "c1r0", "right")).toBeNull();
  });

  it("goes nowhere sideways in the rail, which has one column", () => {
    const rail = navigatorFrame(board([[1], [1]]), 200, "rail");
    expect(neighbourTile(rail, "c0r0", "right")).toBeNull();
    expect(neighbourTile(rail, "c0r0", "down")).toBe("c1r0");
  });

  it("answers null for a session that has no tile", () => {
    expect(neighbourTile(f, "nobody", "down")).toBeNull();
  });
});

/** A card as React Flow holds it: the fields the navigator reads, no more. */
function card(id: string, sessionId: string, kind: "root" | "subagent", extra: Partial<AgentNodeData> = {}): AgentNodeData {
  return { id, sessionId, kind, label: id, state: "active", tools: [], ...extra } as AgentNodeData;
}
const node = (data: AgentNodeData, x: number, y: number, type = "agent"): ClusterNode =>
  ({ type, position: { x, y }, width: 240, height: 80, data });

describe("the sessions behind the tiles", () => {
  it("takes each session's root and its subagents in the order they stand on the board", () => {
    const root = card("s1", "s1", "root");
    const low = card("s1::b", "s1", "subagent");
    const high = card("s1::a", "s1", "subagent");
    const sessions = navigatorSessions([node(low, 400, 300), node(root, 0, 100), node(high, 400, 0)]);
    expect(sessions.get("s1")!.root).toBe(root);
    expect(sessions.get("s1")!.subs).toEqual([high, low]);
  });

  it("skips what the cluster box skips: cards on their way out, and anything that is not a card", () => {
    const root = card("s1", "s1", "root");
    const leaving = card("s1::gone", "s1", "subagent", { exitAt: 5 });
    const note = card("note:s1", "s1", "root");
    const sessions = navigatorSessions([node(root, 0, 0), node(leaving, 400, 0), node(note, 0, 200, "recapNote")]);
    expect(sessions.get("s1")!.subs).toEqual([]);
    expect(sessions.get("s1")!.root).toBe(root);
  });

  it("still has a session whose root is not on the board, from its subagents", () => {
    const sub = card("s2::a", "s2", "subagent");
    const sessions = navigatorSessions([node(sub, 0, 0)]);
    expect(sessions.get("s2")).toEqual({ sessionId: "s2", root: null, subs: [sub] });
  });

  it("is the same reading while every card is the same object, and a new one when one changes", () => {
    const root = card("s1", "s1", "root");
    const sub = card("s1::a", "s1", "subagent");
    const a = navigatorSessions([node(root, 0, 0), node(sub, 400, 0)]);
    const b = navigatorSessions([node(sub, 400, 0), node(root, 0, 0)]);
    expect(sameSessions(a, b)).toBe(true);
    const c = navigatorSessions([node(root, 0, 0), node({ ...sub }, 400, 0)]);
    expect(sameSessions(a, c)).toBe(false);
    expect(sameSessions(a, navigatorSessions([node(root, 0, 0)]))).toBe(false);
  });
});

describe("the header's count", () => {
  it("says how many sessions the board holds, in words for none", () => {
    expect(sessionCount(0)).toBe("No sessions");
    expect(sessionCount(1)).toBe("1 session");
    expect(sessionCount(7)).toBe("7 sessions");
  });
});
