// How big the canvas is.
//
// Lifted out of App.tsx's `Inner`, where the observer sat two hundred and fifty
// lines below the ref it fills and the watchdog that reads that ref sat
// between them. One ResizeObserver on the canvas element keeps two readings:
// `canvasSize`, quantised to 40px so a nudge of the window cannot reflow the
// layout, and `paneSizeRef`, whole, because an intersection test must not
// inherit that tolerance (#615). Both are written here and nowhere else.
import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

import { BOARD_HEAD_CLASS } from "./board-header";
import type { PaneSize } from "./drift";

/**
 * The board's reading of the canvas, held while the left column moves.
 *
 * `read` is handed every size the observer reports. Outside a move it is
 * passed to `take` at once; during one only the latest is kept, and taken when
 * the move ends — once, however many frames the move lasted. `settleAt` is when
 * that is, in the clock `now` reads.
 */
export function heldReading({ settleAt, now, take, schedule, cancel }: {
  settleAt: () => number;
  now: () => number;
  take: (width: number, height: number) => void;
  schedule: (run: () => void, ms: number) => number;
  cancel: (id: number) => void;
}) {
  let held: number | null = null;
  const drop = () => { if (held != null) cancel(held); held = null; };
  return {
    read(width: number, height: number) {
      drop();
      const wait = settleAt() - now();
      if (wait > 0) { held = schedule(() => { held = null; take(width, height); }, wait); return; }
      take(width, height);
    },
    dispose: drop,
  };
}

/**
 * @param settleRef When the left column's move ends, in `performance.now()`
 *   time (useColumnSettle in use-left-column.ts). The canvas is the grid's 1fr
 *   beside the column, so it is resized on every frame of the column's width,
 *   and `canvasSize` is what re-packs and re-frames the board (use-reframe.ts).
 *   Taken on those frames, a 288px open would cross the 40px quantum up to
 *   seven times and could re-column the board mid-move. Until the column
 *   settles the reading is held, and the last one is taken when it has: the
 *   board rides the canvas's left edge for the move and is re-packed once, at
 *   the end. `paneSizeRef` is not held — the drift watchdog wants the pane as
 *   it is.
 */
export function useCanvasSize(settleRef?: MutableRefObject<number>) {
  /** The pane the watchdog measures nodes against, in CSS pixels.
   *
   *  Written by the ResizeObserver below, which is the one thing in the deck
   *  that knows how big the canvas is. A ref rather
   *  than the `canvasSize` state beside it for two reasons: the drift watchdog
   *  in App.tsx is registered once and polls, so it wants a value it can read without
   *  being torn down and rebuilt on every resize; and `canvasSize` is
   *  deliberately quantised to 40px so a one-pixel resize cannot reflow the
   *  layout, which is exactly the rounding an intersection test must not
   *  inherit. Same observer, same element, same callback — this one keeps the
   *  reading whole.
   *
   *  Null until that observer first fires, and null for good on a browser
   *  without ResizeObserver. Both mean "the pane has not been measured", which
   *  shouldRefit treats as a reason not to decide. */
  const paneSizeRef = useRef<PaneSize | null>(null);
  // Width of the canvas column, not the window: the side panels come and go,
  // and a layout packed for the whole window would run under them. Measured
  // rather than derived from the panel flags so it stays right however the
  // grid is configured.
  // HTMLElement rather than HTMLDivElement: the canvas is a <main> now (#381),
  // and nothing here reads a property a <div> has and a <main> does not.
  const canvasRef = useRef<HTMLElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const remeasureRef = useRef<() => void>(() => {});
  // A layout effect, so App's own (which runs after this one and asks for the
  // strip's first measure) finds `remeasureRef` set, and the commit that mounts
  // the board is packed for the right height.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Quantised so a one-pixel resize doesn't reflow the canvas.
    const reading = heldReading({
      settleAt: () => settleRef?.current ?? 0,
      now: () => performance.now(),
      take: (width, height) => setCanvasSize(prev =>
        (Math.abs(prev.w - width) > 40 || Math.abs(prev.h - height) > 40)
          ? { w: width, h: height } : prev),
      schedule: (run, ms) => window.setTimeout(run, ms),
      cancel: id => window.clearTimeout(id),
    });
    // The board is the cell less the header strip (board-header.css), and it
    // is the board that is packed and watched, not the cell. The strip is a
    // fixed height, so it is read off the element rather than guessed at.
    const headH = () => el.querySelector<HTMLElement>(`:scope > .${BOARD_HEAD_CLASS}`)?.offsetHeight ?? 0;
    const ro = new ResizeObserver(entries => {
      const seen = entries[0]?.contentRect;
      if (!seen) return;
      const r = { width: seen.width, height: seen.height - headH() };
      // Unrounded, and updated on every callback: the drift watchdog compares
      // node boxes against this rectangle, and a 40px tolerance in an
      // intersection test is a 40px strip of the canvas that reads as
      // off-screen. It is also the reading that has to be current the instant a
      // side panel opens or closes, which is precisely when the pane changes
      // width by 240-360px and the watchdog is most likely to be wrong (#615).
      paneSizeRef.current = { width: r.width, height: r.height };
      reading.read(r.width, r.height);
    });
    ro.observe(el);
    paneSizeRef.current = { width: el.clientWidth, height: el.clientHeight };
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    // The strip coming or going changes the board without changing the cell,
    // so the observer above never hears of it: App says so (remeasureCanvas),
    // on mount too, which is where the first reading above is corrected.
    // Through the same held reading as the observer's, so a reading held while
    // the left column moves is replaced by this one, not overwritten behind its
    // back, and nothing re-packs mid-move; the pane ref is whole and at once.
    remeasureRef.current = () => {
      const width = el.clientWidth, height = el.clientHeight - headH();
      paneSizeRef.current = { width, height };
      reading.read(width, height);
    };
    return () => { ro.disconnect(); reading.dispose(); remeasureRef.current = () => {}; };
  }, []);
  const remeasureCanvas = useCallback(() => remeasureRef.current(), []);

  return { canvasRef, canvasSize, paneSizeRef, remeasureCanvas };
}
