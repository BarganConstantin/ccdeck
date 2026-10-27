// A session that comes back onto the board stands where it stood — unless
// something took that ground while it was away.
//
// Hide finished sessions (hide-finished.ts) takes a session off the board and
// brings it back the moment it works again. It used to forget where the root
// stood as it went, so the root came back as an arrival, and the gap pass
// (fill-gaps.ts) scores an arrival's slot by how large the fit can show the
// board: the hole the session had left at the top of its column made the board
// taller than the foot of the column did, so the foot won every time. A board
// whose sessions finish and resume walked down the canvas by a column's height
// a round, and an agent that kept spawning subagents had each round of them
// drawn further below the last. The subagents it already had kept their
// places, so the root also came back some way under its own cards. So the
// place is kept now (use-removals.ts), and the session comes back to it.
//
// While it was away its ground was free, and an arrival may have been given
// it. Coming back onto that, its cards would have been slid one by one by the
// overlap pass under the newcomer's, splitting both sessions. So a session
// whose ground was taken forgets its places instead and arrives whole, and the
// gap pass finds it room as it would for any arrival. A pinned card keeps its
// pin: the user put it there.
import type { Node } from "reactflow";
import { CROSS_SESSION_X, CROSS_SESSION_Y, footprint, sessionOfNode, type Lanes } from "./layout-geometry";
import { isUnplaced, type Provisional } from "./placement";

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

const isNote = (n: Node) => n.type === "recapNote";

/** The provider's session a card belongs to, which is what the removal set
 *  names; `sessionOfNode` is the group it is drawn in. */
const providerSessionOf = (n: Node): string | undefined => (n.data as { sessionId?: string } | undefined)?.sessionId;

/**
 * Send the sessions in `returning` back to their places, or forget the places
 * whose ground another session now covers.
 *
 * A mark is spent once its session has cards on the board, and kept until
 * then: it is set as the session leaves the removal set, a frame before its
 * cards are drawn. Its own note is not looked at — canvas-flow places a note
 * from its card. Mutates `positions`, `provisional` and `returning`; returns
 * the groups whose places were forgotten.
 */
export function sendSessionsHome(
  nodes: Node[],
  positions: Map<string, Point>,
  provisional: Provisional,
  pinned: Map<string, Point>,
  measured: Map<string, { width: number; height: number }>,
  lanes: Lanes | undefined,
  returning: Set<string>,
): string[] {
  if (returning.size === 0) return [];
  const back = new Set<string>();
  for (const n of nodes) {
    const sid = providerSessionOf(n);
    if (sid && returning.has(sid)) {
      back.add(sessionOfNode(n));
      returning.delete(sid);
    }
  }
  if (back.size === 0) return [];

  const boxOf = (n: Node): Box | undefined => {
    const p = pinned.get(n.id) ?? (isUnplaced(n.id, positions, provisional) ? undefined : positions.get(n.id));
    if (!p) return undefined;
    const { w, h } = footprint(n.id, measured, lanes);
    return { x: p.x, y: p.y, w, h };
  };
  // The ground the rest of the board stands on, notes included. A group that
  // came back in the same frame is not ground for the others: each of them is
  // somewhere it stood before.
  const ground: Box[] = [];
  for (const n of nodes) {
    if (back.has(sessionOfNode(n))) continue;
    const b = boxOf(n);
    if (b) ground.push(b);
  }
  // The margin the overlap pass keeps between two sessions, so a place that is
  // clear here is one that pass would leave alone.
  const covered = (b: Box) => ground.some(r =>
    b.x < r.x + r.w + CROSS_SESSION_X && r.x < b.x + b.w + CROSS_SESSION_X &&
    b.y < r.y + r.h + CROSS_SESSION_Y && r.y < b.y + b.h + CROSS_SESSION_Y);

  const sent: string[] = [];
  for (const group of back) {
    const cards = nodes.filter(n => sessionOfNode(n) === group && !isNote(n));
    if (!cards.some(n => { const b = boxOf(n); return b != null && covered(b); })) continue;
    for (const n of cards) {
      if (pinned.has(n.id)) continue;
      positions.delete(n.id);
      provisional.delete(n.id);
    }
    sent.push(group);
  }
  return sent;
}
