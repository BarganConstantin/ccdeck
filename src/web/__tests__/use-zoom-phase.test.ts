// Zoom's fold and unfold as the root's data-zoom says them (use-zoom-phase.ts):
// "fold" while Zoom is on, "unfold" for the length of the slide in, then the
// grid's own tracks. By a key there is no slide; under reduced motion the
// slide is the crossfade's length. Run as a hook under fake-react.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unfoldMs, useZoomPhase } from "../use-zoom-phase";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

let motion: string | undefined;
let reduced: boolean;
beforeEach(() => {
  vi.useFakeTimers();
  motion = undefined;
  reduced = false;
  const g = globalThis as Record<string, unknown>;
  g.window = { setTimeout, clearTimeout };
  g.document = { documentElement: { dataset: new Proxy({}, { get: (_t, k) => (k === "motion" ? motion : undefined) }) } };
  g.matchMedia = (q: string) => ({ matches: reduced && q.includes("prefers-reduced-motion") });
  g.getComputedStyle = () => ({ getPropertyValue: (name: string) => (name === "--dur-move" ? "240ms" : "") });
});
afterEach(() => {
  vi.useRealTimers();
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.matchMedia;
  delete g.getComputedStyle;
});

function Harness({ zoomed }: { zoomed: boolean }) {
  return { phase: useZoomPhase(zoomed) };
}
const setup = (zoomed = false) => {
  const view = mount(Harness, { zoomed });
  return { view, phase: () => (view.tree as { phase: string | undefined }).phase, zoom: (z: boolean) => view.rerender({ zoomed: z }) };
};

describe("Zoom's phases", () => {
  it("is the grid's own while Zoom has never been on", () => {
    expect(setup().phase()).toBeUndefined();
  });

  it("folds in the render that turns Zoom on, and unfolds for Move after it is turned off", () => {
    const { phase, zoom } = setup();
    zoom(true);
    expect(phase()).toBe("fold");
    zoom(false);
    expect(phase(), "the panels slide back over a pane that still has the cell").toBe("unfold");
    vi.advanceTimersByTime(unfoldMs() - 1);
    expect(phase()).toBe("unfold");
    vi.advanceTimersByTime(1);
    expect(phase(), "then the grid takes its tracks back").toBeUndefined();
    expect(unfoldMs()).toBe(240);
  });

  it("turns a second press around: back to fold from an unfold in progress, and unfolds in full from the new press", () => {
    const { phase, zoom } = setup();
    zoom(true);
    zoom(false);
    vi.advanceTimersByTime(100);
    zoom(true);
    expect(phase()).toBe("fold");
    zoom(false);
    expect(phase()).toBe("unfold");
    vi.advanceTimersByTime(unfoldMs() - 1);
    expect(phase()).toBe("unfold");
    vi.advanceTimersByTime(1);
    expect(phase()).toBeUndefined();
  });

  it("is at once by a key: no unfold, the grid is back in the same render", () => {
    const { phase, zoom } = setup();
    zoom(true);
    motion = "instant";
    zoom(false);
    expect(phase()).toBeUndefined();
  });

  it("unfolds over the crossfade's 140 under reduced motion", () => {
    reduced = true;
    expect(unfoldMs()).toBe(140);
    const { phase, zoom } = setup();
    zoom(true);
    zoom(false);
    vi.advanceTimersByTime(139);
    expect(phase()).toBe("unfold");
    vi.advanceTimersByTime(1);
    expect(phase()).toBeUndefined();
  });
});
