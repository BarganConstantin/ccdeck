// A recap note stays beside its card when a layout pass moves the card.
//
// The overlap repair moves nodes one by one. When a card above grew — it was
// measured taller, or its tool bubbles came in — the card below slid down
// clear of it, and its note, which covered nothing, stayed where it was. Every
// such slide left the note further above its card; the session's box grew to
// span the two, the push then shoved the next sessions apart to make room for
// the stretched box, and a fresh visit fitted the whole board at a third of
// its size with the task lines hidden.
import { describe, it, expect } from "vitest";
import { snapshotToFlow, RECAP_NOTE_GAP } from "../canvas-flow";
import { initialState, type GraphState } from "../reducer";
import { recapNoteId } from "../recap-note";
import type { Provisional } from "../placement";
import type { AgentNodeData } from "../types";

interface Point { x: number; y: number }
interface Size { width: number; height: number }

const CARD = { width: 256, height: 76 };
const NOTE = { width: 240, height: 92 };

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
  recap: { text: `${id} did a thing`, at: 1_500 },
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
  let sig = 0;
  const frame = (relayout = false) => {
    if (relayout) sig++;
    return snapshotToFlow(
      state, 3_000, 1_600, 1_800,
      pinned, measured, prevSessionSize, () => {},
      /* settled */ true, /* dragging */ false,
      positions, provisional, `sig${sig}`, ref,
      new Set(), null, new Set([...state.agents.keys()]), () => {},
      /* historyReplayed */ true, new Set(),
    );
  };
  return { positions, pinned, measured, frame };
}

const besideCard = (card: Point) => ({
  x: card.x - RECAP_NOTE_GAP - NOTE.width,
  y: card.y + (CARD.height - NOTE.height) / 2,
});

function settledBoard(ids: string[]) {
  const state = initialState();
  for (const id of ids) state.agents.set(id, root(id));
  state.revision = 1;
  const c = canvas(state);
  c.frame();
  for (const id of ids) {
    c.measured.set(id, CARD);
    c.measured.set(recapNoteId(id), NOTE);
  }
  c.frame(true);
  c.frame();
  return c;
}

describe("a recap note and its card", () => {
  it("sit side by side once the board has measured", () => {
    const { positions } = settledBoard(["s1", "s2", "s3"]);
    for (const id of ["s1", "s2", "s3"]) {
      expect(positions.get(recapNoteId(id))).toEqual(besideCard(positions.get(id)!));
    }
  });

  it("stay side by side when a card above grows and the cards below slide down", () => {
    const ids = ["s1", "s2", "s3"];
    const { positions, measured, frame } = settledBoard(ids);
    // The one highest in its column grows the most a card does.
    const top = [...ids].sort((a, b) => positions.get(a)!.y - positions.get(b)!.y)[0];
    const before = new Map(ids.map(id => [id, { ...positions.get(id)! }]));
    measured.set(top, { width: CARD.width, height: 640 });
    frame(true);
    frame();
    // Something did move, or this proves nothing.
    expect(ids.some(id => positions.get(id)!.y !== before.get(id)!.y)).toBe(true);
    for (const id of ids) {
      const card = positions.get(id)!;
      const h = measured.get(id)!.height;
      const note = positions.get(recapNoteId(id))!;
      expect(note.x).toBe(card.x - RECAP_NOTE_GAP - NOTE.width);
      expect(note.y).toBe(card.y + (h - NOTE.height) / 2);
    }
  });

  it("stay where the person put them: a dragged note is not pulled back", () => {
    const { positions, pinned, frame } = settledBoard(["s1", "s2"]);
    const note = recapNoteId("s1");
    const dropped = { x: positions.get("s1")!.x - 900, y: positions.get("s1")!.y + 300 };
    pinned.set(note, dropped);
    positions.set(note, dropped);
    frame(true);
    frame();
    expect(positions.get(note)).toEqual(dropped);
  });

  it("stay where they were when the card itself was dragged", () => {
    const { positions, pinned, frame } = settledBoard(["s1", "s2"]);
    const note = recapNoteId("s1");
    const noteBefore = { ...positions.get(note)! };
    const dropped = { x: positions.get("s1")!.x + 700, y: positions.get("s1")!.y + 40 };
    pinned.set("s1", dropped);
    positions.set("s1", dropped);
    frame(true);
    frame();
    expect(positions.get(note)).toEqual(noteBefore);
  });
});
