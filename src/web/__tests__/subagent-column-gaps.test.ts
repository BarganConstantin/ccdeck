// Reported from the app with a screenshot: a coordinator session that starts and
// stops many subagents ends up taking a lot of empty space. Its card stood at the
// top of its box, the two subagents still working stood at the foot of it, and
// between them was the height of every subagent that had finished and left.
//
// A subagent joins its parent's column under the lowest sibling (join-sessions.ts),
// and cards that are placed keep their place. Nothing closed the column when a
// sibling left the board, so every stop left a hole and every start went under it.
// These drive the real frame (snapshotToFlow), the way the board grows and shrinks.
import { describe, it, expect } from "vitest";
import type { Node } from "reactflow";
import { closeSiblingGaps } from "../close-sibling-gaps";
import { snapshotToFlow } from "../canvas-flow";
import { initialState, type GraphState } from "../reducer";
import type { Provisional } from "../placement";
import type { AgentNodeData } from "../types";
import { NODE_H, SIBLING_GAP } from "../layout-geometry";

interface Point { x: number; y: number }

const agent = (id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id,
  sessionId: id.split("::")[0],
  label: id,
  kind: id.includes("::") ? "subagent" : "root",
  parentId: id.includes("::") ? id.split("::")[0] : undefined,
  state: "running",
  startedAt: 1_000,
  tools: [],
  prompts: [],
  toolCount: 0,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  ...extra,
} as AgentNodeData);

function board(agents: AgentNodeData[]): GraphState {
  const state = initialState();
  for (const a of agents) state.agents.set(a.id, a);
  state.revision = 1;
  return state;
}

const onOpenContext = () => {};

/** The board across frames: the maps App keeps between renders. */
function liveBoard() {
  const positions = new Map<string, Point>();
  const provisional: Provisional = new Set();
  const pinned = new Map<string, Point>();
  const ref = { current: "" };
  const moved: string[][] = [];
  const draw = (agents: AgentNodeData[]) => {
    const state = board(agents);
    snapshotToFlow(
      state, 3_000, 4_000, 2_000,
      pinned, new Map(), new Map(), sessions => moved.push(sessions),
      /* settled */ true, /* dragging */ false,
      positions, provisional, agents.map(a => a.id).sort().join(","), ref,
      new Set(), null, new Set(agents.map(a => a.id)), onOpenContext,
      /* replayed */ true, new Set(),
    );
  };
  return { positions, pinned, moved, draw };
}

const PITCH = NODE_H + SIBLING_GAP;

describe("a coordinator's column closes up when its subagents leave", () => {
  it("brings the subagents still working up beside the coordinator", () => {
    const b = liveBoard();
    const root = agent("s1");
    const kids = ["a", "b", "c", "d", "e"].map(k => agent(`s1::${k}`));
    // Started one after another, the way a coordinator starts them.
    for (let i = 0; i <= kids.length; i++) b.draw([root, ...kids.slice(0, i)]);
    const top = b.positions.get("s1::a")!;
    expect(b.positions.get("s1::e")!.y).toBe(top.y + 4 * PITCH);

    // The first three finish and leave the board.
    b.draw([root, kids[3], kids[4]]);
    expect(b.positions.get("s1::d")).toEqual(top);
    expect(b.positions.get("s1::e")).toEqual({ x: top.x, y: top.y + PITCH });
    // The move travels with the board's own motion, like a push.
    expect(b.moved.flat()).toContain("s1");
  });

  it("closes a hole in the middle and leaves the cards above it alone", () => {
    const b = liveBoard();
    const root = agent("s1");
    const kids = ["a", "b", "c", "d"].map(k => agent(`s1::${k}`));
    for (let i = 0; i <= kids.length; i++) b.draw([root, ...kids.slice(0, i)]);
    const a = { ...b.positions.get("s1::a")! };
    b.draw([root, kids[0], kids[3]]);
    expect(b.positions.get("s1::a")).toEqual(a);
    expect(b.positions.get("s1::d")).toEqual({ x: a.x, y: a.y + PITCH });
  });

  it("puts the next subagent under the ones still there, not under the hole", () => {
    const b = liveBoard();
    const root = agent("s1");
    const kids = ["a", "b", "c", "d"].map(k => agent(`s1::${k}`));
    for (let i = 0; i <= kids.length; i++) b.draw([root, ...kids.slice(0, i)]);
    const top = { ...b.positions.get("s1::a")! };
    b.draw([root, kids[3]]);
    const next = agent("s1::f");
    b.draw([root, kids[3], next]);
    expect(b.positions.get("s1::d")).toEqual(top);
    expect(b.positions.get("s1::f")).toEqual({ x: top.x, y: top.y + PITCH });
  });

  it("never moves a subagent the user dragged, and closes up around it", () => {
    const b = liveBoard();
    const root = agent("s1");
    const kids = ["a", "b", "c", "d"].map(k => agent(`s1::${k}`));
    for (let i = 0; i <= kids.length; i++) b.draw([root, ...kids.slice(0, i)]);
    const top = { ...b.positions.get("s1::a")! };
    const dragged = { x: top.x + 900, y: top.y + 2000 };
    b.pinned.set("s1::c", dragged);
    b.draw([root, kids[2], kids[3]]);
    expect(b.pinned.get("s1::c")).toEqual(dragged);
    expect(b.positions.get("s1::d")).toEqual(top);
  });

  it("leaves a column with no hole exactly where it is", () => {
    const b = liveBoard();
    const root = agent("s1");
    const kids = ["a", "b", "c"].map(k => agent(`s1::${k}`));
    for (let i = 0; i <= kids.length; i++) b.draw([root, ...kids.slice(0, i)]);
    const before = new Map([...b.positions].map(([k, v]) => [k, { ...v }]));
    const movesBefore = b.moved.length;
    // The last one leaves: nothing is under it, so nothing has to close.
    b.draw([root, kids[0], kids[1]]);
    for (const id of ["s1", "s1::a", "s1::b"]) expect(b.positions.get(id)).toEqual(before.get(id));
    expect(b.moved.slice(movesBefore).flat()).not.toContain("s1");
  });
});

describe("closeSiblingGaps on its own", () => {
  const card = (id: string, sessionId: string, parentId?: string): Node =>
    ({ id, position: { x: 0, y: 0 }, data: { sessionId, parentId } } as Node);

  it("does not rise into ground another session stands on", () => {
    const nodes = [card("r", "s"), card("c", "s", "r"), card("o", "t")];
    const positions = new Map<string, Point>([
      ["r", { x: 0, y: 0 }],
      ["c", { x: 400, y: 2 * PITCH }],
      // Another session's card, dropped into the hole beside the parent.
      ["o", { x: 400, y: 0 }],
    ]);
    const moved = closeSiblingGaps(nodes, positions, new Map(), new Map(), undefined, id => positions.get(id));
    expect(moved).toEqual([]);
    expect(positions.get("c")).toEqual({ x: 400, y: 2 * PITCH });
  });

  it("carries a subagent's own subagents up with it", () => {
    const nodes = [card("r", "s"), card("c", "s", "r"), card("g", "s", "c")];
    const positions = new Map<string, Point>([
      ["r", { x: 0, y: 0 }],
      ["c", { x: 400, y: 3 * PITCH }],
      ["g", { x: 800, y: 3 * PITCH }],
    ]);
    expect(closeSiblingGaps(nodes, positions, new Map(), new Map(), undefined, id => positions.get(id))).toEqual(["s"]);
    expect(positions.get("c")).toEqual({ x: 400, y: 0 });
    expect(positions.get("g")).toEqual({ x: 800, y: 0 });
  });
});
