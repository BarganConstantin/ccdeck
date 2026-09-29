// #1767: a first-column session keeps its place when its recap note appears.
//
// canvas-flow puts a new note to the LEFT of its card, and a card in the first
// column sits at x=0, so the note lands at x=-460 and the session's box starts
// there. The push clamped every box it relaxed to x>=0 and y>=0 — meant to stop
// a push from sending a box off the top-left, but it also dragged a box that
// was already past the edge back onto it, on any pass that ran, whether or not
// anything pushed that box. The card slid 460px right and the note took its
// old spot. The floor is where the box started now, when that is past the edge.
//
// Two forms: the frame itself, through snapshotToFlow with the maps App keeps
// across frames, and bubblePush on its own with the shapes the frame produced.
import { describe, it, expect } from "vitest";
import type { Node } from "reactflow";
import { snapshotToFlow, RECAP_NOTE_GAP } from "../canvas-flow";
import { bubblePush } from "../layout";
import { NODE_H, NODE_W } from "../layout-geometry";
import { initialState, type GraphState } from "../reducer";
import { recapNoteId } from "../recap-note";
import type { Provisional } from "../placement";
import type { AgentNodeData } from "../types";

interface Point { x: number; y: number }
interface Size { width: number; height: number }

const root = (id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id,
  sessionId: id,
  label: id,
  kind: "root",
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

/** A settled page, not dragging, with every map App keeps across frames. */
function canvas(state: GraphState) {
  const positions = new Map<string, Point>();
  const provisional: Provisional = new Set();
  const pinned = new Map<string, Point>();
  const measured = new Map<string, Size>();
  const prevSessionSize = new Map<string, { w: number; h: number }>();
  const ref = { current: "" };
  const frame = () => snapshotToFlow(
    state, 3_000, 4_000, 2_000,
    pinned, measured, prevSessionSize, () => {},
    /* settled */ true, /* dragging */ false,
    positions, provisional, "sig", ref,
    new Set(), null, new Set([...state.agents.keys()]), () => {},
    /* historyReplayed */ true, new Set(),
  );
  return { positions, measured, frame };
}

describe("a first-column session's recap note (#1767)", () => {
  it("opens beside the card, and the card stays where it was", () => {
    const state = initialState();
    state.agents.set("s1", root("s1"));
    state.agents.set("s2", root("s2"));
    state.revision = 1;
    const { positions, measured, frame } = canvas(state);

    // Placed, then measured, then settled.
    frame();
    for (const id of ["s1", "s2"]) measured.set(id, { width: NODE_W, height: NODE_H });
    frame();
    frame();
    const s1 = positions.get("s1")!;
    const s2 = positions.get("s2")!;
    expect(s1.x).toBe(0);   // the first column, which is the case

    // The session comes to rest with a recap.
    state.agents.set("s1", root("s1", { recap: { text: "did a thing", at: 1_500 } } as Partial<AgentNodeData>));
    state.revision++;
    frame();
    const NOTE = recapNoteId("s1");
    measured.set(NOTE, { width: 300, height: 130 });
    frame();
    expect(positions.get("s1")).toEqual(s1);
    expect(positions.get("s2")).toEqual(s2);
    expect(positions.get(NOTE)!.x).toBeLessThan(s1.x - RECAP_NOTE_GAP);   // left of the card

    // And not later either, the first time something else on the board grows.
    measured.set("s2", { width: NODE_W, height: 260 });
    frame();
    expect(positions.get("s1")).toEqual(s1);
  });
});

describe("bubblePush — a box already left of the edge", () => {
  const card = (id: string, sessionId: string): Node =>
    ({ id, position: { x: 0, y: 0 }, data: { sessionId }, width: NODE_W, height: NODE_H } as Node);

  it("stays put when a pass runs without pushing it", () => {
    // s1: a card at 0 and its note at -460, as the frame above leaves them.
    // s2 below it grows into s1's box from underneath, so the relaxation runs
    // and pushes s1 up — and s1 at y=0 cannot go up, so it takes none of it.
    // Its x was never asked to change.
    const nodes = [card("s1", "s1"), card("recap:s1", "s1"), card("s2", "s2")];
    const positions = new Map<string, Point>([["s1", { x: 0, y: 0 }], ["recap:s1", { x: -460, y: 0 }], ["s2", { x: 0, y: 400 }]]);
    const measured = new Map<string, Size>([
      ["s1", { width: NODE_W, height: NODE_H }],
      ["recap:s1", { width: 300, height: NODE_H }],
      ["s2", { width: NODE_W, height: NODE_H }],
    ]);
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, positions, new Map(), measured, prev);   // records only

    // s2 grows up into s1's clearance.
    positions.set("s2", { x: 0, y: 200 });
    measured.set("s2", { width: NODE_W, height: 400 });
    bubblePush(nodes, positions, new Map(), measured, prev);

    expect(positions.get("s1")).toEqual({ x: 0, y: 0 });
    expect(positions.get("recap:s1")).toEqual({ x: -460, y: 0 });
  });

  it("still cannot be pushed further past the edge than it started", () => {
    // The floor is where it started, not minus infinity: a push toward the
    // corner stops there.
    const nodes = [card("a", "sa"), card("a-note", "sa"), card("t1", "tall"), card("t2", "tall"), card("t3", "tall")];
    const positions = new Map<string, Point>([
      ["a", { x: 0, y: 20 }], ["a-note", { x: -460, y: 20 }],
      ["t1", { x: 150, y: 100 }], ["t2", { x: 150, y: 500 }], ["t3", { x: 150, y: 900 }],
    ]);
    const measured = new Map<string, Size>(nodes.map(n => [n.id, { width: NODE_W, height: NODE_H }]));
    const prev = new Map<string, { w: number; h: number }>();
    bubblePush(nodes, positions, new Map(), measured, prev);
    bubblePush(nodes, positions, new Map(), measured, prev);
    expect(positions.get("a-note")!.x).toBeGreaterThanOrEqual(-460);
    expect(positions.get("a")!.x).toBeGreaterThanOrEqual(0);
    expect(positions.get("a")!.y).toBeGreaterThanOrEqual(0);
  });
});
