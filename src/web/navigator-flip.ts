// The fold: the board gathering into the navigator when the stage opens, and
// spreading back out when it closes, as one FLIP on one clock.
//
// WHY A FLIP AND NOT A TWEEN OF THE BOARD. The navigator is a DOM component at
// 1:1 beside a React Flow board that stays mounted, hidden (DESIGN-UI decision
// 1): the board keeps its camera and its state, and the navigator's words are
// never scaled. So nothing moves the board. What moves is the navigator's own
// tiles, each laid out where it belongs and drawn, for the length of the fold,
// as if it started where its cluster stood on the board: First the board's
// rects are read, Last the tiles are laid out, Invert is the transform from
// one to the other, and Play runs it to zero. The rim — the hue outline and
// wash, the part of a cluster that is geometry — carries the whole transform,
// scale included; the tile's words only ride along (a translate, no scale)
// and fade in from 0.45 of the way, so no frame ever draws a squashed name.
// Meanwhile the board itself fades by the halfway mark. Order-preserving
// tiles (board-navigator.ts) mean no two rims cross on the way.
//
// ONE CLOCK, A TIMER. Every frame is computed from elapsed time on one clock,
// never from an animation's `finished` promise or a CSS transition end: the
// prototype's headless Chromium stalled those, and the stage's own morph runs
// in the same beat on the same clock (runTween is exported for it). Frame 0 is
// delivered synchronously, so the first paint after the switch already shows
// the tiles where the board was — never one frame of the navigator at rest.
//
// OVER 60 CLUSTERS the per-tile transforms stop being worth what they cost and
// the fold becomes a plain cross-fade of the board and the navigator. Under
// reduced motion the fold has no duration at all: one frame, the end state.
import { prefersReducedMotion } from "./viewport-motion";

export interface FlipRect { x: number; y: number; w: number; h: number }

export type FoldDirection = "open" | "close";

/** The house ease-out (DESIGN.md's motion vocabulary), the curve the stage's
 *  morph rides in the same beat. */
export const FLIP_EASE = [0.23, 1, 0.32, 1] as const;
export const FLIP_OPEN_MS = 220;
export const FLIP_CLOSE_MS = 180;
/** More clusters than this and the fold is a cross-fade with no rect tween. */
export const FLIP_TILE_LIMIT = 60;
/** The tick of the timer clock: a 60Hz frame. */
export const FRAME_MS = 16;
/** Where along the fold the tiles' words start to appear, and by when the
 *  board's own cards are gone — v3's 0.45 and 0.5, so the two sets of words
 *  never print over each other for more than a sliver of the fold. */
export const WORDS_IN_FROM = 0.45;
export const BOARD_OUT_BY = 0.5;

/**
 * A CSS cubic-bezier timing function, solved exactly.
 *
 * The curve is the one the sheet writes as `cubic-bezier(0.23, 1, 0.32, 1)`,
 * and the stage's clip-path and this fold have to land on the same frame; an
 * approximation (count-up.ts uses ease-out-quint for a number nobody lines up
 * against anything) would drift from it by a few percent mid-flight. Newton's
 * method on x(u), with bisection when the slope is too flat to trust — the
 * same solver browsers use.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (x: number): number => {
    let u = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(u) - x;
      if (Math.abs(err) < 1e-7) return u;
      const d = slopeX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0, hi = 1;
    u = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(u);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return t => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solve(t)));
}

export const easeOut = cubicBezier(...FLIP_EASE);

/** 0 below `a`, 1 above `b`, a straight line between. */
export function ramp(v: number, a: number, b: number): number {
  if (b <= a) return v >= b ? 1 : 0;
  return Math.min(1, Math.max(0, (v - a) / (b - a)));
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Pixels to a hundredth, for strings that stay short and stable. */
const px = (n: number) => Math.round(n * 100) / 100;
/** A scale to four places: it multiplies a tile's whole width, and two places
 *  of a 3.27× scale would land a 640px rim most of a pixel out. */
const ratio = (n: number) => Math.round(n * 10000) / 10000;

/** A tile's start and end: its cluster on the board (null when the cluster was
 *  not on screen), and its place in the navigator. */
export interface FlipTile { id: string; board: FlipRect | null; nav: FlipRect }

export interface FlipPlan {
  /** `flip` tweens every tile's rect; `fade` cross-fades the two surfaces;
   *  `instant` is the end state at once. */
  mode: "flip" | "fade" | "instant";
  direction: FoldDirection;
  duration: number;
  tiles: FlipTile[];
}

/** What one tile wears on one frame. The rim takes the whole transform; the
 *  body (face, rows, pill) only its translate, so its words stay 1:1. */
export interface TileFrame {
  rim: string;
  body: string;
  rimOpacity: number;
  bodyOpacity: number;
}

export interface FlipFrame {
  /** Milliseconds into the fold. */
  t: number;
  /** The eased progress along the fold's own direction, 0 → 1. */
  eased: number;
  /** How folded the board is: 0 is the full board, 1 the navigator. Opening
   *  runs it up, closing runs it down. */
  fold: number;
  done: boolean;
  /** The opacity the hidden-to-be board is drawn at. */
  board: number;
  /** The opacity of the navigator as a whole (below 1 only in a cross-fade). */
  nav: number;
  /** Per tile; empty in a cross-fade, where no tile is moved. */
  tiles: Map<string, TileFrame>;
}

/**
 * The fold from the board's cluster rects to the navigator's tile rects, or
 * back. Both maps are keyed by session id and must be in one coordinate space
 * — the page's, as readBoardClusterRects and readTileRects measure them.
 */
export function planFlip({ board, nav, direction, reduced = prefersReducedMotion(), limit = FLIP_TILE_LIMIT }: {
  board: ReadonlyMap<string, FlipRect>;
  nav: ReadonlyMap<string, FlipRect>;
  direction: FoldDirection;
  reduced?: boolean;
  limit?: number;
}): FlipPlan {
  const tiles = [...nav].map(([id, rect]) => ({ id, board: board.get(id) ?? null, nav: rect }));
  if (reduced) return { mode: "instant", direction, duration: 0, tiles };
  return {
    mode: tiles.length > limit ? "fade" : "flip",
    direction,
    duration: direction === "open" ? FLIP_OPEN_MS : FLIP_CLOSE_MS,
    tiles,
  };
}

/** One frame of `plan`, `t` milliseconds in. Pure: the same plan and time
 *  always draw the same frame, which is what the tests pin. */
export function flipFrame(plan: FlipPlan, t: number): FlipFrame {
  const raw = plan.duration > 0 ? Math.min(1, Math.max(0, t / plan.duration)) : 1;
  const eased = easeOut(raw);
  const fold = plan.direction === "open" ? eased : 1 - eased;
  const done = raw >= 1;
  const tiles = new Map<string, TileFrame>();

  if (plan.mode === "fade") {
    return { t, eased, fold, done, board: 1 - fold, nav: fold, tiles };
  }

  const words = ramp(fold, WORDS_IN_FROM, 1);
  for (const { id, board, nav } of plan.tiles) {
    if (!board || fold >= 1) {
      // Nothing to fly from (the cluster was off screen), or already home:
      // the tile appears where it is, with its words.
      tiles.set(id, { rim: "none", body: "none", rimOpacity: board ? 1 : words, bodyOpacity: words });
      continue;
    }
    const x = lerp(board.x, nav.x, fold), y = lerp(board.y, nav.y, fold);
    const w = lerp(board.w, nav.w, fold), h = lerp(board.h, nav.h, fold);
    const dx = px(x - nav.x), dy = px(y - nav.y);
    const sx = nav.w > 0 ? ratio(w / nav.w) : 1, sy = nav.h > 0 ? ratio(h / nav.h) : 1;
    tiles.set(id, {
      rim: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
      body: `translate(${dx}px, ${dy}px)`,
      rimOpacity: 1,
      bodyOpacity: words,
    });
  }
  return { t, eased, fold, done, board: 1 - ramp(fold, 0, BOARD_OUT_BY), nav: 1, tiles };
}

/** The clock a fold runs on: a time source and a way to be called back. */
export interface FlipClock {
  now(): number;
  schedule(fn: () => void): unknown;
  cancel(handle: unknown): void;
}

/** The timer clock: performance.now() and a 16ms timeout. A timeout rather
 *  than requestAnimationFrame so a fold in a background tab still finishes —
 *  late, at its end state, but finishes — instead of waiting for a frame. */
export const timerClock: FlipClock = {
  now: () => performance.now(),
  schedule: fn => setTimeout(fn, FRAME_MS),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Running {
  /** Stops at the current frame. `finished` then resolves false. */
  cancel(): void;
  /** True when it ran to its end, false when cancelled. */
  finished: Promise<boolean>;
}

/**
 * Calls `onFrame(raw, eased)` from 0 to 1 over `duration` on `clock`, the
 * first call synchronously. A duration of zero is one call at 1.
 */
export function runTween(duration: number, onFrame: (raw: number, eased: number) => void, clock: FlipClock = timerClock): Running {
  let handle: unknown = null;
  let settle: (ran: boolean) => void = () => {};
  let over = false;
  const finished = new Promise<boolean>(resolve => { settle = resolve; });
  const start = clock.now();
  const tick = () => {
    handle = null;
    if (over) return;
    const raw = duration > 0 ? Math.min(1, Math.max(0, (clock.now() - start) / duration)) : 1;
    onFrame(raw, easeOut(raw));
    if (raw >= 1) { over = true; settle(true); return; }
    handle = clock.schedule(tick);
  };
  tick();
  return {
    cancel() {
      if (over) return;
      over = true;
      if (handle != null) clock.cancel(handle);
      settle(false);
    },
    finished,
  };
}

/** Runs `plan`, handing every frame to `onFrame`, frame 0 before it returns. */
export function runFlip(plan: FlipPlan, onFrame: (frame: FlipFrame) => void, clock: FlipClock = timerClock): Running {
  return runTween(plan.duration, raw => onFrame(flipFrame(plan, raw * plan.duration)), clock);
}

// ---------------------------------------------------------------------------
// Reading the two ends off the page, and writing frames onto it.

/** React Flow's camera as it writes it on `.react-flow__viewport`:
 *  `translate(Xpx,Ypx) scale(Z)`. Null for anything else. */
export function parseViewportTransform(transform: string | null | undefined): { x: number; y: number; zoom: number } | null {
  const m = /translate\(\s*(-?[\d.e+-]+)px\s*,\s*(-?[\d.e+-]+)px\s*\)\s*scale\(\s*([\d.e+-]+)\s*\)/.exec(transform ?? "");
  if (!m) return null;
  const [x, y, zoom] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return [x, y, zoom].every(Number.isFinite) && zoom > 0 ? { x, y, zoom } : null;
}

/** The part of a cluster (cluster-bounds.ts) the screen rect needs: its box in
 *  layout units, which is where SessionClusters draws it. */
export interface LayoutBox { sessionId: string; x: number; y: number; w: number; h: number }

/**
 * Where each cluster box is on the page: its layout box through the camera,
 * from the pane's top-left corner — the same arithmetic as the transform
 * SessionClusters applies to its layer. Only boxes that show at least partly
 * inside `pane` are returned; a tile whose cluster was off screen has nowhere
 * to fly from and appears in place instead (flipFrame).
 */
export function clusterScreenRects(
  boxes: readonly LayoutBox[],
  viewport: { x: number; y: number; zoom: number },
  pane: { left: number; top: number; width: number; height: number },
): Map<string, FlipRect> {
  const out = new Map<string, FlipRect>();
  for (const c of boxes) {
    const r = {
      x: pane.left + viewport.x + c.x * viewport.zoom,
      y: pane.top + viewport.y + c.y * viewport.zoom,
      w: c.w * viewport.zoom,
      h: c.h * viewport.zoom,
    };
    const visible = r.x < pane.left + pane.width && r.x + r.w > pane.left && r.y < pane.top + pane.height && r.y + r.h > pane.top;
    if (visible) out.set(c.sessionId, r);
  }
  return out;
}

/**
 * The board's cluster rects on the page, read just before the stage opens (or
 * once the board is back, for the close). `flow` is React Flow's root element
 * (`.react-flow`); the camera is passed in when the caller has it from
 * useReactFlow().getViewport(), and otherwise read off the viewport element's
 * own inline transform — no computed style is asked for.
 */
export function readBoardClusterRects(
  flow: Element | null,
  boxes: readonly LayoutBox[],
  viewport?: { x: number; y: number; zoom: number },
): Map<string, FlipRect> {
  if (!flow) return new Map();
  const camera = viewport
    ?? parseViewportTransform(flow.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform);
  if (!camera) return new Map();
  return clusterScreenRects(boxes, camera, flow.getBoundingClientRect());
}

/** Every navigator tile's rect on the page, by session id. */
export function readTileRects(root: ParentNode | null): Map<string, FlipRect> {
  const out = new Map<string, FlipRect>();
  if (!root) return out;
  for (const el of root.querySelectorAll<HTMLElement>("[data-nav-session]")) {
    const r = el.getBoundingClientRect();
    out.set(el.dataset.navSession!, { x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
}

/** The two layers of one tile a frame writes to. */
export interface TileParts { rim: HTMLElement | null; body: HTMLElement | null }

/** Writes `frame` onto the navigator: each tile's rim and body, and the
 *  navigator's own opacity for a cross-fade. */
export function applyFlipFrame(frame: FlipFrame, root: HTMLElement, parts: ReadonlyMap<string, TileParts>): void {
  root.style.opacity = frame.nav >= 1 ? "" : String(px(frame.nav));
  for (const [id, { rim, body }] of parts) {
    const f = frame.tiles.get(id);
    if (rim) {
      rim.style.transform = f && f.rim !== "none" ? f.rim : "";
      rim.style.opacity = f && f.rimOpacity < 1 ? String(px(f.rimOpacity)) : "";
    }
    if (body) {
      body.style.transform = f && f.body !== "none" ? f.body : "";
      body.style.opacity = f && f.bodyOpacity < 1 ? String(px(f.bodyOpacity)) : "";
    }
  }
}

/** Takes every inline style a fold wrote back off, so the sheet is in charge
 *  of the navigator again. */
export function clearFlip(root: HTMLElement, parts: ReadonlyMap<string, TileParts>): void {
  root.style.opacity = "";
  for (const { rim, body } of parts.values()) {
    for (const el of [rim, body]) {
      if (!el) continue;
      el.style.transform = "";
      el.style.opacity = "";
    }
  }
}
