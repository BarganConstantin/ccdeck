// A session that arrives beside others stands in their column, and the ones
// already there stay where they are.
//
// A live board drew every new session one note further left than the last:
// the first card at x=0 with its note at -460, the next card at -460 with its
// note at -920, the next at -920, a staircase going off the left edge. The gap
// pass took a column's left edge from everything a session had on the canvas,
// its note included, and lined the arrival's CARD up with it — so the card
// stood where the note above it stood, and its own note then went a note
// further left. And the arrival was placed by its card alone, so when its
// first tool calls drew their bubbles they reached across into the note of the
// session beside it, and the push shoved that whole session down the board.
//
// Driven through snapshotToFlow with the maps App keeps across frames, the way
// a page sees it: the card first, then its note once the prompt is in, then its
// calls.
import { describe, it, expect } from "vitest";
import { snapshotToFlow } from "../canvas-flow";
import { NODE_H, NODE_W } from "../layout-geometry";
import { initialState, type GraphState } from "../reducer";
import { recapNoteId } from "../recap-note";
import type { Provisional } from "../placement";
import type { AgentNodeData, ToolCall } from "../types";

interface Point { x: number; y: number }
interface Size { width: number; height: number }

const root = (id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id,
  sessionId: id,
  label: id,
  kind: "root",
  state: "active",
  startedAt: 1_000,
  tools: [],
  prompts: [],
  toolCount: 0,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  ...extra,
} as AgentNodeData);

const calls = (n: number): ToolCall[] =>
  Array.from({ length: n }, (_, k) => ({ id: `t${k}`, name: "Read", inputPreview: "README.md", startedAt: 1_100 + k, endedAt: 1_200 + k, ok: true }));

/** A settled page, not dragging, with every map App keeps across frames. The
 *  frame is a window's canvas with nothing over it. */
function canvas(state: GraphState, width = 1400, height = 800) {
  const positions = new Map<string, Point>();
  const provisional: Provisional = new Set();
  const pinned = new Map<string, Point>();
  const measured = new Map<string, Size>();
  const prevSessionSize = new Map<string, { w: number; h: number }>();
  const ref = { current: "" };
  const frame = () => {
    // Every frame twice, the second after React Flow has measured what the
    // first drew: a card at a card's size, a note at the sheet's.
    for (let i = 0; i < 2; i++) {
      snapshotToFlow(
        state, 3_000, width, height,
        pinned, measured, prevSessionSize, () => {},
        /* settled */ true, /* dragging */ false,
        positions, provisional, "sig", ref,
        new Set(), null, new Set([...state.agents.keys()]), () => {},
        /* historyReplayed */ true, new Set(),
      );
      for (const id of positions.keys()) {
        if (!measured.has(id)) measured.set(id, id.startsWith("recap:") ? { width: 300, height: 196 } : { width: NODE_W, height: NODE_H });
      }
    }
  };
  return { positions, frame };
}

/** A session as the hooks bring it: SessionStart, then its prompt (which is
 *  when its note appears), then its first calls. */
function arrive(state: GraphState, frame: () => void, id: string, at: number) {
  state.agents.set(id, root(id, { startedAt: at }));
  state.revision++;
  frame();
  state.agents.set(id, root(id, { startedAt: at, prompts: [{ at: at + 1, text: `work on ${id}` }] }));
  state.revision++;
  frame();
  state.agents.set(id, root(id, { startedAt: at, prompts: [{ at: at + 1, text: `work on ${id}` }], tools: calls(4), toolCount: 4 }));
  state.revision++;
  frame();
}

describe("a session arriving beside others", () => {
  it("lines its card up with theirs, its note with their notes, and moves nobody", () => {
    const state = initialState();
    state.revision = 1;
    const { positions, frame } = canvas(state);
    arrive(state, frame, "s1", 1_000);
    const s1 = { ...positions.get("s1")! };
    const s1Note = { ...positions.get(recapNoteId("s1"))! };
    expect(s1Note.x).toBeLessThan(s1.x);

    arrive(state, frame, "s2", 1_100);
    arrive(state, frame, "s3", 1_200);
    arrive(state, frame, "s4", 1_300);

    // Nothing already on the board was moved by an arrival.
    expect(positions.get("s1")).toEqual(s1);
    expect(positions.get(recapNoteId("s1"))).toEqual(s1Note);

    // No staircase: every arrival's note is in a column a note's width from its
    // card, and no note is left of the first one.
    for (const id of ["s2", "s3", "s4"]) {
      const card = positions.get(id)!;
      const note = positions.get(recapNoteId(id))!;
      expect(card.x - note.x, id).toBe(s1.x - s1Note.x);
      expect(note.x, id).toBeGreaterThanOrEqual(s1Note.x);
    }
    // And the cards stand in columns the board already has or opens to the
    // right — never at an x where some other session's note is.
    const noteXs = new Set(["s1", "s2", "s3", "s4"].map(id => positions.get(recapNoteId(id))!.x));
    for (const id of ["s2", "s3", "s4"]) expect(noteXs.has(positions.get(id)!.x), id).toBe(false);
  });

  it("keeps each session where it was as the next one's calls draw their bubbles", () => {
    const state = initialState();
    state.revision = 1;
    const { positions, frame } = canvas(state);
    arrive(state, frame, "s1", 1_000);
    arrive(state, frame, "s2", 1_100);
    const before = new Map([...positions].filter(([id]) => !id.startsWith("group:")).map(([id, p]) => [id, { ...p }]));

    // s3 arrives and calls tools: its lane grows to its full width.
    arrive(state, frame, "s3", 1_200);
    for (const [id, p] of before) expect(positions.get(id), id).toEqual(p);
  });
});
