// Tab walked the cards in the order their agents were first heard of.
//
// snapshotToFlow built React Flow's nodes straight off the reducer's agent map,
// whose order is arrival order, and React Flow renders — and so Tab visits —
// nodes in the order it is handed them. A subagent spawned after another
// session had started landed in the DOM after that session: on the rich board,
// five of api-server's subagents, then the whole infra session, then nine more
// of api-server's, the focus ring jumping back and forth across the canvas.
//
// The order now follows the board: down a column of sessions and then across,
// as the layout packs them, and inside a session the root, then each rank of
// subagents from the top.
import { describe, expect, it } from "vitest";
import { snapshotToFlow } from "../canvas-flow";
import { initialState, type GraphState } from "../reducer";
import type { AgentNodeData } from "../types";

interface Point { x: number; y: number }

const agent = (id: string, parentId?: string): AgentNodeData => ({
  id,
  sessionId: id.split("::")[0],
  label: id,
  kind: parentId ? "subagent" : "root",
  parentId,
  state: "done",
  startedAt: 1_000,
  endedAt: 2_000,
  tools: [],
  prompts: [],
  toolCount: 0,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
} as AgentNodeData);

/** A board whose agents arrived in the order given. */
function board(...agents: AgentNodeData[]): GraphState {
  const state = initialState();
  for (const a of agents) state.agents.set(a.id, a);
  state.revision = 1;
  return state;
}

const onOpenContext = () => {};

/** The ids React Flow is handed, in order, for one frame. */
function order(state: GraphState, positions = new Map<string, Point>()): string[] {
  const measured = new Map([...state.agents.keys()].map(id => [id, { width: 240, height: 130 }]));
  const { nodes } = snapshotToFlow(
    state, 3_000, 4_000, 2_000, new Map(), measured, new Map(), () => {},
    true, false, positions, new Set(), "sig", { current: "" },
    new Set(), null, new Set(state.agents.keys()), onOpenContext, true, new Set(),
  );
  return nodes.map(n => n.id);
}

describe("the order Tab walks the canvas in", () => {
  it("keeps a session's subagents together, after its root, however late they arrived", () => {
    // The finder's shape: A starts, B starts, then A spawns.
    const state = board(agent("A"), agent("B"), agent("A::x", "A"), agent("A::y", "A"));
    expect(order(state)).toEqual(["A", "A::x", "A::y", "B"]);
  });

  it("goes down a column of sessions and then across, as the board reads", () => {
    // s2 arrived second, but it stands at the top of the second column.
    const positions = new Map<string, Point>([
      ["s1", { x: 0, y: 0 }],
      ["s2", { x: 1_200, y: 0 }],
      ["s3", { x: 0, y: 600 }],
    ]);
    expect(order(board(agent("s1"), agent("s2"), agent("s3")), positions)).toEqual(["s1", "s3", "s2"]);
  });

  it("walks a session's subagents a rank at a time, each from the top", () => {
    const positions = new Map<string, Point>([
      ["s1", { x: 0, y: 200 }],
      ["s1::a", { x: 400, y: 300 }],
      ["s1::b", { x: 400, y: 0 }],
      ["s1::a::g", { x: 800, y: 300 }],
    ]);
    const state = board(agent("s1"), agent("s1::a", "s1"), agent("s1::a::g", "s1::a"), agent("s1::b", "s1"));
    expect(order(state, positions)).toEqual(["s1", "s1::b", "s1::a", "s1::a::g"]);
  });
});
