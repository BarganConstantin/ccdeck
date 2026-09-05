// A number that arrives at its new value instead of teleporting to it.
//
// The Usage panel's figures are re-read on a timer, so a total can change while
// somebody is looking straight at it. Replaced in one frame, $170 → $269 says
// only "this is different now": no direction, no sense of how much, and no
// signal that anything happened at all if the eye was a few pixels away. Counted
// over a fifth of a second, the same change says up, and roughly how far.
//
// WHAT DOES NOT ANIMATE, and this is most of the panel:
//
//   * the first paint. A page that counts every figure up from zero on load is
//     a slot machine, and it delays the one thing the reader opened it for.
//   * a change of PERIOD. "today $269" and "all time $12.4k" are not the same
//     quantity, so counting between them would be theatre — the number snaps
//     and the label changes with it.
//   * the tables. Twelve rows counting at once is noise; the aggregates at the
//     top are what the eye returns to, and they are the only things here that
//     move.
//   * a change too small to read — under half a percent, or under one whole
//     unit. Counting $269.10 to $269.40 is motion for its own sake.
//
// Written by hand rather than pulled in: this package has no runtime
// dependencies and the client bundle is already 654 KB, which is a poor trade
// for a tween. It is ~60 lines and it is interruptible, which a library would
// also have to be.

/** The strong ease-out this repo uses everywhere else, as a function.
 *
 *  cubic-bezier(0.23, 1, 0.32, 1) is the sheet's `--ease-out`; sampling a real
 *  bezier per frame to match it exactly would be a solver for no gain, and
 *  ease-out-quint is within a couple of percent of it across the whole curve.
 *  Both start fast and settle, which is the property that makes a count read as
 *  arriving rather than as loading. */
const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);

/** How long a count takes. Long enough to be seen as counting — at 200ms the
 *  eye reads a jump — and short enough that nobody waits for the figure. */
export const COUNT_MS = 420;

/** Whether a change is worth counting at all. */
export function worthCounting(from: number, to: number): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (from === to) return false;
  const delta = Math.abs(to - from);
  if (delta < 1) return false;
  const base = Math.max(Math.abs(from), Math.abs(to));
  return base === 0 || delta / base >= 0.005;
}

/** One frame's value on the way from `from` to `to`. Exported for the test,
 *  which is where the shape of the curve is actually pinned. */
export function frameValue(from: number, to: number, elapsedMs: number, durationMs = COUNT_MS): number {
  if (elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;
  return from + (to - from) * easeOutQuint(elapsedMs / durationMs);
}

export interface CountUpDeps {
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  cancel?: (id: number) => void;
  reducedMotion?: () => boolean;
  hidden?: () => boolean;
}

/**
 * Drive `onFrame` from the currently displayed value to `to`.
 *
 * Returns a cancel function. Retargets rather than restarting: a second call
 * while the first is running starts from where the number IS, not from where
 * the last count began, so a value that changes twice in a second never jumps
 * backwards to catch up.
 *
 * `reducedMotion` is asked once per count rather than cached: a reader can turn
 * it on mid-session, and the next change must honour it.
 */
export function countTo(
  from: number,
  to: number,
  onFrame: (value: number) => void,
  deps: CountUpDeps = {},
): () => void {
  const now = deps.now ?? (() => performance.now());
  const raf = deps.raf ?? (cb => requestAnimationFrame(cb));
  const cancel = deps.cancel ?? (id => cancelAnimationFrame(id));
  const reduced = deps.reducedMotion
    ?? (() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  // A HIDDEN TAB LANDS IMMEDIATELY. `requestAnimationFrame` does not fire in a
  // background tab, so a count started there would emit no frames at all and
  // leave the OLD number on screen until the tab came forward — the one state
  // this is supposed to prevent. Nobody is watching the motion either way, so
  // the value is simply set.
  const hidden = deps.hidden ?? (() => typeof document === "object" && document.hidden === true);

  if (reduced() || hidden() || !worthCounting(from, to)) {
    onFrame(to);
    return () => {};
  }

  const started = now();
  let id = 0;
  let live = true;
  const step = () => {
    if (!live) return;
    const elapsed = now() - started;
    onFrame(frameValue(from, to, elapsed));
    if (elapsed < COUNT_MS) id = raf(step);
  };
  id = raf(step);
  return () => { live = false; if (id) cancel(id); };
}
