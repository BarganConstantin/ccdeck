// The stage's open and close: a window that grows out of the clicked card into
// the stage's column, and shrinks back into the card — v3's morph, one frame
// at a time and decided in plain numbers so the suite can pin every frame.
//
// A WINDOW, NOT A SCALE. While it moves, the stage covers the whole canvas
// cell and a clip-path inset is the window onto it. The terminal inside is
// already at its final size and place, with the session's seed written
// (DESIGN-UI decision 2), so the morph UNCOVERS the session running — nothing
// in it is ever scaled. The one element that does travel is the RIDER: the
// card's name, flying from where the card printed it to where the header
// prints it, at the header's size scaled down to the card's at the start.
//
// THE SAME BEAT AS THE FOLD. The navigator's fold (navigator-flip.ts) runs in
// the same 220ms open / 180ms close on the same ease-out and the same timer
// clock (runTween), and the board's own fade here is the fold's formula, so
// when the stage opens beside no navigator at all — the takeover a narrow
// window gets — the board still leaves on the frame it would have.
//
// Every ramp below is v3's, measured in its prototype against the frames it
// shot (05/06/07 open, 30/31 close): the window's edge in the card's state
// colour fades out by 0.95, the stage's content fades in from 0.40 to 0.85 so
// the window is never an empty box nor a finished one before it has arrived,
// the header's state line, controls and chip arrive only at the handover
// (HEADER_LATE) so nothing is printed where the rider is landing, and on the
// way back the content holds until 0.30 so the session is seen going home.
import { BOARD_OUT_BY, ramp, type FoldDirection } from "./navigator-flip";

export interface MorphRect { x: number; y: number; w: number; h: number }

/**
 * When the header's state line, controls and chip arrive in an open: at the
 * rider's handover, not before it.
 *
 * The rider flies on the window's own progress, which is what keeps it inside
 * the window the whole way (both go from the card to the column on the same
 * `e`); a rider that landed early would leave the window and be clipped off
 * before the window got there. But then it is still some way from home late in
 * the open, and v3's 0.80 had the state line under its landing fading in while
 * it flew over it — "ccdeck" printed across "working" for the last stretch.
 * From 0.97 the rider is within a few pixels of home, and on this ease-out
 * that still leaves the last ~105ms of the 220ms open for them to arrive in.
 */
export const HEADER_LATE = 0.97;

/** The corner the window starts with: a card's radius. The column has none. */
export const MORPH_RADIUS = 10;
/** When a card was not on screen the stage grows out of its own column, from
 *  this far inside it — a short grow rather than nothing at all, so the stage
 *  never appears without saying where it came from. */
export const COLUMN_SEED_INSET = 24;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Pixels to a hundredth, so the strings written per frame stay short. */
const px = (n: number) => Math.round(n * 100) / 100;

/** `rect`, from page coordinates into a box whose top-left is `box`. */
export function localRect(rect: MorphRect, box: { x: number; y: number }): MorphRect {
  return { x: rect.x - box.x, y: rect.y - box.y, w: rect.w, h: rect.h };
}

/** Where the stage grows from when there is no card to grow out of. */
export function columnSeed(column: MorphRect): MorphRect {
  const dx = Math.min(COLUMN_SEED_INSET, column.w / 4);
  const dy = Math.min(COLUMN_SEED_INSET, column.h / 4);
  return { x: column.x + dx, y: column.y + dy, w: column.w - 2 * dx, h: column.h - 2 * dy };
}

export function lerpRect(a: MorphRect, b: MorphRect, k: number): MorphRect {
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) };
}

/** The clip-path that makes `r` the window onto a box `w` × `h`. */
export function clipInset(r: MorphRect, w: number, h: number, radius: number): string {
  const top = px(r.y), right = px(w - r.x - r.w), bottom = px(h - r.y - r.h), left = px(r.x);
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${px(radius)}px)`;
}

export interface MorphPlan {
  direction: FoldDirection;
  /** The box the window is cut from (the canvas cell), its own size. */
  w: number;
  h: number;
  /** Open: the card → the column. Close: the column → the card. In the box's
   *  own coordinates. */
  from: MorphRect;
  to: MorphRect;
  /** Where the name is printed at the rider's two ends — on the card and in
   *  the header — or null when the stage is not a card's (the empty stage, a
   *  new session). The same two whichever way the morph runs. */
  rider: { card: MorphRect; header: MorphRect } | null;
}

export interface MorphFrame {
  clip: string;
  /** The window's 1px edge: where it is, its corner, how strongly drawn. */
  edge: { rect: MorphRect; radius: number; opacity: number };
  /** The stage's own content (header, terminal, keys bar). */
  content: number;
  /** The header's state line and controls, on top of `content`. They sit
   *  right under and beside where the rider lands, so they arrive only at the
   *  handover (HEADER_LATE → 1) and are gone the moment it sets off home —
   *  otherwise the flying name prints over "working" on its way. */
  late: number;
  /** The model chip beside the name, last of all: the rider ends its flight
   *  against it. Gone at once on the way home. */
  chip: number;
  /** The whole stage — below 1 only at the very end of a close. */
  stage: number;
  /** The board under it, for when no fold is drawing it. */
  board: number;
  rider: { transform: string; opacity: number } | null;
}

/** One frame of `plan` at eased progress `e` (0 → 1 along its direction). */
export function morphFrame(plan: MorphPlan, e: number): MorphFrame {
  const open = plan.direction === "open";
  const r = lerpRect(plan.from, plan.to, e);
  const radius = open ? lerp(MORPH_RADIUS, 0, e) : lerp(0, MORPH_RADIUS, e);
  // How folded the board is, as the navigator's fold measures it, so a stage
  // with no navigator beside it fades the board on the fold's own frames.
  const fold = open ? e : 1 - e;
  let rider: MorphFrame["rider"] = null;
  if (plan.rider) {
    const { card, header } = plan.rider;
    // The rider is drawn at the header's size; at the card's end it is scaled
    // down to the card's. Heights, because a name's width is its length.
    const small = header.h > 0 && card.h > 0 ? card.h / header.h : 1;
    const a = open ? card : header, b = open ? header : card;
    const sa = open ? small : 1, sb = open ? 1 : small;
    const at = lerpRect(a, b, e);
    rider = {
      transform: `translate(${px(at.x)}px, ${px(at.y)}px) scale(${Math.round(lerp(sa, sb, e) * 10000) / 10000})`,
      opacity: open ? 1 : 1 - ramp(e, 0.75, 1),
    };
  }
  return {
    clip: clipInset(r, plan.w, plan.h, radius),
    edge: {
      rect: r,
      radius,
      opacity: open ? 1 - ramp(e, 0.55, 0.95) : ramp(e, 0.1, 0.4) * (1 - ramp(e, 0.85, 1)),
    },
    content: open ? ramp(e, 0.4, 0.85) : 1 - ramp(e, 0.3, 0.62),
    late: open ? ramp(e, HEADER_LATE, 1) : 1 - ramp(e, 0, 0.04),
    chip: open ? ramp(e, 0.98, 1) : 1 - ramp(e, 0, 0.04),
    stage: open ? 1 : 1 - ramp(e, 0.7, 1),
    board: 1 - ramp(fold, 0, BOARD_OUT_BY),
    rider,
  };
}
