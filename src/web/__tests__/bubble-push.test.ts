// A session that spawns eight subagents at once grows in every direction and
// covers whatever was beside it. The old repair slid the covered session
// straight down until it was clear, which threw it half a screen away because
// its neighbour gained 60px. These assert the replacement moves things the
// short way, and that it stays still when nothing grew.
import { describe, it, expect } from "vitest";
import type { Node } from "reactflow";
import { bubblePush } from "../layout";

const W = 260, H = 120;
const CHROME = 18 * 2 + 26 + 12;
const GAP_Y = CHROME + 72;
const GAP_X = 18 * 2 + 24;

function agent(id: string, sessionId: string): Node {
  return { id, position: { x: 0, y: 0 }, data: { sessionId }, width: W, height: H } as Node;
}
const at = (entries: Array<[string, number, number]>) =>
  new Map(entries.map(([id, x, y]) => [id, { x, y }]));

/** Sizes, with per-id overrides for the session under test. */
function sizes(ids: string[], override: Record<string, { width: number; height: number }> = {}) {
  return new Map(ids.map(id => [id, override[id] ?? { width: W, height: H }]));
}

/** Session bounding boxes, inflated by the clearance they must keep. */
function sessionBoxes(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
) {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of nodes) {
    const p = positions.get(n.id)!;
    const m = measured.get(n.id)!;
    const sid = (n.data as { sessionId: string }).sessionId;
    const b = out.get(sid);
    if (!b) { out.set(sid, { x: p.x, y: p.y, w: m.width, h: m.height }); continue; }
    const x = Math.min(b.x, p.x), y = Math.min(b.y, p.y);
    out.set(sid, {
      x, y,
      w: Math.max(b.x + b.w, p.x + m.width) - x,
      h: Math.max(b.y + b.h, p.y + m.height) - y,
    });
  }
  return out;
}

function collidingSessions(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
) {
  const boxes = [...sessionBoxes(nodes, positions, measured).entries()];
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [ka, a] = boxes[i], [kb, b] = boxes[j];
      if (a.x < b.x + b.w + GAP_X && b.x < a.x + a.w + GAP_X &&
          a.y < b.y + b.h + GAP_Y && b.y < a.y + a.h + GAP_Y) hits.push(`${ka} / ${kb}`);
    }
  }
  return hits;
}

describe("bubblePush", () => {
  it("records sizes on the first call and moves nothing", () => {
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = at([["a", 0, 0], ["b", 0, 40]]);   // overlapping on purpose
    const prev = new Map<string, { w: number; h: number }>();

    expect(bubblePush(nodes, pos, new Map(), sizes(["a", "b"]), prev)).toEqual([]);
    expect(pos.get("b")).toEqual({ x: 0, y: 40 });
    expect(prev.size).toBe(2);
  });

  it("does nothing when no session grew", () => {
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = at([["a", 0, 0], ["b", 0, 400]]);
    const m = sizes(["a", "b"]);
    const prev = new Map<string, { w: number; h: number }>();

    bubblePush(nodes, pos, new Map(), m, prev);
    const snapshot = JSON.stringify([...pos]);
    expect(bubblePush(nodes, pos, new Map(), m, prev)).toEqual([]);
    expect(JSON.stringify([...pos])).toBe(snapshot);
  });

  it("pushes the neighbour clear when a session grows into it", () => {
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = at([["a", 0, 0], ["b", 0, 400]]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, new Map(), sizes(["a", "b"]), prev);

    // sa fans out: taller and wider, straight through sb.
    const grown = sizes(["a", "b"], { a: { width: 700, height: 500 } });
    const moved = bubblePush(nodes, pos, new Map(), grown, prev);

    expect(moved).toEqual(["sb"]);
    expect(collidingSessions(nodes, pos, grown)).toEqual([]);
  });

  it("leaves the session that grew where it is", () => {
    // Seeded clear of the origin on purpose. The solver refuses any box at
    // y <= 0 a push that heads further up, so a grower at {0, 0} holds still
    // because of the canvas edge and the mass rule is never consulted — this
    // case passed verbatim against a build with the mass rule deleted.
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = at([["a", 200, 300], ["b", 200, 700]]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, new Map(), sizes(["a", "b"]), prev);

    const grown = sizes(["a", "b"], { a: { width: 700, height: 500 } });
    bubblePush(nodes, pos, new Map(), grown, prev);

    const grower = Math.abs(pos.get("a")!.y - 300);
    const neighbour = Math.abs(pos.get("b")!.y - 700);
    // Mass 8 against mass 1: with room to move in both directions the grower
    // still yields an eighth of what it hands out. Split evenly the two would
    // move the same distance, which is the thing this case exists to catch.
    expect(grower * 4).toBeLessThan(neighbour);
    expect(grower).toBeLessThan(40);
    expect(collidingSessions(nodes, pos, grown)).toEqual([]);
  });

  it("moves the neighbour the short way, not to the bottom of the canvas", () => {
    // `sb` sits off `sa`'s right shoulder, so the short way out is sideways
    // and the long way is down. That matters: separateOverlaps, the algorithm
    // this case exists to reject, resolves on Y alone. On the stacked board
    // this fixture used to carry the two agreed to the pixel — 166.997 against
    // 166.0 — because with one obstacle directly above, the shortest way out
    // and the bottom of that obstacle are the same place. Here they are not:
    // separateOverlaps answers 346px straight down and nothing sideways.
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = at([["a", 200, 200], ["b", 800, 500]]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, new Map(), sizes(["a", "b"]), prev);

    // sa fans out subagents: one 260x120 card becomes a 700x500 cluster.
    const grown = sizes(["a", "b"], { a: { width: 700, height: 500 } });
    bubblePush(nodes, pos, new Map(), grown, prev);

    const dx = pos.get("b")!.x - 800, dy = pos.get("b")!.y - 500;
    expect(dx).toBeGreaterThan(0);
    expect(dx).toBeLessThan(200);                      // nudged, not exiled
    expect(Math.abs(dy)).toBeLessThan(1);              // and not slid to the bottom
    expect(collidingSessions(nodes, pos, grown)).toEqual([]);
  });

  it("never moves a session holding a node the user dragged", () => {
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = at([["a", 0, 0]]);
    const pinned = at([["b", 0, 400]]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, pinned, sizes(["a", "b"]), prev);

    const grown = sizes(["a", "b"], { a: { width: W, height: H + 300 } });
    const moved = bubblePush(nodes, pos, pinned, grown, prev);

    expect(pinned.get("b")).toEqual({ x: 0, y: 400 });   // untouched
    expect(moved).toEqual(["sa"]);                       // the grower yields instead
    expect(collidingSessions(nodes, new Map([...pos, ...pinned]), grown)).toEqual([]);
  });

  it("keeps a session's cards in the same arrangement relative to each other", () => {
    const nodes = [agent("a1", "sa"), agent("b1", "sb"), agent("b2", "sb")];
    const pos = at([["a1", 0, 0], ["b1", 0, 400], ["b2", 300, 430]]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, new Map(), sizes(["a1", "b1", "b2"]), prev);

    bubblePush(nodes, pos, new Map(), sizes(["a1", "b1", "b2"], { a1: { width: W, height: 600 } }), prev);

    const b1 = pos.get("b1")!, b2 = pos.get("b2")!;
    expect(b1.y).toBeGreaterThan(400);   // sb was actually moved, not just left alone
    expect(b2.x - b1.x).toBe(300);
    expect(b2.y - b1.y).toBe(30);
  });

  it("resolves a three-session pile-up without leaving any pair overlapping", () => {
    const nodes = [agent("a", "sa"), agent("b", "sb"), agent("c", "sc")];
    const pos = at([["a", 0, 0], ["b", 0, 400], ["c", 0, 800]]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, new Map(), sizes(["a", "b", "c"]), prev);

    const grown = sizes(["a", "b", "c"], { a: { width: W, height: 900 } });
    bubblePush(nodes, pos, new Map(), grown, prev);

    expect(collidingSessions(nodes, pos, grown)).toEqual([]);
  });

  it("is deterministic — same input, same output", () => {
    const start: Array<[string, number, number]> = [["a", 0, 0], ["b", 0, 400], ["c", 0, 800]];
    const build = () => {
      const nodes = [agent("a", "sa"), agent("b", "sb"), agent("c", "sc")];
      const pos = at(start);
      const prev = new Map<string, { w: number; h: number }>();
      bubblePush(nodes, pos, new Map(), sizes(["a", "b", "c"]), prev);
      bubblePush(nodes, pos, new Map(), sizes(["a", "b", "c"], { a: { width: 800, height: 900 } }), prev);
      return JSON.stringify([...pos]);
    };
    expect(build()).toBe(build());
    // A board it never touched would also agree with itself.
    expect(build()).not.toBe(JSON.stringify([...at(start)]));
  });

  it("never pushes a session off the top-left corner", () => {
    // The push has to actually aim at the corner or the clamp means nothing.
    // A top-left-anchored box grows down and right, so growth can never reach
    // a neighbour above or left of it — the fixture this used to carry seeded
    // `sa` below `sb` and grew it, which produced no collision at all and no
    // call to the solver. What does aim at the corner is a crossed board with
    // nothing growing: area decides who yields, so the one-card session tucked
    // at {20, 20} is driven at the edge with 20px of room and a first push of
    // more than a hundred — without the clamp it lands at -95.8. It has to
    // stop ON the edge, and the rest of the push has to go to the big session
    // rather than into the clamp.
    const corner = (tall: Array<[string, number, number]>) => {
      const nodes = [agent("t1", "tall"), agent("t2", "tall"), agent("t3", "tall"),
                     agent("s1", "small")];
      const pos = at([...tall, ["s1", 20, 20]]);
      const m = sizes(["t1", "t2", "t3", "s1"]);
      const prev = new Map<string, { w: number; h: number }>();
      expect(collidingSessions(nodes, pos, m)).not.toEqual([]);
      bubblePush(nodes, pos, new Map(), m, prev);   // records only
      bubblePush(nodes, pos, new Map(), m, prev);
      return { s1: pos.get("s1")!, hits: collidingSessions(nodes, pos, m) };
    };

    // Driven at the top edge.
    const up = corner([["t1", 150, 100], ["t2", 150, 500], ["t3", 150, 900]]);
    expect(up.s1.y).toBeLessThan(20);              // pushed toward the corner
    expect(up.s1.y).toBeGreaterThanOrEqual(0);     // and not through it
    expect(up.s1.x).toBeGreaterThanOrEqual(0);
    expect(up.hits).toEqual([]);                   // the overlap resolved anyway

    // Driven at the left edge.
    const left = corner([["t1", 300, 100], ["t2", 300, 500], ["t3", 300, 900]]);
    expect(left.s1.x).toBeLessThan(20);
    expect(left.s1.x).toBeGreaterThanOrEqual(0);
    expect(left.s1.y).toBeGreaterThanOrEqual(0);
    expect(left.hits).toEqual([]);
  });

  it("forgets sessions that are gone so their ids can be reused", () => {
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush([agent("a", "sa"), agent("b", "sb")], at([["a", 0, 0], ["b", 0, 400]]),
               new Map(), sizes(["a", "b"]), prev);
    expect([...prev.keys()].sort()).toEqual(["sa", "sb"]);

    bubblePush([agent("a", "sa")], at([["a", 0, 0]]), new Map(), sizes(["a"]), prev);
    expect([...prev.keys()]).toEqual(["sa"]);
  });
});

describe("bubblePush — boxes that cross without anything growing", () => {
  // Reported with a screenshot: three small session boxes drawn straight
  // through a twenty-card one. separateOverlaps had kept every CARD apart, and
  // it had — the small sessions were sitting in the vertical gaps between the
  // big session's cards. What crossed was the BOX drawn around each session,
  // which separateOverlaps never looks at, and bubblePush skipped because
  // nothing had grown that frame.
  const settle = (
    nodes: Node[],
    pos: Map<string, { x: number; y: number }>,
    m: Map<string, { width: number; height: number }>,
    prev: Map<string, { w: number; h: number }>,
  ) => {
    // First call only records — the production gate for "measurement is still
    // arriving" — so the assertions are about the second.
    bubblePush(nodes, pos, new Map(), m, prev);
    return bubblePush(nodes, pos, new Map(), m, prev);
  };

  it("separates a small session sitting inside a tall one's box", () => {
    // "tall" spans y 0..1000 in one column; "small" sits beside it in the gap
    // between two of its cards, touching neither.
    const nodes = [
      agent("t1", "tall"), agent("t2", "tall"), agent("t3", "tall"),
      agent("s1", "small"),
    ];
    const pos = at([
      ["t1", 600, 0], ["t2", 600, 400], ["t3", 600, 880],
      ["s1", 300, 250],   // no card overlap: t1 ends at 120, t2 starts at 400
    ]);
    const m = sizes(["t1", "t2", "t3", "s1"]);
    const prev = new Map<string, { w: number; h: number }>();

    expect(collidingSessions(nodes, pos, m)).not.toEqual([]);
    const moved = settle(nodes, pos, m, prev);
    expect(moved).not.toEqual([]);
    expect(collidingSessions(nodes, pos, m)).toEqual([]);
  });

  it("moves the small session rather than the big one", () => {
    // Nothing grew, so there is no culprit; area decides who yields. Shoving
    // the twenty-card session aside would rearrange far more of the canvas.
    const nodes = [
      agent("t1", "tall"), agent("t2", "tall"), agent("t3", "tall"),
      agent("s1", "small"),
    ];
    const pos = at([
      ["t1", 600, 0], ["t2", 600, 400], ["t3", 600, 880],
      ["s1", 300, 250],
    ]);
    const m = sizes(["t1", "t2", "t3", "s1"]);
    const prev = new Map<string, { w: number; h: number }>();
    settle(nodes, pos, m, prev);

    const tallShift = Math.abs(pos.get("t1")!.x - 600) + Math.abs(pos.get("t1")!.y - 0);
    const smallShift = Math.abs(pos.get("s1")!.x - 300) + Math.abs(pos.get("s1")!.y - 250);
    expect(smallShift).toBeGreaterThan(tallShift);
  });

  it("still stays put when the boxes are already clear", () => {
    // The gate that keeps this from running on every frame of a healthy board.
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = at([["a", 0, 0], ["b", 0, 800]]);
    const m = sizes(["a", "b"]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, new Map(), m, prev);
    const before = JSON.stringify([...pos]);
    expect(bubblePush(nodes, pos, new Map(), m, prev)).toEqual([]);
    expect(JSON.stringify([...pos])).toBe(before);
  });

  it("leaves a session the user dragged where they put it", () => {
    const nodes = [agent("t1", "tall"), agent("t2", "tall"), agent("s1", "small")];
    const pos = at([["t1", 600, 0], ["t2", 600, 400], ["s1", 300, 250]]);
    const m = sizes(["t1", "t2", "s1"]);
    const pinned = new Map([["s1", { x: 300, y: 250 }]]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, pos, pinned, m, prev);
    const moved = bubblePush(nodes, pos, pinned, m, prev);
    expect(pos.get("s1")).toEqual({ x: 300, y: 250 });
    expect(moved).toEqual(["tall"]);   // the push routed around them, not nowhere
  });
});

// An agent gaining a burst lane is the most common way a session on this canvas
// gets bigger — 420px wider, up to 150px taller — and it is the one growth the
// size test could not see, because `measured` holds React Flow nodes and bursts
// are an overlay. So a session quietly grew a wall of chips over its neighbour
// and, by its own accounting, nothing had changed size.
describe("bubblePush — a lane is growth", () => {
  const LANE_W = 420;
  const laneH = (n: number) => (n > 0 ? 6 + n * 36 : 0);

  const foot = (p: { x: number; y: number }, lane: number) => ({
    x: p.x, y: p.y,
    w: W + (lane > 0 ? LANE_W : 0),
    h: Math.max(H, laneH(lane)),
  });
  type Rect = ReturnType<typeof foot>;
  const clear = (a: Rect, b: Rect) =>
    !(a.x < b.x + b.w + GAP_X && b.x < a.x + a.w + GAP_X &&
      a.y < b.y + b.h + GAP_Y && b.y < a.y + a.h + GAP_Y);

  /**
   * `sb` sits beside `sa`: clear of its card, inside where its chips will be.
   *
   * Seeded clear of the origin. A box at x <= 0 or y <= 0 is refused a push
   * that heads further out, so on a board anchored at {0, 0} the canvas edge
   * holds the grower still and every case below that credits the mass rule for
   * it is reading the edge instead.
   */
  const board = () => ({
    nodes: [agent("a", "sa"), agent("b", "sb")],
    pos: at([["a", 200, 300], ["b", 600, 500]]),
    m: sizes(["a", "b"]),
    prev: new Map<string, { w: number; h: number }>(),
  });

  it("still does nothing while neither agent has called a tool", () => {
    const { nodes, pos, m, prev } = board();
    bubblePush(nodes, pos, new Map(), m, prev);
    expect(bubblePush(nodes, pos, new Map(), m, prev)).toEqual([]);
    expect(pos.get("b")).toEqual({ x: 600, y: 500 });
  });

  it("pushes the neighbour out of the chips when an agent gains a lane", () => {
    const { nodes, pos, m, prev } = board();
    bubblePush(nodes, pos, new Map(), m, prev);

    const lanes = new Map([["a", 4]]);
    const moved = bubblePush(nodes, pos, new Map(), m, prev, false, lanes);

    expect(moved).toEqual(["sa", "sb"]);
    expect(clear(foot(pos.get("a")!, 4), foot(pos.get("b")!, 0))).toBe(true);
  });

  it("lets the session whose lane grew hold its ground", () => {
    // The lane is the culprit, so its session is the heavy one — the same rule
    // that applies when a session fans out subagents. Both sessions have room
    // to move here, so the split between them is the mass rule's answer and
    // nothing else's.
    const { nodes, pos, m, prev } = board();
    bubblePush(nodes, pos, new Map(), m, prev);
    bubblePush(nodes, pos, new Map(), m, prev, false, new Map([["a", 4]]));

    const grower = Math.abs(pos.get("a")!.y - 300);
    const neighbour = Math.abs(pos.get("b")!.y - 500);
    expect(neighbour).toBeGreaterThan(0);              // something did move
    expect(grower * 4).toBeLessThan(neighbour);        // and it was mostly the neighbour
    expect(grower).toBeLessThan(20);
  });

  it("settles — a second call with the same lanes moves nothing", () => {
    const { nodes, pos, m, prev } = board();
    const lanes = new Map([["a", 4]]);
    bubblePush(nodes, pos, new Map(), m, prev);
    expect(bubblePush(nodes, pos, new Map(), m, prev, false, lanes)).toEqual(["sa", "sb"]);
    const after = JSON.stringify([...pos]);
    expect(bubblePush(nodes, pos, new Map(), m, prev, false, lanes)).toEqual([]);
    expect(JSON.stringify([...pos])).toBe(after);
  });
});
