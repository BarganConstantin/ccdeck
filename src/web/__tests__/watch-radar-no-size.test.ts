// 4.0.1 reported, from Browser Watch: "Failed to execute 'arc' on
// 'CanvasRenderingContext2D': The radius provided (-2.4) is negative." The
// radar draws its rings at a radius of half the canvas's short side less 6px,
// so a canvas with no size yet — or one whose column has just collapsed —
// gives -6, and the inner ring (0.4 of it) is the -2.4 in the report. A
// browser throws on a negative radius, and the throw ended the animation loop:
// once the canvas had a size again the disc stayed blank until the dialog was
// opened anew.
//
// This runs the component with a canvas whose context throws exactly as a
// browser's does, and steps its frames by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount } from "./fake-react";
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), ...(await import("./fake-react")).react }));
const { default: WatchRadar } = await import("../components/WatchRadar");

interface FakeCanvas { clientWidth: number; clientHeight: number; width: number; height: number; getContext: () => unknown }

/** A canvas whose 2D context records every arc and refuses a negative radius
 *  with the browser's own error. */
function fakeCanvas(size: number) {
  const arcs: number[] = [];
  const noop = () => {};
  const ctx = new Proxy({
    arc(_x: number, _y: number, radius: number) {
      if (radius < 0) throw new Error(`IndexSizeError: The radius provided (${radius}) is negative.`);
      arcs.push(radius);
    },
    createConicGradient: () => ({ addColorStop: noop }),
  } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : noop),
    set: (target, key: string, value) => { target[key] = value; return true; },
  });
  const canvas: FakeCanvas = { clientWidth: size, clientHeight: size, width: 0, height: 0, getContext: () => ctx };
  const resize = (next: number) => { canvas.clientWidth = next; canvas.clientHeight = next; };
  return { canvas, arcs, resize };
}

let frames: Array<() => void> = [];
/** Runs the one frame the radar asked for, as the browser would. */
const step = () => {
  const due = frames;
  frames = [];
  for (const frame of due) frame();
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal("window", { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => { frames.push(run); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
});
afterEach(() => { vi.unstubAllGlobals(); });

const palette = { "--accent": "#7dd3fc", "--line": "#1f2229", "--text-dim": "#6e727c", "--bg": "#0b0c10" } as never;
const props = {
  browsers: [{ key: "chrome", name: "Google Chrome", running: true, lastReadMs: Date.now() }],
  findings: [{ browser: "chrome", atMs: Date.now() }],
  watching: true,
  palette,
};

/** Mounts the radar on `canvas`, attached to its ref the way the document would. */
function radarOn(canvas: FakeCanvas) {
  return mount(WatchRadar, props, {
    commit: tree => {
      for (const el of all(tree, e => e.type === "canvas")) {
        const ref = (el.ref ?? el.props.ref) as { current: unknown } | null;
        if (ref) ref.current = canvas;
      }
    },
  });
}

describe("the Browser Watch radar on a canvas with no room", () => {
  it("draws nothing while the canvas has no size, and draws the disc once it has one", () => {
    const { canvas, arcs, resize } = fakeCanvas(0);
    expect(() => radarOn(canvas)).not.toThrow();
    expect(arcs).toEqual([]);
    // Still looking: the next frame is booked even though this one drew nothing.
    expect(frames).toHaveLength(1);

    resize(88);
    step();
    // Three rings at 0.4, 0.7 and 1 of the 38px radius, then the sweep, the
    // browser's blip and the finding's ring — every one of them positive.
    expect(arcs.length).toBeGreaterThanOrEqual(6);
    expect(arcs.slice(0, 3)).toEqual([38 * 0.4, 38 * 0.7, 38]);
    expect(arcs.every(radius => radius > 0)).toBe(true);
    expect(frames).toHaveLength(1);
  });

  it("keeps sweeping when the canvas loses its size mid-watch and comes back", () => {
    const { canvas, arcs, resize } = fakeCanvas(88);
    radarOn(canvas);
    const drawn = arcs.length;
    expect(drawn).toBeGreaterThan(0);

    // Every size under 12px leaves no radius: 0 is the report's -2.4, 10 is -1.
    for (const size of [0, 10, 12]) {
      resize(size);
      expect(() => step()).not.toThrow();
      expect(arcs).toHaveLength(drawn);
      expect(frames).toHaveLength(1);
    }

    resize(88);
    step();
    expect(arcs.length).toBeGreaterThan(drawn);
    expect(arcs.every(radius => radius > 0)).toBe(true);
  });

  it("stops asking for frames when the dialog closes", () => {
    const { canvas } = fakeCanvas(0);
    const view = radarOn(canvas);
    expect(frames).toHaveLength(1);
    view.unmount();
    expect(frames).toHaveLength(0);
  });
});
