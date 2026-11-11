// The columns are scored by what the fit frames, and below the full card the fit
// frames the cards alone: a session's recap note is drawn only at the full card
// (context-modal.css), so the room left of its card is empty canvas there.
//
// The packer charged that room as width on every cut. Moving one session with a
// note into the second column cost the board 400px of width in its sums, so a
// board of five sessions with notes and two without was cut 5 + 2: one tall
// column the fit then showed at 44% beside an empty right half of the stage,
// where a cut one session sooner shows the same cards larger.
import { describe, it, expect } from "vitest";
import type { Edge, Node } from "reactflow";
import { autoLayout } from "../layout";

const CARD = { width: 256, height: 76 };
const NOTE = { width: 240, height: 92 };
/** The frame fitLeft shows the board in on the 1128 x 836 stage of a 1440 x 900 window. */
const FRAME = { width: (1128 - 160) * 0.86, height: (836 - 160) * 0.86 };

function board(withNotes: number, without: number) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const measured = new Map<string, { width: number; height: number }>();
  for (let i = 0; i < withNotes + without; i++) {
    const sid = `s${i}`;
    nodes.push({ id: sid, type: "agent", position: { x: 0, y: 0 }, data: { sessionId: sid } } as Node);
    measured.set(sid, CARD);
    if (i < withNotes) {
      const note = `recap:${sid}`;
      nodes.push({ id: note, type: "recapNote", position: { x: 0, y: 0 }, data: { sessionId: sid, parentId: sid } } as Node);
      edges.push({ id: `e:${note}`, source: note, target: sid });
      measured.set(note, NOTE);
    }
  }
  return { nodes, edges, measured };
}

describe("the cut a board of sessions with notes is packed into", () => {
  it("is the one whose cards show largest, the notes' room not charged", () => {
    const { nodes, edges, measured } = board(5, 2);
    const out = autoLayout(nodes, edges, { measured, availableWidth: FRAME.width, availableHeight: FRAME.height });
    const pos = (id: string) => out.find(n => n.id === id)!.position;
    const ids = ["s0", "s1", "s2", "s3", "s4", "s5", "s6"];
    const firstColumn = ids.filter(id => pos(id).x === pos("s0").x);
    // Not the one tall column of five beside two.
    expect(firstColumn.length).toBeLessThan(5);
    // Still read down, then across: the first column is the head of the order,
    // and the rest stand to its right in order.
    expect(firstColumn).toEqual(ids.slice(0, firstColumn.length));
    const rest = ids.slice(firstColumn.length);
    for (const id of rest) expect(pos(id).x).toBeGreaterThan(pos("s0").x);
    for (let i = 1; i < rest.length; i++) expect(pos(rest[i]).y).toBeGreaterThan(pos(rest[i - 1]).y);
    // And the cards, framed alone as the fit frames them from afar, show larger
    // than the 5 + 2 cut did: 0.565 of full size there, 0.592 here.
    const cards = ids.map(pos);
    const w = Math.max(...cards.map(p => p.x)) + CARD.width - Math.min(...cards.map(p => p.x));
    const h = Math.max(...cards.map(p => p.y)) + CARD.height - Math.min(...cards.map(p => p.y));
    expect(Math.min(1, FRAME.width / w, FRAME.height / h)).toBeGreaterThan(0.58);
  });

  it("stands a column's cards on one line, with a note or without", () => {
    // The zigzag: a session without a note was set at the column's left edge,
    // where the notes of the sessions with one stand, so its card stepped out
    // of the line by a note's width.
    const { nodes, edges, measured } = board(5, 2);
    const out = autoLayout(nodes, edges, { measured, availableWidth: FRAME.width, availableHeight: FRAME.height });
    // Two columns, so two card lines and no more.
    const lines = new Set(out.filter(n => n.type === "agent").map(n => n.position.x));
    expect(lines.size).toBe(2);
    // The sessions without a note stand on the line of the ones with one.
    const plain = ["s5", "s6"].map(id => out.find(n => n.id === id)!.position.x);
    const noted = out.filter(n => n.type === "agent" && ["s0", "s1", "s2", "s3", "s4"].includes(n.id)).map(n => n.position.x);
    for (const x of plain) expect(noted).toContain(x);
  });

  it("still keeps the full room between the columns, so a note never covers the column before it", () => {
    const { nodes, edges, measured } = board(5, 2);
    const out = autoLayout(nodes, edges, { measured, availableWidth: FRAME.width, availableHeight: FRAME.height });
    const pos = (id: string) => out.find(n => n.id === id)!.position;
    // Every note right of the first column starts past that column's cards and
    // their bubbles.
    const notes = out.filter(n => n.type === "recapNote" && n.position.x > pos("recap:s0").x);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.position.x).toBeGreaterThanOrEqual(pos("s0").x + CARD.width + 420);
  });
});
