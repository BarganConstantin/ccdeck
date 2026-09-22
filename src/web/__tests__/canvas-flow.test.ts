// What one frame of the canvas is (#1175).
//
// `snapshotToFlow` decides everything about where the board is: which cards and
// edges exist, when dagre may run again, where a recap note goes, which cached
// positions still mean anything. Every pass it calls has tests of its own; the
// decision that composes them had only REPLICAS — `provisional-position.test.ts`
// and `board-spread.test.ts` re-typed "the layout branch of snapshotToFlow" as
// a local function. Both had drifted by the time this was written: they handed
// `autoLayout` and `fillGapsWithNewSessions` an undefined lane map where the
// real code passes `laneMap(state)`, and they did not keep recap notes out of
// the gap-fill set where the real code does. A replica cannot see a canvas
// regression, because it is not running the canvas.
//
// So the function moved to canvas-flow.ts — no React in it, only types — and
// this drives it. The regressions behind the cases below are the ones a reader
// sees: a card stacked on its neighbour's tool bubbles, a note returning to
// where its card used to be, an edge drawn to a card that is not there.
import { describe, it, expect } from "vitest";
import { laneMap, snapshotToFlow, RECAP_NOTE_GAP, type FlowNodeData } from "../canvas-flow";
import { initialState, type GraphState } from "../reducer";
import { dismissRecap, recapKey, recapNoteId } from "../recap-note";
import type { Provisional } from "../placement";
import type { AgentNodeData, ToolCall } from "../types";

interface Point { x: number; y: number }
interface Size { width: number; height: number }

const tool = (id: string): ToolCall => ({ id, name: "Bash", inputPreview: "", startedAt: 1 } as ToolCall);

/** An agent as the reducer holds one. `id` carries the shape: `s1` is a root,
 *  `s1::a` a subagent of it. */
const agent = (id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id,
  sessionId: id.split("::")[0],
  label: id,
  kind: id.includes("::") ? "subagent" : "root",
  parentId: id.includes("::") ? id.split("::")[0] : undefined,
  state: "done",
  startedAt: 1_000,
  endedAt: 2_000,
  tools: [],
  prompts: [],
  toolCount: 0,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  ...extra,
} as AgentNodeData);

function board(...agents: AgentNodeData[]): GraphState {
  const state = initialState();
  for (const a of agents) state.agents.set(a.id, a);
  state.revision = 1;
  return state;
}

/** App hands the same callback every render (it is a `useCallback`), and the
 *  node-data cache compares against it — so the helper does too. */
const onOpenContext = () => {};

/** One frame, with the arguments App.tsx is not interesting about defaulted. */
function frame(state: GraphState, o: {
  positions?: Map<string, Point>;
  provisional?: Provisional;
  pinned?: Map<string, Point>;
  measured?: Map<string, Size>;
  ref?: { current: string };
  layoutSig?: string;
  visible?: Set<string>;
  selected?: Set<string>;
  lineage?: Set<string> | null;
} = {}) {
  const positions = o.positions ?? new Map<string, Point>();
  const provisional = o.provisional ?? new Set<string>();
  const ref = o.ref ?? { current: "" };
  const visible = o.visible ?? new Set([...state.agents.keys()]);
  const flow = snapshotToFlow(
    state, 3_000, 4_000, 2_000,
    o.pinned ?? new Map(), o.measured ?? new Map(), new Map(), () => {},
    /* settled */ true, /* dragging */ false,
    positions, provisional, o.layoutSig ?? "sig", ref,
    o.selected ?? new Set(), o.lineage ?? null, visible, onOpenContext,
  );
  return { ...flow, positions, provisional, ref };
}

describe("which cards and edges a frame holds", () => {
  it("draws only the agents the filters left visible", () => {
    // `visibleIds` is the canvas filter bar and the session collapse, and the
    // whole board is rebuilt from it — a node the filter hid must not be drawn
    // at all rather than drawn faintly.
    const state = board(agent("s1"), agent("s1::a"), agent("s1::b"));
    const { nodes } = frame(state, { visible: new Set(["s1", "s1::a"]) });
    expect(nodes.map(n => n.id).sort()).toEqual(["s1", "s1::a"]);
  });

  it("draws no edge to a parent that is not on the board", () => {
    // An edge needs both ends. React Flow draws an edge whose source is missing
    // as a line to the origin, which is a thread from a card to the top-left
    // corner of the canvas.
    const state = board(agent("s1"), agent("s1::a"));
    const { nodes, edges } = frame(state, { visible: new Set(["s1::a"]) });
    expect(nodes.map(n => n.id)).toEqual(["s1::a"]);
    expect(edges).toEqual([]);
    // And with both ends visible the edge is there, named for the pair.
    expect(frame(state).edges.map(e => e.id)).toEqual(["e:s1->s1::a"]);
  });

  it("gives every card an accessible name composed from its data", () => {
    // Not read off the card (#853): the name has to survive semantic zoom,
    // where the card stops drawing most of what it says.
    const state = board(agent("s1", { label: "agents-deck" }));
    expect(frame(state).nodes[0].ariaLabel).toContain("agents-deck");
  });

  it("hands each card the same data object while the board has not moved", () => {
    // #873: a fresh object per card per 250ms tick meant React Flow's memoised
    // wrapper never bailed and every card re-rendered four times a second.
    const state = board(agent("s1"));
    const first = frame(state).nodes[0].data as FlowNodeData;
    expect(frame(state).nodes[0].data).toBe(first);
    state.revision++;
    expect(frame(state).nodes[0].data).not.toBe(first);
  });
});

describe("where a recap note goes", () => {
  const withRecap = (sid: string, at: number) =>
    agent(sid, { recap: { text: "did a thing", at } } as Partial<AgentNodeData>);

  it("arrives to the left of its card, centred on it", () => {
    // Tied to its root by an edge, so dagre ranks it left — but a card somebody
    // dragged is pinned and out of dagre's reach, and the note was then laid
    // out on its own and slid under the card by the overlap pass. Placed FROM
    // the card, it cannot be.
    const state = board(withRecap("s1", 1_500));
    const NOTE = recapNoteId("s1");
    const { nodes } = frame(state, {
      pinned: new Map([["s1", { x: 500, y: 100 }]]),
      measured: new Map([["s1", { width: 280, height: 120 }], [NOTE, { width: 200, height: 80 }]]),
    });
    const note = nodes.find(n => n.id === NOTE)!;
    expect(note.type).toBe("recapNote");
    expect(note.position).toEqual({ x: 500 - RECAP_NOTE_GAP - 200, y: 120 });
    // And it is tied to the card by an edge FROM the note, which is also what
    // makes dagre rank it left when the card is not pinned.
    expect(nodes.find(n => n.id === NOTE)!.selectable).toBe(false);
  });

  it("is not a stop for the keyboard, and its tie is not one either", () => {
    // Enter on a focused node selects its id, and a note's id is not an
    // agent's. Its × is still a button and still reached by Tab.
    const state = board(withRecap("s2", 1_500));
    const { nodes, edges } = frame(state);
    const note = nodes.find(n => n.id === recapNoteId("s2"))!;
    expect(note.focusable).toBe(false);
    expect(edges.find(e => e.id === "e:recap:s2")!.focusable).toBe(false);
  });

  it("forgets where the layout put it once it is closed", () => {
    // So the next note is placed beside its card as the card sits THEN. A note
    // put away before its card moved must not come back to where the card used
    // to be.
    const state = board(withRecap("s3", 1_500));
    const NOTE = recapNoteId("s3");
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    expect(frame(state, { positions, provisional }).nodes.map(n => n.id)).toContain(NOTE);
    expect(positions.has(NOTE)).toBe(true);

    dismissRecap(recapKey("s3", 1_500));
    const after = frame(state, { positions, provisional });
    expect(after.nodes.map(n => n.id)).not.toContain(NOTE);
    expect(positions.has(NOTE)).toBe(false);
    expect(provisional.has(NOTE)).toBe(false);
  });

  it("keeps the spot somebody dragged it to", () => {
    // A pin is the user's own placement, and no pass may take one back — so a
    // dragged note comes back where it was left rather than beside its card.
    const state = board(withRecap("s4", 1_500));
    const NOTE = recapNoteId("s4");
    const positions = new Map<string, Point>();
    const pinned = new Map([[NOTE, { x: 12, y: 34 }]]);
    frame(state, { positions, pinned });

    dismissRecap(recapKey("s4", 1_500));
    frame(state, { positions, pinned });
    expect(pinned.get(NOTE)).toEqual({ x: 12, y: 34 });
  });
});

describe("when the frame is allowed to lay the board out again", () => {
  /** Two sessions parked on top of each other, both already "placed", so only
   *  a signature change can bring the repair pass out. */
  const stacked = () => {
    const state = board(agent("a"), agent("b"));
    const positions = new Map<string, Point>([["a", { x: 0, y: 0 }], ["b", { x: 0, y: 0 }]]);
    const measured = new Map<string, Size>([["a", { width: 280, height: 120 }], ["b", { width: 280, height: 120 }]]);
    return { state, positions, measured };
  };

  it("leaves a settled board alone when nothing about it changed", () => {
    const { state, positions, measured } = stacked();
    const ref = { current: "sig#lanes:" };
    frame(state, { positions, measured, ref, layoutSig: "sig" });
    expect(positions.get("b")).toEqual({ x: 0, y: 0 });
  });

  it("treats an agent's first tool call as a structural change", () => {
    // ToolBursts keeps the last four calls as a permanent trail, so an agent
    // that has called a tool occupies 420px of lane beside its card for as long
    // as it is on the board. `layoutSig` does not move for that — no node
    // arrived and nothing was re-measured — so before the lane went into the
    // signature the reservation was applied on exactly one frame per node: the
    // frame it appeared, which is the frame it had called nothing.
    const { state, positions, measured } = stacked();
    const ref = { current: "sig#lanes:" };
    state.agents.get("a")!.tools = [tool("t1")];
    frame(state, { positions, measured, ref, layoutSig: "sig" });
    expect(ref.current).toBe("sig#lanes:a:1");
    // And the repair pass really ran: the two cards no longer sit on each other.
    expect(positions.get("b")).not.toEqual({ x: 0, y: 0 });
  });
});

describe("laneMap", () => {
  it("reserves room only for the agents that have called something", () => {
    const state = board(agent("a", { tools: [tool("t1"), tool("t2")] }), agent("b"));
    expect([...laneMap(state)]).toEqual([["a", 2]]);
  });

  it("stops counting at four, which is what the burst layer keeps", () => {
    // Clamping is also what keeps the signature cheap: the string stops moving
    // after an agent's fourth call, so a busy board is not relaid out forever.
    const state = board(agent("a", { tools: Array.from({ length: 40 }, (_, i) => tool(`t${i}`)) }));
    expect(laneMap(state).get("a")).toBe(4);
  });
});

describe("what a selection does to the cards around it", () => {
  it("dims every card outside the spotlit lineage, and the edges between them", () => {
    // The spotlight is a lineage, not a selection: choosing a subagent lifts
    // its ancestors and its descendants with it, and everything else on the
    // canvas goes quiet. An edge is dimmed only when BOTH its ends are out —
    // an edge into the lineage is how the eye follows it.
    const state = board(agent("s1"), agent("s1::a"), agent("s2"));
    const { nodes, edges } = frame(state, { lineage: new Set(["s1", "s1::a"]) });
    const cls = new Map(nodes.map(n => [n.id, n.className ?? ""]));
    expect(cls.get("s1")).not.toContain("rf-spotlit-out");
    expect(cls.get("s1::a")).not.toContain("rf-spotlit-out");
    expect(cls.get("s2")).toContain("rf-spotlit-out");
    expect(edges.find(e => e.id === "e:s1->s1::a")!.style?.opacity).toBe(1);
  });

  it("leaves every card lit when nothing is spotlit", () => {
    // `null` is "no selection", which is not the same as an empty lineage —
    // an empty one would dim the entire board.
    const state = board(agent("s1"), agent("s2"));
    expect(frame(state, { lineage: null }).nodes.every(n => !n.className)).toBe(true);
  });

  it("thickens and animates an edge that touches the selection", () => {
    const state = board(agent("s1"), agent("s1::a"));
    const { edges } = frame(state, { selected: new Set(["s1::a"]) });
    const edge = edges[0];
    expect(edge.animated).toBe(true);
    expect(edge.style?.strokeWidth).toBe("calc(3px * var(--edge-k, 1))");
  });
});
