// The board's reading of the canvas is held while the left column moves
// (2026-10-08). The column eases its width now, and the canvas beside it is
// resized on every frame of that; `canvasSize` is what re-packs and re-frames
// the board (use-reframe.ts), so taken on every frame a 288px open could
// re-column the board several times mid-move. The reading is held until the
// column settles, and only the last one is taken.
//
// Two pieces, both run here: heldReading, which holds and takes, and
// useColumnSettle, which says when the move ends — on a React of three hooks,
// since the suite has no DOM to mount the deck in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  const layoutEffects: Array<() => void> = [];
  const motion = { reduced: false };
  const react = {
    useRef<T>(init: T) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i] as { current: T };
    },
    // Run after every render: the hook under test guards its own re-runs.
    useLayoutEffect(run: () => void) { layoutEffects.push(run); },
    useEffect() {},
    useState<T>(init: T) { return [init, () => {}] as const; },
    useCallback<T>(fn: T) { return fn; },
  };
  function render<A, R>(hook: (arg: A) => R, arg: A): R {
    cursor = 0;
    layoutEffects.length = 0;
    const out = hook(arg);
    for (const run of layoutEffects) run();
    return out;
  }
  return { react, render, motion, reset: () => { slots = []; } };
});

vi.mock("react", () => h.react);
vi.mock("../viewport-motion", () => ({ prefersReducedMotion: () => h.motion.reduced }));

import { heldReading } from "../use-canvas-size";
import { COLUMN_MOVE_MS, useColumnSettle } from "../use-left-column";

describe("heldReading — the canvas's size, held through a move", () => {
  let clock = 0;
  let settleAt = 0;
  let taken: Array<[number, number]> = [];
  const timers = new Map<number, { run: () => void; at: number }>();
  let nextId = 1;
  const reading = () => heldReading({
    settleAt: () => settleAt,
    now: () => clock,
    take: (w, hgt) => { taken.push([w, hgt]); },
    schedule: (run, ms) => { const id = nextId++; timers.set(id, { run, at: clock + ms }); return id; },
    cancel: id => { timers.delete(id); },
  });
  const advanceTo = (t: number) => {
    clock = t;
    for (const [id, timer] of [...timers]) if (timer.at <= t) { timers.delete(id); timer.run(); }
  };
  beforeEach(() => { clock = 1000; settleAt = 0; taken = []; timers.clear(); });

  it("takes a reading at once when the column is still", () => {
    const r = reading();
    r.read(800, 600);
    expect(taken).toEqual([[800, 600]]);
    expect(timers.size).toBe(0);
  });

  it("takes only the last reading of a move, once, when the move ends", () => {
    const r = reading();
    settleAt = 1260;
    for (const [t, w] of [[1016, 1100], [1032, 1060], [1100, 1010], [1240, 1000]] as const) {
      advanceTo(t);
      r.read(w, 600);
    }
    expect(taken).toEqual([]);
    advanceTo(1259);
    expect(taken).toEqual([]);
    advanceTo(1260);
    expect(taken).toEqual([[1000, 600]]);
    expect(timers.size).toBe(0);
  });

  it("takes a reading at once after the move has ended", () => {
    const r = reading();
    settleAt = 1260;
    advanceTo(1300);
    r.read(900, 600);
    expect(taken).toEqual([[900, 600]]);
  });

  it("drops a held reading when it is disposed, so nothing lands on a gone canvas", () => {
    const r = reading();
    settleAt = 1260;
    r.read(900, 600);
    r.dispose();
    advanceTo(2000);
    expect(taken).toEqual([]);
  });
});

describe("useColumnSettle — when the column's move ends", () => {
  beforeEach(() => { h.reset(); h.motion.reduced = false; vi.spyOn(performance, "now").mockReturnValue(5000); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("holds nothing for the width the deck loaded with", () => {
    expect(h.render(useColumnSettle, 288).current).toBe(0);
    expect(h.render(useColumnSettle, 288).current).toBe(0);
  });

  it("ends a move one frame after the column's own duration, counted from the change", () => {
    h.render(useColumnSettle, 288);
    const settle = h.render(useColumnSettle, 240);
    expect(settle.current).toBe(5000 + COLUMN_MOVE_MS + 20);
    // A render that changes nothing does not push the end back.
    vi.spyOn(performance, "now").mockReturnValue(5100);
    expect(h.render(useColumnSettle, 240).current).toBe(5000 + COLUMN_MOVE_MS + 20);
  });

  it("holds nothing under reduced motion, where the column does not move", () => {
    h.motion.reduced = true;
    h.render(useColumnSettle, 0);
    expect(h.render(useColumnSettle, 288).current).toBe(0);
  });
});
