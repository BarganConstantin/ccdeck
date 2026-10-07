// Pressing Recenter after the zoom buttons could fill the console with ~120
// `<pattern> attribute x: Expected length, "NaN"` errors, one burst per press,
// and not every time.
//
// The NaN was not the deck's. Every animated viewport change is a d3-zoom
// transition, and d3-zoom draws it with d3-interpolate's `interpolateZoom`
// (van Wijk and Nuij's smooth zoom). Its closed form has a soft spot: when the
// centre moves a hair while the zoom changes a lot, it subtracts two nearly
// equal large numbers,
//
//   r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)   // b0 ≈ (w1² − w0²) / (4·w0·d)
//
// and gets 0 (log(0) = −Infinity, every frame NaN) or noise (frames heading
// somewhere the animation does not end, then a snap). d3 special-cases a centre
// that does not move at all, d < 1e-6, and not one that moves 1e-5.
//
// Recenter after zooming in is exactly that move: the zoom buttons scale about
// the middle of the pane, the fit's transition is drawn about the same point,
// and the fit lands on the same centre give or take the float rounding of the
// rectangles it measures. The two cases below are real presses, read off the
// pane's d3-zoom state in a browser. Every NaN frame reached React Flow's store,
// `onMove` (the --zoom property, the level-of-detail switch, the stored
// viewport) and the dotted background, which is what said so in the console.
//
// The fix guards the path, not the pattern: zoom-path.ts takes the smooth path
// only when it is one a camera can follow (finite, starting at the view it
// leaves and arriving at the one it was asked for), and otherwise d3's own
// answer for an unmoving centre. A frame that is still not finite holds the
// last good one. use-camera installs it on the pane's d3-zoom behaviour, so
// every transition goes through it, and the deck's one door refuses a target
// that is not a viewport at all.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { interpolateZoom } from "d3-interpolate";

import {
  guardZoomPath, isViewableViewport, straightZoomPath, type ZoomPath, type ZoomView,
} from "../zoom-path";
import { sourceOf } from "./client-source";

/** d3-zoom's view of a transform, exactly as its zoom tween builds it:
 *  `a.invert(p).concat(w / a.k)`, p the middle of the extent and w its longer side. */
function view(t: { k: number; x: number; y: number }, pane: { w: number; h: number }): ZoomView {
  const p = [pane.w / 2, pane.h / 2];
  return [(p[0] - t.x) / t.k, (p[1] - t.y) / t.k, Math.max(pane.w, pane.h) / t.k];
}

const PANE = { w: 1440, h: 848 };
/** Two Recenter presses that drew NaN frames: zoomed in 6 and 5 steps, then Recenter. */
const PRESSES = [
  {
    from: { k: 1.1428968225627365, x: -1101.8838363127659, y: -143.44827124109918 },
    to: { k: 0.3827538329409005, x: 109.85479785873147, y: 233.96272744389734 },
  },
  {
    from: { k: 0.9524139675433954, x: -798.2364664528413, y: -48.87356087473728 },
    to: { k: 0.3827538322415013, x: 109.85478417278351, y: 233.96272104576855 },
  },
].map(({ from, to }) => ({ a: view(from, PANE), b: view(to, PANE) }));

const finite = (v: readonly number[]) => v.every(Number.isFinite);
/** The frames a 400ms transition draws at 60fps, plus both ends. */
const FRAMES = Array.from({ length: 25 }, (_, i) => i / 24);

describe("the smooth zoom d3 draws transitions with", () => {
  it("comes out NaN on the moves Recenter makes after zooming in", () => {
    // The root cause, pinned so a d3 upgrade that fixes it shows up here.
    for (const { a, b } of PRESSES) {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      expect(d).toBeGreaterThan(1e-6); // past d3's own "the centre did not move"
      expect(d).toBeLessThan(1e-4); // and still a hair
      const path = interpolateZoom(a, b);
      expect(FRAMES.slice(0, -1).every(t => !finite(path(t)))).toBe(true);
    }
  });
});

describe("the guarded path", () => {
  const guarded = guardZoomPath(interpolateZoom);

  it("stays finite on those moves, from the view it leaves to the one it was asked for", () => {
    for (const { a, b } of PRESSES) {
      const path = guarded(a, b);
      const frames = FRAMES.map(path);
      expect(frames.every(f => finite(f) && f[2] > 0)).toBe(true);
      expect(frames[0][2]).toBeCloseTo(a[2], 9);
      expect(frames[frames.length - 1][2]).toBeCloseTo(b[2], 9);
      // A zoom out the whole way, never past either end.
      for (let i = 1; i < frames.length; i++) expect(frames[i][2]).toBeGreaterThan(frames[i - 1][2]);
      // The centre stays where both ends have it.
      for (const f of frames) expect(Math.hypot(f[0] - a[0], f[1] - a[1])).toBeLessThan(1e-4);
    }
  });

  it("leaves a path d3 draws well exactly as d3 draws it", () => {
    // A recenter from a focused session: the centre moves hundreds of units.
    const a: ZoomView = [2400, 300, 1300], b: ZoomView = [1594, 496, 3762];
    const smooth = interpolateZoom(a, b), path = guarded(a, b);
    for (const t of FRAMES) expect(path(t)).toEqual(smooth(t));
  });

  it("is finite and arrives across every centre offset and zoom a camera can ask for", () => {
    // From 1e-10 to 1e3 flow units, zooms 0.2 to 1.6 either way: the band d3
    // gets wrong is 1e-6 to about 1e-1, and the sweep runs through it.
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let degenerate = 0;
    for (let n = 0; n < 4000; n++) {
      const w = 1440, k0 = 0.2 * 8 ** rand(), k1 = 0.2 * 8 ** rand();
      const d = 10 ** (-10 + 13 * rand()), angle = rand() * 2 * Math.PI;
      const a: ZoomView = [(rand() - 0.5) * 6000, (rand() - 0.5) * 6000, w / k0];
      const b: ZoomView = [a[0] + d * Math.cos(angle), a[1] + d * Math.sin(angle), w / k1];
      if (!finite(interpolateZoom(a, b)(0.5))) degenerate++;
      const path = guarded(a, b);
      for (const t of FRAMES) {
        const f = path(t);
        expect(finite(f) && f[2] > 0, `frame ${t} of ${JSON.stringify([a, b])}`).toBe(true);
      }
      const end = path(1);
      expect(Math.abs(end[2] - b[2]) / b[2]).toBeLessThan(1e-6);
      expect(Math.hypot(end[0] - b[0], end[1] - b[1]) / Math.max(a[2], b[2])).toBeLessThan(1e-6);
    }
    // The sweep did reach the cases that used to break.
    expect(degenerate).toBeGreaterThan(50);
  });

  it("holds the last good frame when a frame still comes out non-finite", () => {
    // A path that fails part-way, from a factory that is not d3's: the guard
    // still never hands the pane a NaN, and does not jump back to the start.
    const flaky = (a: ZoomView, b: ZoomView): ZoomPath => {
      const line = straightZoomPath(a, b);
      return t => (t > 0.5 && t < 0.9 ? [NaN, NaN, NaN] : line(t));
    };
    const path = guardZoomPath(flaky)([0, 0, 1000], [0, 0, 2000]);
    const atHalf = path(0.5);
    expect(path(0.75)).toEqual(atHalf);
    expect(path(1)).toEqual([0, 0, 2000]);
  });

  it("starts from the target when the view it leaves is itself broken", () => {
    const path = guardZoomPath(interpolateZoom)([NaN, 0, 1000], [10, 20, 2000]);
    for (const t of FRAMES) expect(finite(path(t))).toBe(true);
  });
});

describe("what the deck hands the pane", () => {
  it("is a viewport only when every number is finite and the zoom is positive", () => {
    expect(isViewableViewport({ x: 12, y: -40, zoom: 0.38 })).toBe(true);
    expect(isViewableViewport({ x: NaN, y: 0, zoom: 1 })).toBe(false);
    expect(isViewableViewport({ x: 0, y: Infinity, zoom: 1 })).toBe(false);
    expect(isViewableViewport({ x: 0, y: 0, zoom: NaN })).toBe(false);
    expect(isViewableViewport({ x: 0, y: 0, zoom: 0 })).toBe(false);
    expect(isViewableViewport({ x: 0, y: 0, zoom: -1 })).toBe(false);
  });

  it("refuses anything else at the one door, keeping the frame the pane has", () => {
    const camera = sourceOf("use-camera.ts");
    const door = camera.slice(camera.indexOf("const applyViewport = useCallback("));
    expect(door).toMatch(/^const applyViewport = useCallback\(\(next: [^)]*\) => \{\s*if \(!isViewableViewport\(next\)\) return;/);
  });
});

describe("where the guard is installed", () => {
  it("wraps the pane's own d3-zoom interpolator, so every transition takes it", () => {
    const camera = sourceOf("use-camera.ts");
    expect(camera).toMatch(/zoom\.interpolate\(guardZoomPath\(zoom\.interpolate\(\)\)\)/);
    // Installed once React Flow has made the behaviour, and again if it ever makes another.
    expect(camera).toMatch(/storeApi\.subscribe\(/);
  });

  it("relies on d3-zoom drawing its tween through that settable interpolator", () => {
    // Should an upgrade stop reading `interpolate` there, the guard is bypassed.
    const zoom = readFileSync(fileURLToPath(new URL("../../../node_modules/d3-zoom/src/zoom.js", import.meta.url)), "utf8");
    expect(zoom).toMatch(/i = interpolate\(a\.invert\(p\)\.concat\(w \/ a\.k\), b\.invert\(p\)\.concat\(w \/ b\.k\)\)/);
    expect(zoom).toMatch(/zoom\.interpolate = function\(_\) \{\s*return arguments\.length \? \(interpolate = _, zoom\) : interpolate;/);
  });
});
