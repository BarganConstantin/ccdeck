// Where a session that arrives whole goes: into a gap a finished session left,
// and — given the frame a fit shows the board in — wherever else keeps the
// board's cards largest, a new column included.
//
// Runs once the arrivals have their `autoLayout` slots, and moves whole
// sessions only.
import type { Node } from "reactflow";
import {
  cardSize, columnGap, CROSS_SESSION_Y, footprint, FULL_SIZE, groupBySession, SESSION_CHROME, sessionOfNode, TOOL_LANE_W, type Lanes,
} from "./layout-geometry";

/**
 * Drop newly-arrived sessions into the gaps left by ones that finished.
 *
 * Sessions are pruned as they complete, which punches holes in a column while
 * new work keeps being appended below the last thing placed. Left alone the
 * canvas grows downward forever with empty bands through the middle, and the
 * fit zoom shrinks to cover space that holds nothing.
 *
 * A session is moved as a whole — its cards keep their arrangement relative to
 * each other, only the block moves — and it is only ever moved into a gap that
 * fits it outright. Anything that does not fit stays where the layout put it,
 * below everything else.
 *
 * A gap is measured against real footprints, lanes included — a band that looks
 * empty because the session above it has been pruned may still be covered by
 * the chips of the session beside it, and dropping an arrival into it would
 * land it under them.
 *
 * Given the `frame` a fit shows the board in, a gap is not the only choice. The
 * board used to grow only downward — into a gap in a column that already
 * existed, or below it, never into a column that did not — so a board that
 * started as one column stayed one column however many sessions arrived, and
 * the fit shrank it beside an empty right half. With a frame, every clear slot
 * is scored instead: each column's gaps and its foot, and the top of a new
 * column to the right, by the zoom the fit would show the board at with the
 * arrival in it. A slot inside the board costs nothing, so a hole is still
 * filled first; past that the board grows whichever way keeps its cards
 * largest. Between slots the fit would show at the same zoom, the one leaving
 * the most room on the tighter axis wins, then the most on the other, then the
 * leftmost and topmost. When nothing is settled yet the whole board is
 * arriving at once, and autoLayout's arrangement of it stands.
 *
 * Mutates `positions`; returns the session ids it relocated.
 */
export function fillGapsWithNewSessions(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  newIds: Set<string>,
  lanes?: Lanes,
  /** The frame a fit shows the board in, as autoLayout is given it. */
  frame?: { width: number; height: number },
): string[] {
  const sizeOf = (id: string) => footprint(id, measured, lanes);
  const posOf = (id: string) => pinned.get(id) ?? positions.get(id);
  // The fit frames cards, not lanes, so the board it scores is card-sized.
  const cardOf = (id: string) => {
    const { w, h } = cardSize(id, measured);
    return { cw: w, ch: h };
  };
  const scoring = frame != null && frame.width > 0 && frame.height > 0;

  // Only a session that arrived WHOLE may be relocated.
  //
  // The caller hands over every node that had no stored position, which for a
  // session already on screen that spawns a subagent is just that one child.
  // Treating it as an arrival makes it a one-card block whose own parent sits
  // in `settled` as a cross-session obstacle, so the child gets dropped into
  // some distant gap hundreds of pixels from the session it belongs to: the
  // cluster box stretches across the canvas to reach it and the parent→child
  // edge runs the length of the screen. A partially-new session keeps the slot
  // dagre just gave its new cards, beside their siblings.
  const membersBySession = groupBySession(nodes, n => posOf(n.id) != null);
  const wholeSessionArrived = new Set<string>();
  for (const [sid, members] of membersBySession) {
    if (members.every(n => newIds.has(n.id) && !pinned.has(n.id))) wholeSessionArrived.add(sid);
  }

  // Group the arrivals, and keep anything already placed as an obstacle.
  const arriving = new Map<string, Node[]>();
  const settled: Array<{ x: number; y: number; w: number; h: number; cw: number; ch: number }> = [];
  for (const n of nodes) {
    const p = posOf(n.id);
    if (!p) continue;
    const { w, h } = sizeOf(n.id);
    const sid = sessionOfNode(n);
    if (wholeSessionArrived.has(sid)) {
      (arriving.get(sid) ?? arriving.set(sid, []).get(sid)!).push(n);
    } else {
      settled.push({ x: p.x, y: p.y, w, h, ...cardOf(n.id) });
    }
  }
  if (arriving.size === 0 || (scoring && settled.length === 0)) return [];

  // Session boxes are what must not touch, so obstacles are inflated by the
  // chrome and the gap the layout would have left between two sessions.
  const PADDING = CROSS_SESSION_Y;
  const clashes = (x: number, y: number, w: number, h: number) =>
    settled.some(r =>
      x < r.x + r.w + SESSION_CHROME && r.x < x + w + SESSION_CHROME &&
      y < r.y + r.h + PADDING        && r.y < y + h + PADDING);
  const gap = columnGap(nodes, measured);

  const moved: string[] = [];
  // Id order, the same order autoLayout packs sessions in, so gap placement is
  // deterministic across renders. Not arrival order: session ids are random
  // UUIDs and no timestamp reaches this function, so which arrival gets first
  // pick of the gaps is arbitrary-but-stable rather than oldest-first.
  for (const sid of [...arriving.keys()].sort()) {
    const members = arriving.get(sid)!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let cardRight = -Infinity, cardBottom = -Infinity;
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w, h } = sizeOf(n.id);
      const { cw, ch } = cardOf(n.id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      cardRight = Math.max(cardRight, p.x + cw); cardBottom = Math.max(cardBottom, p.y + ch);
    }
    const w = maxX - minX, h = maxY - minY;

    // Candidate tops: the very top of a column, and just under everything
    // already there. Any gap big enough starts at one of those edges, so
    // there is nothing to gain from stepping pixel by pixel.
    const columns = [...new Set(settled.map(r => Math.round(r.x)))].sort((a, b) => a - b);
    const xs = columns.length ? columns : [minX];
    const ys = [0, ...settled.map(r => r.y + r.h + PADDING)].sort((a, b) => a - b);

    let target: { x: number; y: number } | null = null;
    if (scoring) {
      // The board as the fit frames it: its cards, plus the burst lane fitLeft
      // leaves beside the rightmost one.
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const r of settled) {
        left = Math.min(left, r.x); top = Math.min(top, r.y);
        right = Math.max(right, r.x + r.cw); bottom = Math.max(bottom, r.y + r.ch);
      }
      // Scored by the zoom the fit would show the board at, and between slots
      // that tie on it — every slot under a board already bound by its width
      // is a tie — by how much room each leaves on the tighter axis, then on
      // the other. Without that second look the leftmost column's foot won
      // every tie, however much taller than its neighbour it already was.
      const scoreAt = (x: number, y: number) => {
        const across = frame!.width /
          (Math.max(right, x + cardRight - minX) - Math.min(left, x) + TOOL_LANE_W);
        const down = frame!.height /
          (Math.max(bottom, y + cardBottom - minY) - Math.min(top, y));
        return [Math.min(FULL_SIZE, across, down), Math.min(across, down), Math.max(across, down)];
      };
      const beats = (s: number[], t: number[]) => {
        for (let i = 0; i < s.length; i++) {
          if (s[i] > t[i] + 1e-9) return true;
          if (s[i] < t[i] - 1e-9) return false;
        }
        return false;
      };
      // A new column starts a burst lane and a column gap past the rightmost
      // card — the pitch autoLayout packs its columns at — level with the top
      // of the board.
      const fresh = Math.round(right + TOOL_LANE_W + gap);
      const tops = [...new Set([...ys, top])].sort((a, b) => a - b);
      let best: number[] | null = null;
      for (const x of [...xs, fresh]) {
        for (const y of tops) {
          if (clashes(x, y, w, h)) continue;
          const score = scoreAt(x, y);
          if (best === null || beats(score, best)) { best = score; target = { x, y }; }
        }
      }
      if (target && target.x === minX && target.y === minY) target = null;
    } else {
      outer: for (const x of xs) {
        for (const y of ys) {
          if (y >= minY) break;               // not a gap — that is where it already is
          if (!clashes(x, y, w, h)) { target = { x, y }; break outer; }
        }
      }
    }

    if (target) {
      const dx = target.x - minX, dy = target.y - minY;
      for (const n of members) {
        const p = posOf(n.id)!;
        positions.set(n.id, { x: p.x + dx, y: p.y + dy });
      }
      moved.push(sid);
    }
    // Placed or not, it is an obstacle for the next arrival.
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w: nw, h: nh } = sizeOf(n.id);
      settled.push({ x: p.x, y: p.y, w: nw, h: nh, ...cardOf(n.id) });
    }
  }
  return moved;
}
