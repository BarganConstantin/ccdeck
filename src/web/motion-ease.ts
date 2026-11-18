/** V4's one curve, the sheet's --ease (styles/tokens.css), for an animation
 *  run through the Web Animations API: its `easing` takes a timing function
 *  and cannot read a custom property. v4-tokens.test.ts holds the two to one
 *  value, as it holds navigator-flip.ts's FLIP_EASE to --ease-stage. */
export const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

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

/** V4's stage curve, `--ease-stage`, as a function of progress: the camera's
 *  tween rides it from JS. navigator-flip.ts's FLIP_EASE is the same four
 *  numbers (v4-tokens.test.ts holds both to the sheet). */
export const STAGE_EASE = [0.32, 0.72, 0, 1] as const;
export const stageEase = cubicBezier(...STAGE_EASE);
