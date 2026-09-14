// Reported with a screenshot: eight sessions stacked in one column several
// screens tall, drawn at a third of their size, beside an empty right half of
// the canvas. Three things kept the board in one column, and each is pinned
// here by the geometry it produces rather than by how it is computed:
//
//   - autoLayout capped itself at two columns, and took even the second only
//     when both fitted the canvas at full size. One session fanning out, or a
//     canvas a few pixels narrower than two columns, sent everything to one.
//   - A session that arrived later could only drop into a gap in a column that
//     already existed, or below it — never into a new column.
//   - A subagent took its slot from a layout from scratch, which does not know
//     where its session was actually put.
import { describe, it, expect } from "vitest";
import type { Edge, Node } from "reactflow";
import { autoLayout, fillGapsWithNewSessions, joinSessions, separateOverlaps } from "../layout";

const W = 260, H = 120;
const LANE = 420;                          // TOOL_LANE_W, the burst lane beside a card
const CHROME = 18 * 2 + 26 + 12;           // cluster padding, header and label tab
const PITCH = H + CHROME + 72;             // one session under the next

/** The frame fitLeft shows the board in on a 1760 x 929 canvas: margins off, then the fill. */
const FRAME = { width: (1760 - 160) * 0.86, height: (929 - 160) * 0.86 };

type Point = { x: number; y: number };

function agent(id: string, sessionId: string, parentId?: string): Node {
  return { id, position: { x: 0, y: 0 }, data: { sessionId, parentId }, width: W, height: H } as Node;
}
const sizes = (nodes: Node[]) => new Map(nodes.map(n => [n.id, { width: W, height: H }]));
const sessions = (n: number) => Array.from({ length: n }, (_, i) => agent(`s${i}n0`, `s${i}`));
const at = (out: Node[], id: string) => out.find(n => n.id === id)!.position;

/** The zoom fitLeft would show these cards at: their extents plus the lane it leaves. */
function fitZoom(points: Point[], frame = FRAME): number {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const w = Math.max(...xs) + W - Math.min(...xs) + LANE;
  const h = Math.max(...ys) + H - Math.min(...ys);
  return Math.min(1, frame.width / w, frame.height / h);
}

/** Every pair of cards that share canvas area. */
function overlaps(points: Map<string, Point>): string[] {
  const ids = [...points.keys()];
  const hits: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = points.get(ids[i])!, b = points.get(ids[j])!;
      if (a.x < b.x + W && b.x < a.x + W && a.y < b.y + H && b.y < a.y + H) hits.push(`${ids[i]} / ${ids[j]}`);
    }
  }
  return hits;
}

describe("autoLayout spreads the board across the canvas", () => {
  const onFrame = (nodes: Node[]) =>
    ({ measured: sizes(nodes), availableWidth: FRAME.width, availableHeight: FRAME.height });

  it("takes a second column when one does not fit, even though two are wider than the frame", () => {
    // Eight sessions are 1982 tall in one column. Two columns are 1620 wide
    // against a 1376 frame, and that alone used to send all eight into the one
    // column, shown at a third of their size.
    const nodes = sessions(8);
    const out = autoLayout(nodes, [], onFrame(nodes));
    const columns = [...new Set(out.map(n => n.position.x))].sort((a, b) => a - b);
    expect(columns).toHaveLength(2);
    // Read down, then across: the first four fill the first column.
    for (const id of ["s0n0", "s1n0", "s2n0", "s3n0"]) expect(at(out, id).x).toBe(columns[0]);
    // What the change is for: more than twice the zoom of the single column.
    const single = autoLayout(nodes, [], { measured: sizes(nodes) });
    expect(fitZoom(out.map(n => n.position))).toBeGreaterThan(2 * fitZoom(single.map(n => n.position)));
  });

  it("keeps spreading when one session fans out to subagents", () => {
    // The reported board: a session with three subagents is 680 wide, its
    // column plus one more no longer fitted the frame, and every session went
    // back into one strip.
    const kids = [1, 2, 3].map(i => agent(`s0n${i}`, "s0", "s0n0"));
    const nodes = [agent("s0n0", "s0"), ...kids, ...sessions(6).slice(1)];
    const edges: Edge[] = kids.map(k => ({ id: `e-${k.id}`, source: "s0n0", target: k.id }));
    const out = autoLayout(nodes, edges, onFrame(nodes));
    const roots = new Set(out.filter(n => n.id.endsWith("n0")).map(n => n.position.x));
    expect(roots.size).toBeGreaterThan(1);
    expect(overlaps(new Map(out.map(n => [n.id, n.position])))).toEqual([]);
  });

  it("stops adding columns once the cards are shown at full size", () => {
    // The cap of two was there so a wide canvas would not split a board into
    // thin columns and shrink it. Scoring by zoom refuses that on its own: past
    // full size nothing gets bigger, and a tie goes to fewer columns.
    const nodes = sessions(6);
    const out = autoLayout(nodes, [], { measured: sizes(nodes), availableWidth: 9000, availableHeight: 400 });
    expect(new Set(out.map(n => n.position.x)).size).toBe(3);
  });

  it("stays one column on a canvas taller than the board", () => {
    const nodes = sessions(6);
    const out = autoLayout(nodes, [], { measured: sizes(nodes), availableWidth: 700, availableHeight: 3000 });
    expect(new Set(out.map(n => n.position.x)).size).toBe(1);
  });
});

describe("a session that arrives later goes where the board has room", () => {
  /** A column of `n` sessions at x = 0, stacked the way autoLayout stacks them. */
  const column = (n: number) => {
    const nodes = sessions(n);
    return { nodes, positions: new Map<string, Point>(nodes.map((node, i) => [node.id, { x: 0, y: i * PITCH }])) };
  };
  // The pitch autoLayout leaves between two columns: card, lane, one card of gap.
  const NEXT_COLUMN = W + LANE + W;

  it("starts a new column once the only one is taller than the frame", () => {
    const { nodes, positions } = column(4);
    const all = [...nodes, agent("new", "snew")];
    positions.set("new", { x: 0, y: 4 * PITCH });   // the foot of the column
    const moved = fillGapsWithNewSessions(all, positions, new Map(), sizes(all), new Set(["new"]), undefined, FRAME);
    expect(moved).toEqual(["snew"]);
    expect(positions.get("new")).toEqual({ x: NEXT_COLUMN, y: 0 });
  });

  it("fills a column down while the board still fits the frame at full size", () => {
    const { nodes, positions } = column(1);
    const all = [...nodes, agent("new", "snew")];
    positions.set("new", { x: 5000, y: 5000 });
    fillGapsWithNewSessions(all, positions, new Map(), sizes(all), new Set(["new"]), undefined, FRAME);
    expect(positions.get("new")).toEqual({ x: 0, y: PITCH });
  });

  it("still takes a vacated hole before growing the board either way", () => {
    // s1 finished and was pruned. The hole costs the fit nothing; the foot of
    // the column and a new column both cost it something.
    const positions = new Map<string, Point>([["s0n0", { x: 0, y: 0 }], ["s2n0", { x: 0, y: 2 * PITCH }]]);
    const all = [agent("s0n0", "s0"), agent("s2n0", "s2"), agent("new", "snew")];
    positions.set("new", { x: 0, y: 3 * PITCH });
    const frame = { width: FRAME.width, height: 500 };
    fillGapsWithNewSessions(all, positions, new Map(), sizes(all), new Set(["new"]), undefined, frame);
    expect(positions.get("new")).toEqual({ x: 0, y: PITCH });
  });

  it("goes under the shorter column once the board is as wide as the frame allows", () => {
    // Bound by its width, the board shows every slot under it at one zoom. The
    // tie used to go to the leftmost column's foot, however much taller than
    // its neighbour that column already was — seen on a live board whose one
    // subagent had made it width-bound.
    const positions = new Map<string, Point>([
      ["s0n0", { x: 0, y: 0 }], ["s1n0", { x: 0, y: PITCH }], ["s2n0", { x: 0, y: 2 * PITCH }],
      ["s3n0", { x: NEXT_COLUMN, y: 0 }],
    ]);
    const all = [...sessions(4), agent("new", "snew")];
    positions.set("new", { x: 0, y: 3 * PITCH });
    const frame = { width: 1000, height: FRAME.height };
    fillGapsWithNewSessions(all, positions, new Map(), sizes(all), new Set(["new"]), undefined, frame);
    expect(positions.get("new")).toEqual({ x: NEXT_COLUMN, y: PITCH });
  });

  it("keeps a board of arrivals clear of itself and wider than one column", () => {
    const nodes: Node[] = [];
    const positions = new Map<string, Point>();
    for (let i = 0; i < 12; i++) {
      const n = agent(`s${i}n0`, `s${i}`);
      nodes.push(n);
      positions.set(n.id, i === 0 ? { x: 0, y: 0 } : { x: 0, y: 99_999 });
      fillGapsWithNewSessions(nodes, positions, new Map(), sizes(nodes), new Set([n.id]), undefined, FRAME);
    }
    expect(overlaps(positions)).toEqual([]);
    expect(new Set([...positions.values()].map(p => p.x)).size).toBeGreaterThan(1);
    const single = nodes.map((_, i) => ({ x: 0, y: i * PITCH }));
    expect(fitZoom([...positions.values()])).toBeGreaterThan(2 * fitZoom(single));
  });
});

describe("a subagent lands beside the session it joined", () => {
  const family = () => {
    const nodes = [agent("r", "s"), agent("c1", "s", "r"), agent("c2", "s", "r")];
    const edges: Edge[] = [
      { id: "e1", source: "r", target: "c1" },
      { id: "e2", source: "r", target: "c2" },
    ];
    return { nodes, edges, measured: sizes(nodes) };
  };

  it("moves with its session when the session has been moved", () => {
    // The session was dropped into a new column; a layout from scratch still
    // has it at the origin.
    const { nodes, edges, measured } = family();
    const scratch = autoLayout(nodes, edges, { measured });
    const real: Point = { x: 2000, y: 800 };
    const out = joinSessions(scratch, new Map(), id => (id === "r" ? real : undefined));
    for (const id of ["c1", "c2"]) {
      expect(at(out, id).x - real.x).toBe(at(scratch, id).x - at(scratch, "r").x);
      expect(at(out, id).y - real.y).toBe(at(scratch, id).y - at(scratch, "r").y);
    }
    // A rank to the right of its parent — not below it, not to its left.
    expect(at(out, "c1").x).toBeGreaterThan(real.x + W);
  });

  it("follows its parent rather than a sibling that was moved on its own", () => {
    const { nodes, edges, measured } = family();
    const scratch = autoLayout(nodes, edges, { measured });
    const placed = new Map<string, Point>([["r", { x: 2000, y: 800 }], ["c1", { x: 6000, y: 6000 }]]);
    const out = joinSessions(scratch, new Map(), id => placed.get(id));
    expect(at(out, "c2").x - 2000).toBe(at(scratch, "c2").x - at(scratch, "r").x);
    expect(at(out, "c2").y - 800).toBe(at(scratch, "c2").y - at(scratch, "r").y);
  });

  it("leaves a brand-new session where the layout put it", () => {
    const { nodes, edges, measured } = family();
    const scratch = autoLayout(nodes, edges, { measured });
    expect(joinSessions(scratch, new Map(), () => undefined)).toEqual(scratch);
  });

  it("neither anchors on nor moves a card the user dragged", () => {
    // A pin is not laid out, so its scratch position is the pin itself and
    // says nothing about where the rest of the session went.
    const { nodes, edges, measured } = family();
    const pinned = new Map<string, Point>([["r", { x: 3000, y: 3000 }]]);
    const scratch = autoLayout(nodes, edges, { measured, pinned });
    expect(joinSessions(scratch, pinned, id => pinned.get(id))).toEqual(scratch);
  });
});

describe("the passes together, in the order App runs them", () => {
  /** snapshotToFlow's layout branch: place what has no position, then repair. */
  function pass(nodes: Node[], edges: Edge[], positions: Map<string, Point>) {
    const measured = sizes(nodes);
    const pinned = new Map<string, Point>();
    const missing = nodes.filter(n => !positions.has(n.id));
    if (missing.length === 0) return;
    const laidOut = joinSessions(
      autoLayout(nodes, edges, {
        direction: "LR", pinned, measured, availableWidth: FRAME.width, availableHeight: FRAME.height,
      }),
      pinned,
      id => positions.get(id),
    );
    for (const n of laidOut) if (!positions.has(n.id)) positions.set(n.id, n.position);
    fillGapsWithNewSessions(nodes, positions, pinned, measured, new Set(missing.map(n => n.id)), undefined, FRAME);
    separateOverlaps(nodes, positions, pinned, measured);
  }

  it("grows a live board sideways, and keeps a subagent beside its parent", () => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const positions = new Map<string, Point>();
    // Sessions start one at a time, the way they do.
    for (let i = 0; i < 8; i++) {
      nodes.push(agent(`s${i}n0`, `s${i}`));
      pass(nodes, edges, positions);
    }
    expect(new Set(nodes.map(n => positions.get(n.id)!.x)).size).toBeGreaterThan(1);
    expect(overlaps(positions)).toEqual([]);

    // s3 opened the second column, at its top. A layout from scratch of the
    // whole board has it at the foot of the first, which is where its
    // subagents used to be sent.
    const parent = positions.get("s3n0")!;
    const scratch = autoLayout(nodes, edges, {
      measured: sizes(nodes), availableWidth: FRAME.width, availableHeight: FRAME.height,
    });
    expect(at(scratch, "s3n0")).not.toEqual(parent);

    for (const k of [1, 2]) {
      nodes.push(agent(`s3n${k}`, "s3", "s3n0"));
      edges.push({ id: `e${k}`, source: "s3n0", target: `s3n${k}` });
      pass(nodes, edges, positions);
    }
    expect(positions.get("s3n0")).toEqual(parent);
    for (const k of [1, 2]) {
      const child = positions.get(`s3n${k}`)!;
      expect(child.x - parent.x).toBe(W + 160);                    // one rank to its right
      expect(Math.abs(child.y - parent.y)).toBeLessThan(2 * (H + 70));
    }
    expect(overlaps(positions)).toEqual([]);
  });
});
