// The fold between the board and its navigator is a FLIP on one timer clock
// (DESIGN-UI decision 1): each tile is laid out where it belongs and drawn, for
// 280ms opening or 200ms closing on a soft-start deceleration, as if it started where
// its cluster stood on the board. The prototype ran every frame off one clock
// because its headless Chromium stalled animation promises, and the stage's
// own morph rides the same beat — so the clock, the curve and the frames are
// pinned here with fake timers, frame by frame, rather than trusted to a
// browser.
//
// Three promises besides the motion itself: the tile's words are never scaled
// (only the rim, which is geometry, takes the scale); above 60 clusters the
// fold drops to a cross-fade that moves no tile at all; and under reduced
// motion it is one frame, the end state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_OUT_BY, FLIP_CLOSE_MS, FLIP_EASE, FLIP_OPEN_MS, FLIP_TILE_LIMIT, FRAME_MS, MAX_FRAME_STEP_MS, WORDS_IN_FROM,
  clusterScreenRects, cubicBezier, easeOut, flipFrame, frameClock, parseViewportTransform, planFlip, ramp, runFlip, runTween,
  type FlipClock, type FlipFrame, type FlipRect,
} from "../navigator-flip";

const BOARD: FlipRect = { x: 600, y: 300, w: 640, h: 400 };
const NAV: FlipRect = { x: 14, y: 120, w: 196, h: 242 };

const plan = (direction: "open" | "close", extra: Partial<Parameters<typeof planFlip>[0]> = {}) => planFlip({
  board: new Map([["s1", BOARD]]),
  nav: new Map([["s1", NAV], ["offscreen", { x: 14, y: 400, w: 196, h: 64 }]]),
  direction,
  reduced: false,
  ...extra,
});

/** The rect a tile's rim is drawn at on a frame: its navigator rect, through
 *  the transform the frame gives it (transform-origin 0 0). */
function drawnRim(f: FlipFrame, id: string, nav: FlipRect): FlipRect {
  const rim = f.tiles.get(id)!.rim;
  if (rim === "none") return nav;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+), ([\d.]+)\)/.exec(rim)!;
  const [dx, dy, sx, sy] = m.slice(1).map(Number);
  return { x: nav.x + dx, y: nav.y + dy, w: nav.w * sx, h: nav.h * sy };
}

/** Two rects agree to within half a pixel: the frame's numbers are rounded
 *  for the style strings they become. */
function expectRect(actual: FlipRect, expected: FlipRect, why?: string) {
  for (const k of ["x", "y", "w", "h"] as const) expect(actual[k], `${why ?? ""} ${k}`).toBeCloseTo(expected[k], 0);
}

describe("the curve", () => {
  const ease = cubicBezier(...FLIP_EASE);

  it("starts at 0, ends at 1, and never runs backwards", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const v = ease(i / 100);
      expect(v, `at ${i / 100}`).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it("is cubic-bezier(0.32, 0.72, 0, 1), solved rather than approximated", () => {
    // Walk the curve's own parameter finely and read y where x crosses each
    // probe: the bezier as CSS defines it, with no solver involved.
    const point = (u: number) => {
      const [x1, y1, x2, y2] = FLIP_EASE;
      const b = (p1: number, p2: number) => 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u ** 2 * p2 + u ** 3;
      return { x: b(x1, x2), y: b(y1, y2) };
    };
    for (const probe of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      let u = 0;
      while (point(u).x < probe) u += 1e-5;
      expect(ease(probe), `at ${probe}`).toBeCloseTo(point(u).y, 3);
    }
  });

  it("starts softly and still decelerates: a first frame the eye can follow, most of the travel by the middle", () => {
    expect(FLIP_EASE).toEqual([0.32, 0.72, 0, 1]);
    // One 60Hz frame into the open moves the window less than a sixth of the
    // way; the house ease-out moved it almost a third.
    expect(ease(16.7 / FLIP_OPEN_MS)).toBeLessThan(0.16);
    expect(cubicBezier(0.23, 1, 0.32, 1)(16.7 / 220)).toBeGreaterThan(0.3);
    expect(ease(0.5)).toBeGreaterThan(0.85);
    expect(easeOut(0.5)).toBe(ease(0.5));
  });

  it("ramps between two points and clamps outside them", () => {
    expect(ramp(0.2, 0.45, 1)).toBe(0);
    expect(ramp(1, 0.45, 1)).toBe(1);
    expect(ramp(0.725, 0.45, 1)).toBeCloseTo(0.5);
  });
});

describe("planning a fold", () => {
  it("opens in 280ms and closes in 200ms", () => {
    expect(plan("open").duration).toBe(FLIP_OPEN_MS);
    expect(plan("close").duration).toBe(FLIP_CLOSE_MS);
    expect([FLIP_OPEN_MS, FLIP_CLOSE_MS]).toEqual([280, 200]);
    expect(plan("open").mode).toBe("flip");
  });

  it("has no duration at all under reduced motion", () => {
    const p = plan("open", { reduced: true });
    expect(p.mode).toBe("instant");
    expect(p.duration).toBe(0);
  });

  it("cross-fades instead of moving tiles above 60 clusters", () => {
    const many = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`s${i}`, NAV] as const));
    expect(FLIP_TILE_LIMIT).toBe(60);
    expect(planFlip({ board: many(60), nav: many(60), direction: "open", reduced: false }).mode).toBe("flip");
    expect(planFlip({ board: many(61), nav: many(61), direction: "open", reduced: false }).mode).toBe("fade");
  });

  it("gives a tile with no cluster on screen nothing to fly from", () => {
    const p = plan("open");
    expect(p.tiles.find(t => t.id === "s1")!.board).toEqual(BOARD);
    expect(p.tiles.find(t => t.id === "offscreen")!.board).toBeNull();
  });
});

describe("a frame of the fold", () => {
  it("opens from the cluster's rect on the board to the tile's rect in the navigator", () => {
    const p = plan("open");
    expectRect(drawnRim(flipFrame(p, 0), "s1", NAV), BOARD);
    const end = flipFrame(p, FLIP_OPEN_MS);
    expect(end.done).toBe(true);
    expect(end.tiles.get("s1")).toEqual({ rim: "none", body: "none", rimOpacity: 1, bodyOpacity: 1 });
  });

  it("closes the mirror way, ending on the board's rect", () => {
    const p = plan("close");
    expect(flipFrame(p, 0).tiles.get("s1")!.rim).toBe("none");
    const end = flipFrame(p, FLIP_CLOSE_MS);
    expectRect(drawnRim(end, "s1", NAV), BOARD);
    expect(end.tiles.get("s1")!.bodyOpacity, "the words are gone when the board is back").toBe(0);
    expect(end.board).toBe(1);
  });

  it("travels in a straight line on the eased progress", () => {
    const p = plan("open");
    for (const t of [20, 55, 110, 165]) {
      const f = flipFrame(p, t);
      const k = easeOut(t / FLIP_OPEN_MS);
      expect(f.fold).toBeCloseTo(k, 6);
      const r = drawnRim(f, "s1", NAV);
      expect(r.x).toBeCloseTo(BOARD.x + (NAV.x - BOARD.x) * k, 1);
      expect(r.y).toBeCloseTo(BOARD.y + (NAV.y - BOARD.y) * k, 1);
      expect(r.w).toBeCloseTo(BOARD.w + (NAV.w - BOARD.w) * k, 0);
    }
  });

  it("scales the rim and only translates the words, so no frame draws a squashed name", () => {
    const f = flipFrame(plan("open"), 40);
    const tile = f.tiles.get("s1")!;
    expect(tile.rim).toMatch(/scale\(/);
    expect(tile.body).toMatch(/^translate\([^)]*\)$/);
    expect(tile.rim.startsWith(tile.body), "the words ride with the rim's corner").toBe(true);
  });

  it("brings the words in from 0.45 of the way and takes the board's cards out by halfway", () => {
    const p = plan("open");
    for (let t = 0; t <= FLIP_OPEN_MS; t += 4) {
      const f = flipFrame(p, t);
      const words = f.tiles.get("s1")!.bodyOpacity;
      if (f.fold <= WORDS_IN_FROM) expect(words, `${t}ms`).toBe(0);
      if (f.fold >= BOARD_OUT_BY) expect(f.board, `${t}ms`).toBe(0);
      expect(f.nav).toBe(1);
    }
    expect(WORDS_IN_FROM).toBeLessThan(BOARD_OUT_BY);
  });

  it("fades a tile with nowhere to fly from in place, with its words", () => {
    const f = flipFrame(plan("open"), 80);
    const tile = f.tiles.get("offscreen")!;
    expect(tile.rim).toBe("none");
    expect(tile.body).toBe("none");
    expect(tile.rimOpacity).toBe(tile.bodyOpacity);
    expect(tile.bodyOpacity).toBe(ramp(f.fold, WORDS_IN_FROM, 1));
  });

  it("moves no tile in a cross-fade, and fades the two surfaces against each other", () => {
    const nav = new Map(Array.from({ length: 61 }, (_, i) => [`s${i}`, NAV] as const));
    const p = planFlip({ board: nav, nav, direction: "open", reduced: false });
    const mid = flipFrame(p, 60);
    expect(mid.tiles.size).toBe(0);
    expect(mid.nav).toBeCloseTo(mid.fold, 6);
    expect(mid.board).toBeCloseTo(1 - mid.fold, 6);
  });

  it("is the end state at once under reduced motion", () => {
    const open = flipFrame(plan("open", { reduced: true }), 0);
    expect(open.done).toBe(true);
    expect(open.fold).toBe(1);
    expect(open.board).toBe(0);
    expect(open.tiles.get("s1")!.rim).toBe("none");
    const close = flipFrame(plan("close", { reduced: true }), 0);
    expect(close.done).toBe(true);
    expect(close.fold).toBe(0);
    expect(close.board).toBe(1);
  });
});

describe("the clock", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("delivers frame 0 before it returns, so the first paint already shows the start", () => {
    const frames: FlipFrame[] = [];
    runFlip(plan("open"), f => frames.push(f));
    expect(frames).toHaveLength(1);
    expect(frames[0].t).toBe(0);
    expectRect(drawnRim(frames[0], "s1", NAV), BOARD);
  });

  it("runs every frame off one clock and finishes on time, at its end", async () => {
    const frames: FlipFrame[] = [];
    const run = runFlip(plan("open"), f => frames.push(f));
    vi.advanceTimersByTime(FLIP_OPEN_MS - 20);
    expect(frames.at(-1)!.done).toBe(false);
    vi.advanceTimersByTime(40);
    expect(frames.at(-1)!.done).toBe(true);
    expect(frames.at(-1)!.fold).toBe(1);
    await expect(run.finished).resolves.toBe(true);
    // Time only moves forward, one tick at a time.
    for (let i = 1; i < frames.length; i++) expect(frames[i].t).toBeGreaterThan(frames[i - 1].t);
    expect(frames.length).toBeGreaterThan(10);
    const count = frames.length;
    vi.advanceTimersByTime(500);
    expect(frames.length, "nothing more after the end").toBe(count);
  });

  it("closes in 200ms on the same clock", async () => {
    const frames: FlipFrame[] = [];
    const run = runFlip(plan("close"), f => frames.push(f));
    vi.advanceTimersByTime(FLIP_CLOSE_MS + 16);
    await expect(run.finished).resolves.toBe(true);
    expect(frames.at(-1)!.fold).toBe(0);
  });

  it("is one frame and done under reduced motion, with nothing scheduled", async () => {
    const frames: FlipFrame[] = [];
    const run = runFlip(plan("open", { reduced: true }), f => frames.push(f));
    expect(frames).toHaveLength(1);
    expect(frames[0].done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(run.finished).resolves.toBe(true);
  });

  it("stops where it is when cancelled, and says it did not finish", async () => {
    const frames: FlipFrame[] = [];
    const run = runFlip(plan("open"), f => frames.push(f));
    vi.advanceTimersByTime(64);
    run.cancel();
    const count = frames.length;
    vi.advanceTimersByTime(500);
    expect(frames.length).toBe(count);
    expect(frames.at(-1)!.done).toBe(false);
    await expect(run.finished).resolves.toBe(false);
  });

  it("ticks on a timeout every frame where the page has no frames to offer", () => {
    const fn = vi.fn();
    frameClock.schedule(fn);
    vi.advanceTimersByTime(16);
    expect(fn.mock.calls).toEqual([[false]]);
  });

  it("hands the stage's morph the same ticks: raw progress and the eased one", async () => {
    const seen: [number, number][] = [];
    const run = runTween(100, (raw, eased) => seen.push([raw, eased]));
    vi.advanceTimersByTime(120);
    await run.finished;
    expect(seen[0]).toEqual([0, 0]);
    expect(seen.at(-1)).toEqual([1, 1]);
    for (const [raw, eased] of seen) expect(eased).toBe(easeOut(raw));
  });
});

describe("the clock on the page's frames", () => {
  /** A clock whose frames are handed out by the test: `frame(ms)` moves time
   *  on and paints, `timeout(ms)` moves it on as a background tab's timer. */
  function handClock() {
    let now = 0;
    let due: ((painted: boolean) => void) | null = null;
    const clock: FlipClock = {
      now: () => now,
      schedule: fn => { due = fn; return fn; },
      cancel: () => { due = null; },
    };
    const fire = (ms: number, painted: boolean) => { now += ms; const fn = due; due = null; fn?.(painted); };
    return { clock, frame: (ms: number) => fire(ms, true), timeout: (ms: number) => fire(ms, false) };
  }

  it("moves at most two frames on a frame the page was late to paint, so a hitch postpones the motion instead of skipping it", () => {
    const c = handClock();
    const seen: number[] = [];
    runTween(FLIP_OPEN_MS, raw => seen.push(raw * FLIP_OPEN_MS), c.clock);
    c.frame(80);
    expect(seen.at(-1), "the stage mounting under the first frame: one frame, the motion's beginning").toBe(FRAME_MS);
    c.frame(16);
    expect(seen.at(-1)).toBe(FRAME_MS + 16);
    c.frame(70);
    expect(seen.at(-1), "a long task later on").toBe(FRAME_MS + 16 + MAX_FRAME_STEP_MS);
  });

  it("falls no more than its own length behind on a page that stays slow", () => {
    const c = handClock();
    let last = 0;
    runTween(FLIP_OPEN_MS, raw => { last = raw * FLIP_OPEN_MS; }, c.clock);
    for (let i = 0; i < 6; i++) c.frame(100);
    expect(last, "600ms in, six frames of 100ms").toBe(FLIP_OPEN_MS);
    const d = handClock();
    runTween(FLIP_OPEN_MS, raw => { last = raw * FLIP_OPEN_MS; }, d.clock);
    for (let i = 0; i < 2; i++) d.frame(100);
    expect(last, "200ms in, two late frames: two capped steps").toBe(FRAME_MS + MAX_FRAME_STEP_MS);
    for (let i = 0; i < 3; i++) d.frame(100);
    expect(last, "500ms in: a whole open behind, and no further").toBe(500 - FLIP_OPEN_MS);
  });

  it("keeps two tweens started together in step through a late first frame", () => {
    // The fold and the morph start in one task, a few milliseconds apart, and
    // the page paints both on the same frames.
    let now = 0;
    const pending: ((painted: boolean) => void)[] = [];
    const clock: FlipClock = { now: () => now, schedule: fn => (pending.push(fn), fn), cancel: () => {} };
    const fold: number[] = [], morph: number[] = [];
    runTween(FLIP_OPEN_MS, raw => fold.push(raw), clock);
    now = 3;
    runTween(FLIP_OPEN_MS, raw => morph.push(raw), clock);
    for (const step of [90, 16, 17, 16]) {
      now += step;
      for (const fn of pending.splice(0)) fn(true);
      expect(fold.at(-1), `${now}ms`).toBe(morph.at(-1));
    }
  });

  it("moves by the time that passed on a timeout, so a background tab still finishes", async () => {
    const c = handClock();
    let last = 0;
    const run = runTween(FLIP_OPEN_MS, raw => { last = raw; }, c.clock);
    // A background tab's timers run a second apart at best.
    c.timeout(1000);
    expect(last).toBe(1);
    await expect(run.finished).resolves.toBe(true);
  });
});

describe("reading the board's clusters off the page", () => {
  it("puts a cluster's layout box through React Flow's camera, from the pane's corner", () => {
    const rects = clusterScreenRects(
      [{ sessionId: "s1", x: 100, y: 50, w: 400, h: 200 }],
      { x: 30, y: -20, zoom: 0.5 },
      { left: 240, top: 52, width: 1200, height: 800 },
    );
    expect(rects.get("s1")).toEqual({ x: 240 + 30 + 50, y: 52 - 20 + 25, w: 200, h: 100 });
  });

  it("leaves out a cluster that is not on screen, which then appears in place", () => {
    const rects = clusterScreenRects(
      [{ sessionId: "away", x: 5000, y: 0, w: 400, h: 200 }, { sessionId: "here", x: 0, y: 0, w: 400, h: 200 }],
      { x: 0, y: 0, zoom: 1 },
      { left: 0, top: 0, width: 1200, height: 800 },
    );
    expect([...rects.keys()]).toEqual(["here"]);
  });

  it("reads the camera React Flow writes on its viewport, and nothing else", () => {
    expect(parseViewportTransform("translate(12px,-34.5px) scale(0.42)")).toEqual({ x: 12, y: -34.5, zoom: 0.42 });
    expect(parseViewportTransform("translate(0px, 0px) scale(1)")).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(parseViewportTransform("")).toBeNull();
    expect(parseViewportTransform(undefined)).toBeNull();
    expect(parseViewportTransform("scale(2)")).toBeNull();
  });
});
