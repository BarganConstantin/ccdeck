// The board flows into columns, in the rail's order (V4 critique, round 2).
//
// Seven sessions stood in one narrow column at the left of a 1440x900 board,
// most of it empty, and the fit drew them at 20-33%. The packer charged every
// column its widest session, the tool lane AND a whole card of gap, and charged
// the last column's lane even at zooms where the fit draws no bubbles; a
// session fanned out to subagents is about 1,380 units wide, so a second column
// cost more than the frame is wide, and one column always scored best. It also
// tried only the evenest cut per count, which put two wide sessions side by
// side.
//
// What was approved:
//   - cards flow down a column and then into the next, in the rail's order;
//   - as many columns as show every card largest, at most four, and one while
//     one column already shows the board at 60% or more;
//   - a column's pitch is its cards and the lane their bubbles take at full
//     size, so zooming into a card never reaches the next column;
//   - the whole board flows only on a fresh board's first layout and on R —
//     never on a zoom, a panel or a window resize, and never because a session
//     came or went: that moved every card each time, and with auto hide on it
//     was the cards walking the board of #2291 again. A session arriving takes
//     the board's next place — a hole, a column's foot, or a new column, at
//     most four — and moves no other card; one coming back from auto hide goes
//     home (hide-finished-place-2291.test.ts). A dragged card keeps its place,
//     a stored board keeps its places, and R's Undo still puts the old board
//     back.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import { attentionOrder } from "../board-order";
import { snapshotToFlow, type BoardFlow } from "../canvas-flow";
import { autoLayout, fillGapsWithNewSessions } from "../layout";
import { COLUMN_GAP, MAX_COLUMNS, SESSION_GAP, sessionOfNode, TOOL_LANE_W } from "../layout-geometry";
import { initialState, type GraphState } from "../reducer";
import { fitZoomForDrawnLanes } from "../semantic-zoom";
import type { AgentNodeData, ToolCall } from "../types";

const W = 260, H = 84;
const NOTE_W = 240, NOTE_H = 120;
type Point = { x: number; y: number };
type Frame = { width: number; height: number };

/** The frame fitLeft shows the board in: the canvas between the two stripes,
 *  less the fit's margins and fill, with no side panel open. */
const frameOf = (canvasW: number, canvasH: number): Frame => ({ width: (canvasW - 160) * 0.86, height: (canvasH - 160) * 0.86 });
const AT_1440 = frameOf(1440 - 80, 900 - 64);
const AT_1280 = frameOf(1280 - 80, 800 - 64);

// ── autoLayout ──────────────────────────────────────────────────────────────

interface Spec { sid: string; note?: boolean; subs?: number }

/** Sessions as the board holds them: a root with its tool bubbles, the note
 *  that stands to its left, and subagents with bubbles of their own. */
function sessions(specs: Spec[]) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const measured = new Map<string, { width: number; height: number }>();
  const lanes = new Map<string, number>();
  for (const s of specs) {
    const root = `${s.sid}-root`;
    nodes.push({ id: root, type: "agent", position: { x: 0, y: 0 }, data: { sessionId: s.sid } } as Node);
    measured.set(root, { width: W, height: H });
    lanes.set(root, 3);
    if (s.note) {
      const note = `${s.sid}-note`;
      nodes.push({ id: note, type: "recapNote", position: { x: 0, y: 0 }, data: { sessionId: s.sid, parentId: root } } as Node);
      measured.set(note, { width: NOTE_W, height: NOTE_H });
      edges.push({ id: `e-${note}`, source: note, target: root });
    }
    for (let i = 0; i < (s.subs ?? 0); i++) {
      const sub = `${s.sid}-sub${i}`;
      nodes.push({ id: sub, type: "agent", position: { x: 0, y: 0 }, data: { sessionId: s.sid, parentId: root } } as Node);
      measured.set(sub, { width: W, height: H });
      lanes.set(sub, 2);
      edges.push({ id: `e-${sub}`, source: root, target: sub });
    }
  }
  return { nodes, edges, measured, lanes };
}

/** The tour's board: five sessions working with a note beside them, two done,
 *  and two of the working ones fanned out to subagents. */
const TOUR: Spec[] = [
  { sid: "a", note: true, subs: 2 }, { sid: "b" }, { sid: "c", note: true }, { sid: "d", note: true, subs: 1 },
  { sid: "e", note: true }, { sid: "f", note: true }, { sid: "g" },
];

const sizeOf = (n: Node, measured: Map<string, { width: number; height: number }>) => measured.get(n.id)!;

/** Each column's left edge, read off the sessions' left edges. */
function columnsOf(out: Node[]): number[] {
  const left = new Map<string, number>();
  for (const n of out) left.set(sessionOfNode(n), Math.min(left.get(sessionOfNode(n)) ?? Infinity, n.position.x));
  return [...new Set(left.values())].sort((p, q) => p - q);
}

/** The zoom fitLeft shows this board at (use-camera.ts). */
function fitShows(out: Node[], measured: Map<string, { width: number; height: number }>, frame: Frame): number {
  const xs = out.map(n => n.position.x), ys = out.map(n => n.position.y);
  const w = Math.max(...out.map(n => n.position.x + sizeOf(n, measured).width)) - Math.min(...xs);
  const h = Math.max(...out.map(n => n.position.y + sizeOf(n, measured).height)) - Math.min(...ys);
  const at = (lane: number) => Math.min(1, frame.width / (w + lane), frame.height / h);
  return fitZoomForDrawnLanes(at(TOOL_LANE_W), at(0));
}

/** Sessions in the order the board reads them: by column, then down it. */
function readingOrder(out: Node[]): string[] {
  const cols = columnsOf(out);
  const box = new Map<string, { col: number; top: number }>();
  for (const n of out) {
    const sid = sessionOfNode(n);
    const b = box.get(sid) ?? { col: Infinity, top: Infinity };
    const col = cols.filter(x => x <= n.position.x).length - 1;
    box.set(sid, { col: Math.min(b.col, col), top: Math.min(b.top, n.position.y) });
  }
  return [...box].sort((p, q) => p[1].col - q[1].col || p[1].top - q[1].top).map(([sid]) => sid);
}

describe("the board flows into columns that fill the frame", () => {
  for (const [name, frame] of [["1440x900", AT_1440], ["1280x800", AT_1280]] as const) {
    it(`spreads the tour's seven sessions into columns at ${name}, and shows them larger`, () => {
      const { nodes, edges, measured, lanes } = sessions(TOUR);
      const out = autoLayout(nodes, edges, { measured, lanes, availableWidth: frame.width, availableHeight: frame.height });
      const cols = columnsOf(out);
      expect(cols.length).toBeGreaterThan(1);
      expect(cols.length).toBeLessThanOrEqual(MAX_COLUMNS);
      const single = autoLayout(nodes, edges, { measured, lanes });
      expect(columnsOf(single)).toHaveLength(1);
      expect(fitShows(out, measured, frame)).toBeGreaterThan(fitShows(single, measured, frame) * 1.2);
      // Nothing of one column reaches the next, its bubbles at full size included.
      for (const n of out) {
        const following = cols[cols.filter(x => x <= n.position.x).length];
        if (following != null) expect(n.position.x + sizeOf(n, measured).width + TOOL_LANE_W).toBeLessThan(following);
      }
    });
  }

  it("reads down a column and then across, in the order it is given", () => {
    const { nodes, edges, measured, lanes } = sessions(TOUR);
    const order = ["g", "f", "e", "d", "c", "b", "a"];
    const out = autoLayout(nodes, edges, { measured, lanes, order, availableWidth: AT_1440.width, availableHeight: AT_1440.height });
    expect(columnsOf(out).length).toBeGreaterThan(1);
    expect(readingOrder(out)).toEqual(order);
    // Without an order, by id, as it always was.
    const byId = autoLayout(nodes, edges, { measured, lanes, availableWidth: AT_1440.width, availableHeight: AT_1440.height });
    expect(readingOrder(byId)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("never cuts more than four columns", () => {
    // Twelve short sessions in a wide, low frame: one each would show every
    // card at full size, and that is twelve thin columns to read across.
    const { nodes, edges, measured, lanes } = sessions(Array.from({ length: 12 }, (_, i) => ({ sid: `s${String(i).padStart(2, "0")}` })));
    const out = autoLayout(nodes, edges, { measured, lanes, availableWidth: 20_000, availableHeight: 300 });
    expect(columnsOf(out)).toHaveLength(MAX_COLUMNS);
  });

  it("stays one column while one column shows the board at 60% or more", () => {
    // Three sessions, 0.61 in one column; two columns would show them at full
    // size, and are still not worth splitting a board that already reads.
    const { nodes, edges, measured, lanes } = sessions([{ sid: "a" }, { sid: "b" }, { sid: "c" }]);
    const frame = { width: 2000, height: 0.61 * (3 * H + 2 * 146) };
    expect(columnsOf(autoLayout(nodes, edges, { measured, lanes, availableWidth: frame.width, availableHeight: frame.height }))).toHaveLength(1);
    // Just under it, the board splits.
    const tighter = { width: 2000, height: 0.59 * (3 * H + 2 * 146) };
    expect(columnsOf(autoLayout(nodes, edges, { measured, lanes, availableWidth: tighter.width, availableHeight: tighter.height })).length).toBeGreaterThan(1);
  });

  it("pitches a column at its cards and the lane their bubbles take at full size", () => {
    const { nodes, edges, measured, lanes } = sessions([{ sid: "a" }, { sid: "b" }, { sid: "c" }, { sid: "d" }]);
    const xs = columnsOf(autoLayout(nodes, edges, { measured, lanes, availableWidth: 4000, availableHeight: 300 }));
    expect(xs.length).toBeGreaterThan(1);
    expect(xs[1] - xs[0]).toBe(W + TOOL_LANE_W + COLUMN_GAP);
  });
});

// ── when it flows ───────────────────────────────────────────────────────────

const tool = (id: string): ToolCall => ({ id, name: "Bash", inputPreview: "", startedAt: 1 } as ToolCall);

const agent = (id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id,
  sessionId: id.split("::")[0],
  label: id,
  kind: id.includes("::") ? "subagent" : "root",
  parentId: id.includes("::") ? id.split("::")[0] : undefined,
  state: "done",
  startedAt: 1_000,
  endedAt: 2_000,
  tools: [tool(`${id}-t`)],
  prompts: [],
  toolCount: 1,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  ...extra,
} as AgentNodeData);

const onOpenContext = () => {};

/** A deck: the maps App keeps across frames, and one frame at a time. */
function deck(ids: string[], order: string[] = ids) {
  const state: GraphState = initialState();
  const add = (id: string) => { state.agents.set(id, agent(id)); state.revision++; };
  for (const id of ids) add(id);
  const positions = new Map<string, Point>();
  const provisional = new Set<string>();
  const pinned = new Map<string, Point>();
  const measured = new Map<string, { width: number; height: number }>();
  const sigRef = { current: "" };
  const hidden = new Set<string>();
  /** How many times the flow told the camera to frame the board it drew. */
  const framed = { count: 0 };
  const flow: BoardFlow = { flowed: { current: false }, order: () => order, onMoved: () => { framed.count++; } };
  /** The sessions each frame handed the board's motion (onBubble). */
  const carried: string[][] = [];
  const draw = (o: { width?: number; dragging?: boolean; settled?: boolean; restored?: Set<string> } = {}) => {
    for (const id of state.agents.keys()) measured.set(id, { width: W, height: H });
    const visible = new Set([...state.agents.keys()].filter(id => !hidden.has(id)));
    const out = snapshotToFlow(
      state, 3_000, o.width ?? AT_1440.width, AT_1440.height, pinned, measured, new Map(), s => carried.push(s),
      o.settled ?? true, o.dragging ?? false, positions, provisional, [...visible].sort().join(","), sigRef,
      new Set(), null, visible, onOpenContext, true, o.restored ?? new Set(), new Set(), flow,
    );
    return new Map(out.nodes.map(n => [n.id, n.position]));
  };
  /** R (use-board-layout.ts handleRelayout): every place and pin thrown away. */
  const rearrange = () => { positions.clear(); pinned.clear(); sigRef.current = ""; };
  return { state, add, positions, pinned, hidden, flow, carried, framed, draw, rearrange, setOrder: (next: string[]) => { order = next; } };
}

/** The board a first layout of these sessions draws. */
const firstLayout = (ids: string[], order: string[] = ids) => deck(ids, order).draw();

const SEVEN = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];

/** Two cards' boxes share canvas, a session box's chrome around each. */
const touching = (p: Point, q: Point) =>
  p.x < q.x + W + COLUMN_GAP && q.x < p.x + W + COLUMN_GAP && p.y < q.y + H + SESSION_GAP && q.y < p.y + H + SESSION_GAP;

describe("when the whole board flows into its columns", () => {
  it("lays the board out in the rail's order on its first layout", () => {
    const order = [...SEVEN].reverse();
    const d = deck(SEVEN, order);
    const drawn = d.draw();
    const nodes = SEVEN.map(id => ({ id, position: drawn.get(id)!, data: { sessionId: id } }) as Node);
    expect(columnsOf(nodes).length).toBeGreaterThan(1);
    expect(readingOrder(nodes)).toEqual(order);
    expect(d.flow.flowed.current).toBe(true);
  });

  it("lays a fresh board out in flow order from its first frame, so the settle moves nothing", () => {
    const order = [...SEVEN].reverse();
    const d = deck(SEVEN, order);
    // Before the page settles: already the flow's columns, in the rail's order.
    const early = d.draw({ settled: false });
    expect(d.flow.flowed.current).toBe(false);
    expect(early).toEqual(firstLayout(SEVEN, order));
    // The first flow, once settled, finds the board where it would put it.
    expect(d.draw()).toEqual(early);
    expect(d.flow.flowed.current).toBe(true);
    expect(d.carried).toEqual([]);
  });

  it("flows a board this page laid out piecemeal once its sessions are all known, carrying the cards across", () => {
    const d = deck(SEVEN.slice(0, 4));
    // Placed while the log was still replaying, with no stored board behind it.
    SEVEN.slice(0, 4).forEach((id, i) => d.positions.set(id, { x: i * 1_000, y: i * 700 }));
    d.draw({ settled: false });
    expect(d.flow.flowed.current).toBe(false);
    expect(d.draw()).toEqual(firstLayout(SEVEN.slice(0, 4)));
    // The moved sessions go to the board's own motion (onBubble), which slides
    // them, and which reduced motion turns into a jump (canvas-motion.css).
    expect(d.carried).toHaveLength(1);
    for (const id of SEVEN.slice(1, 4)) expect(d.carried[0]).toContain(id);
  });

  it("waits for a drag to end before it flows", () => {
    const d = deck(SEVEN.slice(0, 4));
    const piecemeal = new Map(SEVEN.slice(0, 4).map((id, i) => [id, { x: i * 1_000, y: i * 700 }]));
    for (const [id, p] of piecemeal) d.positions.set(id, p);
    expect(d.draw({ dragging: true })).toEqual(piecemeal);
    expect(d.flow.flowed.current).toBe(false);
    expect(d.draw()).toEqual(firstLayout(SEVEN.slice(0, 4)));
  });

  it("keeps a board a reload brought back, and flows it only on R", () => {
    const d = deck(SEVEN.slice(0, 4));
    // Stored, and nothing like what a layout from scratch would draw.
    const stored = new Map(SEVEN.slice(0, 4).map((id, i) => [id, { x: i * 1_000, y: i * 700 }]));
    for (const [id, p] of stored) d.positions.set(id, p);
    expect(d.draw({ restored: new Set(stored.keys()) })).toEqual(stored);
    expect(d.flow.flowed.current).toBe(true);
    expect(d.draw()).toEqual(stored);
    d.add("s5");
    const after = d.draw();
    for (const [id, p] of stored) expect(after.get(id)).toEqual(p);
    d.rearrange();
    expect(d.draw()).toEqual(firstLayout(SEVEN.slice(0, 5)));
  });

  it("flows on R in the order the rail has now, and R's Undo puts the old board back", () => {
    const d = deck(SEVEN.slice(0, 5));
    const first = d.draw();
    d.add("s6");
    const order = ["s6", "s1", "s2", "s3", "s4", "s5"];
    d.setOrder(order);
    const joined = d.draw();
    // R: every place thrown away, the whole board laid out again.
    const kept = new Map(d.positions);
    d.rearrange();
    expect(d.draw()).toEqual(firstLayout(order, order));
    // Undo puts the maps back, and the next frame leaves them there.
    for (const [id, p] of kept) d.positions.set(id, p);
    expect(d.draw()).toEqual(joined);
    for (const id of SEVEN.slice(0, 5)) expect(joined.get(id)).toEqual(first.get(id));
  });

  // Seen in the round-2 tour: the flow moved seven sessions from one column
  // into two, the layout signature the auto-fit watches did not move, and the
  // camera kept the zoom it had fitted one column at — 38%, the board in the
  // left half of the canvas. The flow says when it has drawn the board.
  it("tells the camera once, on the first flow, to frame the board it drew", () => {
    const d = deck(SEVEN.slice(0, 4));
    SEVEN.slice(0, 4).forEach((id, i) => d.positions.set(id, { x: i * 1_000, y: i * 700 }));
    d.draw({ settled: false });
    expect(d.framed.count).toBe(0);
    d.draw();
    expect(d.framed.count).toBe(1);
    d.draw();
    d.add("s5");
    d.draw();
    expect(d.framed.count).toBe(1);
  });

  it("does not move the camera for a board a reload brought back", () => {
    const d = deck(SEVEN.slice(0, 4));
    const stored = new Map(SEVEN.slice(0, 4).map((id, i) => [id, { x: i * 1_000, y: i * 700 }]));
    for (const [id, p] of stored) d.positions.set(id, p);
    d.draw({ restored: new Set(stored.keys()) });
    expect(d.flow.flowed.current).toBe(true);
    expect(d.framed.count).toBe(0);
  });

  it("frames and stores a restored board again when its hold lifts onto cards that have to move", () => {
    // Stored on top of each other, as a board saved before its cards grew: the
    // pass the hold lifts on slides one off the other, and the camera and the
    // stored board have to follow, or the slid card sits below the pane and a
    // reload runs the same slide again.
    const d = deck(["s1", "s2"]);
    d.positions.set("s1", { x: 0, y: 0 });
    d.positions.set("s2", { x: 0, y: 10 });
    const restored = new Set(["s1", "s2"]);
    d.draw({ restored, settled: false });
    expect(d.framed.count).toBe(0);
    d.draw({ restored, settled: true });
    expect(d.framed.count).toBe(1);
  });

  it("leaves the camera alone when a restored board's hold lifts and nothing moves", () => {
    const d = deck(["s1", "s2"]);
    d.positions.set("s1", { x: 0, y: 0 });
    d.positions.set("s2", { x: 2_000, y: 1_400 });
    const restored = new Set(["s1", "s2"]);
    d.draw({ restored, settled: false });
    d.draw({ restored, settled: true });
    expect(d.framed.count).toBe(0);
  });

  it("is wired to the auto-fit's trailing fit, which stands down while the user has the wheel", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const autoFit = readFileSync(fileURLToPath(new URL("../use-auto-fit.ts", import.meta.url)), "utf8");
    expect(app).toMatch(/const \{ fitSoon \} = useAutoFit\(/);
    expect(app).toMatch(/const boardMoved = useCallback\(\(\) => \{ fitSoon\(\); saveSoon\(\); \}, \[fitSoon, saveSoon\]\);/);
    expect(app).toMatch(/useBoardGraph\(\{[\s\S]*?onMoved: boardMoved[\s\S]*?\}\);/);
    const body = autoFit.slice(autoFit.indexOf("const fitSoon"));
    expect(body).toMatch(/if \(autoFitDisabledRef\.current\) return;/);
  });

  it("stores the flowed board, so a reload brings back the columns rather than the board before them", () => {
    // The flow moves the cards without moving the signature the autosave
    // waits on: the board stored was the one from before the flow, a reload
    // kept it as somebody's arrangement and the overlap pass spread its
    // columns down past the pane.
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const layout = readFileSync(fileURLToPath(new URL("../use-board-layout.ts", import.meta.url)), "utf8");
    expect(app).toMatch(/const \{ saveSoon \} = useLayoutAutosave\(layoutSig, layout\);/);
    const body = layout.slice(layout.indexOf("export function useLayoutAutosave"));
    expect(body).toMatch(/const saveSoon = useCallback\(\(\) => \{[\s\S]*?saveLayout\(positionsRef\.current, pinnedRef\.current\);[\s\S]*?\}, \[\]\);/);
    expect(body).toMatch(/useEffect\(\(\) => \{\s*saveSoon\(\);/);
    expect(body).toMatch(/return \{ saveSoon \};/);
  });

  it("moves no card when only the frame changes: a panel, a window resize, a zoom", () => {
    const d = deck(SEVEN);
    const before = d.draw();
    // A panel opening takes a third of the frame; closing it gives it back
    // twice over. Zoom is not an input at all.
    expect(d.draw({ width: AT_1440.width / 3 })).toEqual(before);
    expect(d.draw({ width: AT_1440.width * 2 })).toEqual(before);
  });
});

describe("after the first flow, a session comes or goes and no other card moves", () => {
  it("takes the board's next place when it arrives, clear of every card", () => {
    const d = deck(SEVEN.slice(0, 5));
    const before = d.draw();
    d.add("s6");
    // First in the rail now: still no reason to move the five already read.
    d.setOrder(["s6", ...SEVEN.slice(0, 5)]);
    const after = d.draw();
    for (const [id, p] of before) expect(after.get(id)).toEqual(p);
    for (const [id, p] of before) expect(touching(after.get("s6")!, p), id).toBe(false);
    expect(d.carried).toEqual([]);
  });

  it("leaves the hole of a session that left, and the next arrival takes it", () => {
    const d = deck(SEVEN);
    const before = d.draw();
    d.hidden.add("s2");
    const gone = d.draw();
    for (const id of SEVEN) if (id !== "s2") expect(gone.get(id)).toEqual(before.get(id));
    d.add("s8");
    const after = d.draw();
    for (const id of SEVEN) if (id !== "s2") expect(after.get(id)).toEqual(before.get(id));
    expect(after.get("s8")).toEqual(before.get("s2"));
  });

  it("keeps a dragged card where the user put it", () => {
    const d = deck(SEVEN.slice(0, 4));
    d.draw();
    d.pinned.set("s3", { x: 9_000, y: 9_000 });
    d.add("s5");
    const drawn = d.draw();
    expect(drawn.get("s3")).toEqual({ x: 9_000, y: 9_000 });
    expect(d.pinned.get("s3")).toEqual({ x: 9_000, y: 9_000 });
  });
});

describe("an arrival is scored the way the columns are", () => {
  const PITCH = W + TOOL_LANE_W + COLUMN_GAP;
  const card = (sid: string, x: number, y: number) =>
    ({ id: sid, position: { x, y }, data: { sessionId: sid } }) as Node;
  /** Settled sessions at `spots`, and `s9` arriving at the foot of the first column. */
  function arrive(spots: Point[], frame: Frame) {
    const nodes = [...spots.map((p, i) => card(`s${i}`, p.x, p.y)), card("s9", 0, 3 * (H + SESSION_GAP))];
    const positions = new Map(nodes.map(n => [n.id, { ...n.position }]));
    const measured = new Map(nodes.map(n => [n.id, { width: W, height: H }]));
    fillGapsWithNewSessions(nodes, positions, new Map(), measured, new Set(["s9"]), undefined, frame);
    return positions.get("s9")!;
  }
  const column = [0, 1, 2].map(i => ({ x: 0, y: i * (H + SESSION_GAP) }));

  it("opens a new column one pitch on when bubbles would not be drawn at the zoom it gives", () => {
    // A new column shows the board at 0.59, too small for bubbles, so the lane
    // past it is not framed; charged anyway, it scored 0.42 and lost to the
    // column's foot at 0.52.
    const p = arrive(column, { width: 600, height: 400 });
    expect(p).toEqual({ x: PITCH, y: 0 });
  });

  it("never opens a fifth column", () => {
    const wide = { width: 20_000, height: 300 };
    expect(arrive([0, 1, 2].map(i => ({ x: i * PITCH, y: 0 })), wide)).toEqual({ x: 3 * PITCH, y: 0 });
    const four = [0, 1, 2, 3].map(i => ({ x: i * PITCH, y: 0 }));
    const p = arrive(four, wide);
    expect(four.some(c => c.x === p.x)).toBe(true);
  });
});

describe("the rail's order is the board's", () => {
  it("puts the session waiting on you first, then the working ones, then the finished", () => {
    const state = initialState();
    const add = (a: AgentNodeData) => state.agents.set(a.id, a);
    add(agent("done", { state: "done" }));
    add(agent("work", { state: "active", endedAt: undefined, prompts: [{ at: 1_500, text: "go" }] }));
    add(agent("wait", { state: "active", endedAt: undefined, prompts: [{ at: 1_200, text: "go" }], waiting: { kind: "permission", since: 1_300 } } as Partial<AgentNodeData>));
    state.revision = 1;
    expect(attentionOrder(state, 3_000)).toEqual(["wait", "work", "done"]);
  });
});
