// Room for a session that just got bigger: its neighbours pushed aside by the
// least that clears them, rather than slid down past the whole grown block.
//
// Runs every frame after the overlap repair, and returns straight away unless
// a session grew or two session boxes are crossing.
import type { Node } from "reactflow";
import {
  footprint, NODE_H, NODE_W, SESSION_CHROME, SESSION_VISIBLE_GAP, sessionOfNode, type Lanes,
} from "./layout-geometry";

/**
 * Make room for a session that just got bigger by pushing its neighbours aside.
 *
 * Eight subagents spawning at once is the case this exists for. The session's
 * cards fan out, its cluster box grows in every direction, and it swallows
 * whatever was next to it. `separateOverlaps` will clear that, but only by
 * sliding the covered session straight down until it is past the obstacle —
 * which throws a session that was sitting perfectly well half a screen away
 * because something beside it grew by 60px.
 *
 * This displaces by the smallest amount that resolves the overlap instead. For
 * each overlapping pair it finds the shallower axis of penetration and pushes
 * along that one, splitting the push between the two sessions by mass. The
 * session that grew is heavy, so it keeps its ground and its neighbours give
 * way; a session holding a node the user dragged is immovable, so the push
 * routes around it rather than undoing their placement.
 *
 * Whole sessions move, never individual cards — a session's internal
 * arrangement is what makes it readable, and shoving one card out of a cluster
 * to resolve a collision destroys more than the collision did.
 *
 * `prevSessionSize` is the caller's memory of how big each session was last
 * time; it is read to decide what grew and written back before returning. The
 * first call only records, so nothing jumps on load.
 *
 * Mutates `positions`. Returns the session ids it moved — empty when nothing
 * grew, which is almost every call.
 */
export function bubblePush(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  prevSessionSize: Map<string, { w: number; h: number }>,
  /**
   * Record the sizes and move nothing.
   *
   * Cards are measured as they mount, so during the first moment of a page
   * load a session's box grows every frame — from one measured card, to three,
   * to all of them. That is measurement catching up, not a session fanning
   * out, and pushing on it rearranges a board the user asked to have preserved
   * across refresh.
   */
  recordOnly = false,
  /**
   * Bubbles beside each agent, as `autoLayout` gets them.
   *
   * A session's size is read from `measured`, which holds cards only, so the
   * single most common way a session on this canvas grows — an agent gaining a
   * lane, 420px wide and up to 150px tall — used to register as no growth at
   * all, and the push that exists for exactly that never fired. With the lane
   * in the size both the growth test and the area-based mass follow from it:
   * the session whose chips are doing the covering is the heavy one, and it is
   * its neighbours that yield.
   */
  lanes?: Lanes,
): string[] {
  // Clearance between two session boxes — the same numbers separateOverlaps
  // uses, so the two agree on what "overlapping" means.
  // Relaxation approaches the constraint from inside and stops a hair short of
  // it, so it solves for a fraction more clearance than is actually required
  // and the converged result clears the real gap outright.
  const SOLVE_SLACK = 1;
  const GAP_X = 18 * 2 + 24 + SOLVE_SLACK;
  const GAP_Y = SESSION_CHROME + SESSION_VISIBLE_GAP + SOLVE_SLACK;

  // A session has to gain real size to count. Sub-pixel measurement noise and
  // a card gaining a digit are not worth moving the canvas for.
  const GROWTH_EPS = 8;

  // Resolving on the shallower axis alone would push sideways as readily as
  // down, and sessions are packed into columns — a sideways push breaks the
  // column, a downward one only stretches it. So horizontal penetration has to
  // be clearly the cheaper way out before it wins.
  const X_BIAS = 1.75;

  // Jacobi relaxation: collect every pair's push, then apply once. Applying
  // each pair as it is found makes the result depend on pair order and lets
  // three mutually-overlapping sessions oscillate.
  // Convergence is geometric — each pass removes DAMPING of what is left — so
  // the iteration count is about the worst mutually-overlapping case, not the
  // common one, and at a dozen sessions the whole thing is a few thousand
  // comparisons.
  const ITERATIONS = 200;
  const DAMPING = 0.7;
  const SETTLED = 0.01;     // px of total movement below which we stop

  const sizeOf = (id: string) => footprint(id, measured, lanes);
  const posOf = (id: string) => pinned.get(id) ?? positions.get(id);

  interface Box {
    sid: string;
    members: string[];
    x: number; y: number; w: number; h: number;
    anchored: boolean;      // holds a node the user dragged — never moves
    mass: number;
  }

  // ── build one box per session ────────────────────────────────────────────
  const bySession = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!posOf(n.id)) continue;
    const sid = sessionOfNode(n);
    const list = bySession.get(sid);
    if (list) list.push(n); else bySession.set(sid, [n]);
  }

  const boxes: Box[] = [];
  const grew = new Set<string>();
  const seen = new Set<string>();
  // Read before the loop below fills it in. Cards are measured as they mount,
  // so on the very first call the boxes are whatever has rendered so far —
  // usually crossing, and always about to change. Nothing is worth moving yet.
  const firstCall = prevSessionSize.size === 0;

  // Sorted so the relaxation is deterministic: same input, same output.
  for (const sid of [...bySession.keys()].sort()) {
    const members = bySession.get(sid)!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let anchored = false;
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w, h } = sizeOf(n.id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      if (pinned.has(n.id)) anchored = true;
    }
    const w = maxX - minX, h = maxY - minY;
    seen.add(sid);

    const before = prevSessionSize.get(sid);
    // Unknown sessions are recorded, not treated as growth: on first load every
    // session would qualify and the whole canvas would shove itself apart.
    if (before && (w > before.w + GROWTH_EPS || h > before.h + GROWTH_EPS)) grew.add(sid);
    prevSessionSize.set(sid, { w, h });

    boxes.push({ sid, members: members.map(n => n.id), x: minX, y: minY, w, h, anchored, mass: 1 });
  }
  for (const sid of [...prevSessionSize.keys()]) if (!seen.has(sid)) prevSessionSize.delete(sid);

  if (recordOnly || firstCall) return [];

  // Growth is the usual cause of a collision, and for a long time it was the
  // only one this bothered to look for. It is not the only one.
  //
  // separateOverlaps keeps CARDS apart, but what the user sees crossing is the
  // BOX drawn around each session — the union of its cards, plus padding, a
  // header and a label tab. A three-card session can sit in the vertical gap
  // between two cards of a twenty-card one, clash with neither, and still be
  // drawn straight through the middle of its box. Nothing grew, so nothing
  // looked; the boxes stayed crossed until something else happened to move.
  //
  // A session dropped into a gap by fillGapsWithNewSessions, a card slid clear
  // of one neighbour into another's span, and a board restored from storage all
  // land in the same place. So: run whenever boxes are actually crossing, and
  // let growth decide only who holds their ground.
  let crossing = false;
  for (let i = 0; i < boxes.length && !crossing; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.anchored && b.anchored) continue;
      if (Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) < (a.w + b.w) / 2 + GAP_X &&
          Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) < (a.h + b.h) / 2 + GAP_Y) {
        crossing = true;
        break;
      }
    }
  }
  if (grew.size === 0 && !crossing) return [];

  if (grew.size > 0) {
    // The session that grew holds its ground; everything else yields to it.
    for (const b of boxes) if (grew.has(b.sid)) b.mass = 8;
  } else {
    // Nothing changed size, so there is no culprit to hold still. Area decides
    // instead: shoving a twenty-card session aside to clear a three-card one
    // rearranges far more of the canvas than the reverse does.
    for (const b of boxes) b.mass = Math.max(1, (b.w * b.h) / (NODE_W * NODE_H));
  }

  // ── relax ────────────────────────────────────────────────────────────────
  const startX = new Map(boxes.map(b => [b.sid, b.x]));
  const startY = new Map(boxes.map(b => [b.sid, b.y]));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const dx = new Map<string, number>();
    const dy = new Map<string, number>();
    let total = 0;

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.anchored && b.anchored) continue;

        const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        const overlapX = (a.w + b.w) / 2 + GAP_X - Math.abs(acx - bcx);
        const overlapY = (a.h + b.h) / 2 + GAP_Y - Math.abs(acy - bcy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // Everything above and left of the origin is off the canvas, so a box
        // already against it cannot absorb a push that heads further out.
        const freeX = (box: Box, dir: number) => !box.anchored && !(dir < 0 && box.x <= 0);
        const freeY = (box: Box, dir: number) => !box.anchored && !(dir < 0 && box.y <= 0);

        /**
         * Which way to separate on one axis.
         *
         * Normally: apart, along the line between the centres. When the centres
         * sit on top of each other there is no such line, and the id decides so
         * the result is stable rather than left to floating-point noise — but
         * then the choice is arbitrary, so if it points somewhere neither box
         * can go, the opposite is just as valid and is tried instead. Without
         * that, a session against the top-left corner whose only neighbour is
         * pinned reports itself wedged while a clear direction was available.
         */
        const pick = (ca: number, cb: number, free: (box: Box, dir: number) => boolean) => {
          const tied = ca === cb;
          const first = tied ? (a.sid < b.sid ? -1 : 1) : Math.sign(ca - cb);
          if (free(a, first) || free(b, -first)) return first;
          if (tied && (free(a, -first) || free(b, first))) return -first;
          return 0;
        };

        const dirX = pick(acx, bcx, freeX);
        const dirY = pick(acy, bcy, freeY);
        const canX = dirX !== 0, canY = dirY !== 0;
        if (!canX && !canY) continue;   // genuinely wedged; nothing to be done

        // Prefer the shallower axis, but only among the ones that can actually
        // take the push. Without this a session against the top edge whose only
        // neighbour is pinned resolves nowhere: the cheap axis is blocked, the
        // open one is never tried, and the two just stay on top of each other.
        const useX = canX && (!canY || overlapX * X_BIAS < overlapY);

        const [dir, overlap, delta, free] = useX
          ? [dirX, overlapX, dx, freeX] as const
          : [dirY, overlapY, dy, freeY] as const;

        // Share by mass, but only across the boxes that can move on this axis —
        // a partner that is pinned or against the edge takes none of it, and
        // its share goes to the other one rather than being lost.
        const aFree = free(a, dir), bFree = free(b, -dir);
        const ma = a.mass, mb = b.mass;
        const shareA = aFree ? (bFree ? mb / (ma + mb) : 1) : 0;
        const shareB = bFree ? (aFree ? ma / (ma + mb) : 1) : 0;

        const push = overlap * DAMPING;
        delta.set(a.sid, (delta.get(a.sid) ?? 0) + dir * push * shareA);
        delta.set(b.sid, (delta.get(b.sid) ?? 0) - dir * push * shareB);
        total += push;
      }
    }

    for (const b of boxes) {
      if (b.anchored) continue;
      // A session pushed off the top-left corner is not "out of the way", it
      // is gone. freeX/freeY above keep the solver from relying on a push the
      // clamp would have swallowed.
      b.x = Math.max(0, b.x + (dx.get(b.sid) ?? 0));
      b.y = Math.max(0, b.y + (dy.get(b.sid) ?? 0));
    }
    if (total < SETTLED) break;
  }

  // ── write back ───────────────────────────────────────────────────────────
  const moved: string[] = [];
  for (const b of boxes) {
    const shiftX = b.x - startX.get(b.sid)!;
    const shiftY = b.y - startY.get(b.sid)!;
    if (Math.abs(shiftX) < 1 && Math.abs(shiftY) < 1) continue;
    for (const id of b.members) {
      if (pinned.has(id)) continue;
      const p = positions.get(id);
      if (!p) continue;
      positions.set(id, { x: p.x + shiftX, y: p.y + shiftY });
    }
    moved.push(b.sid);
  }
  return moved;
}
