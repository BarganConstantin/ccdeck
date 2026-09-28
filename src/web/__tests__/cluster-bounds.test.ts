// The invisible per-session drag handle is a React Flow node like any other:
// it lives in the store, it is measured, and its data carries the session's own
// sessionId. SessionClusters walked the store by data alone, so the handle
// counted as a member of the very session it wraps — and the handle is already
// the cards' bounding box plus GROUP_PAD, so the decorative card settled one
// PAD larger than the handle it exists to trace.
//
// What that cost: an 18px rim of visible session box on all four sides where
// no draggable node exists, contradicting the file's own promise that the card
// lines up with the handle; and the chrome layout.ts budgets between two
// stacked sessions (SESSION_CHROME = 18 below the cards + 18+26+12 above them)
// grew to 110, so the 72px of designed breathing room read as half that.
import { describe, it, expect } from "vitest";
import type { Node } from "reactflow";
import { clusterBounds, type ClusterNode } from "../cluster-bounds";
import { sessionGroupNodes } from "../session-group-nodes";
import type { AgentNodeData } from "../types";

const PAD = 18;        // GROUP_PAD in session-group-nodes.ts
const HEADER_H = 26;   // the label strip above the box
const W = 240, H = 130;

function card(sessionId: string, x: number, y: number): ClusterNode {
  return {
    type: "agent",
    position: { x, y },
    width: W,
    height: H,
    data: { sessionId, kind: "root", label: sessionId, state: "active" } as AgentNodeData,
  };
}

function retiring(n: ClusterNode): ClusterNode {
  return { ...n, data: { ...n.data, exitAt: 1 } as AgentNodeData };
}

/**
 * The handle the deck builds behind a session, built by the function that
 * builds it. This used to be a copy of App.tsx's group-node memo, written out
 * by hand because the memo could not be called from here; a copy is the thing
 * that stops matching without anyone noticing (#377), and the real one is a
 * function now.
 */
function handle(sessionId: string, cards: ClusterNode[]): ClusterNode {
  const nodes = cards.map((c, i) => ({ id: `card-${i}`, ...c })) as Node[];
  const made = sessionGroupNodes(nodes).find(n => (n.data as AgentNodeData).sessionId === sessionId);
  expect(made, `no handle was built for ${sessionId}`).toBeTruthy();
  return made as ClusterNode;
}

describe("cluster bounds ignore the per-session drag handle", () => {
  const cards = [card("s1", 100, 100), card("s1", 500, 260)];
  const grip = handle("s1", cards);

  it("traces the handle rather than leaving a rim around it", () => {
    const [c] = clusterBounds([...cards, grip]);
    // Below its label strip the card is the handle, edge for edge — which is
    // what makes every pixel of visible box a surface that drags the session.
    expect(c.x).toBe(grip.position.x);
    expect(c.w).toBe(grip.width);
    expect(c.y + HEADER_H).toBe(grip.position.y);
    expect(c.h - HEADER_H).toBe(grip.height);
  });

  it("reports the same box whether or not the handle is in the store", () => {
    expect(clusterBounds([...cards, grip])).toEqual(clusterBounds(cards));
  });

  it("leaves exactly the chrome layout.ts budgets around the cards", () => {
    const [c] = clusterBounds([...cards, grip]);
    expect(c.x).toBe(100 - PAD);
    expect(c.y).toBe(100 - PAD - HEADER_H);
    expect(c.x + c.w).toBe(500 + W + PAD);
    expect(c.y + c.h).toBe(260 + H + PAD);
  });

  it("draws nothing for a session whose cards have all retired", () => {
    // The exitAt guard exists so a session's box does not hang in the air
    // behind cards that are fading out. A handle counted as a member keeps the
    // box alive on its own and hands that bug straight back.
    expect(clusterBounds([...cards.map(retiring), grip])).toEqual([]);
  });

  it("shrinks to the cards still live when one of them retires", () => {
    const live = card("s1", 100, 100);
    const gone = retiring(card("s1", 900, 700));
    const [c] = clusterBounds([live, gone, handle("s1", [live])]);
    expect(c.x + c.w).toBe(100 + W + PAD);
    expect(c.y + c.h).toBe(100 + H + PAD);
  });

  it("keeps each session's box to its own cards", () => {
    const a = card("s1", 0, 0);
    const b = card("s2", 0, 900);
    const boxes = clusterBounds([a, b, handle("s1", [a]), handle("s2", [b])]);
    expect(boxes.map(c => c.sessionId)).toEqual(["s1", "s2"]);
    expect(boxes[0].y + boxes[0].h).toBe(H + PAD);
    expect(boxes[1].y).toBe(900 - PAD - HEADER_H);
  });
});
