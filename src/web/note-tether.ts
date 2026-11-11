// A recap note's place: to the left of its card, centred on it, and kept there
// whenever a layout pass moves the card.
//
// The note is a member of its session — the session's box goes round it, a
// session drag carries it, the push moves it with the cards — but the overlap
// repair moves nodes one at a time. When a card above grew, the card below
// slid down clear of it and its note, which covered nothing, stayed put. Each
// slide left the note further above its card, the session's box grew to span
// the two, and the push then shoved the sessions below apart to make room for a
// box that was mostly empty: a fresh visit fitted that board at a third of its
// size, below the zoom the task lines show at.
import type { Node } from "reactflow";
import { cardSize, RECAP_NOTE_GAP, RECAP_NOTE_H, RECAP_NOTE_W } from "./layout-geometry";
import { isUnplaced, recordPlacement, type Provisional } from "./placement";

interface Point { x: number; y: number }
type Sizes = Map<string, { width: number; height: number }>;

/** Where the note `noteId` goes beside its card at `card`: left of it, by the
 *  rank gap R lays a note out with, and centred on the card's height. */
export function noteSpot(noteId: string, rootId: string, card: Point, measured: Sizes): Point {
  const nw = measured.get(noteId)?.width ?? RECAP_NOTE_W;
  const nh = measured.get(noteId)?.height ?? RECAP_NOTE_H;
  const rh = cardSize(rootId, measured).h;
  return { x: card.x - RECAP_NOTE_GAP - nw, y: card.y + (rh - nh) / 2 };
}

/**
 * Put every note back beside its card, after the passes that move cards.
 *
 * What a person placed stays placed: a note somebody dragged is a pin, and so
 * is a card dragged on its own — its note stays where it was, as it always
 * has, rather than jumping after the card on the drop. A card that has no real
 * place yet is not followed either; the layout pass places its note with it.
 *
 * Mutates `positions`; returns the ids of the notes it moved.
 */
export function tetherRecapNotes(
  nodes: Node[],
  positions: Map<string, Point>,
  provisional: Provisional,
  pinned: Map<string, Point>,
  measured: Sizes,
): string[] {
  const moved: string[] = [];
  for (const n of nodes) {
    if (n.type !== "recapNote" || pinned.has(n.id)) continue;
    const rootId = (n.data as { parentId?: string } | undefined)?.parentId;
    if (!rootId || pinned.has(rootId) || isUnplaced(rootId, positions, provisional)) continue;
    const at = noteSpot(n.id, rootId, positions.get(rootId)!, measured);
    const now = isUnplaced(n.id, positions, provisional) ? undefined : positions.get(n.id);
    if (now && now.x === at.x && now.y === at.y) continue;
    recordPlacement(n.id, at, positions, provisional);
    moved.push(n.id);
  }
  return moved;
}
