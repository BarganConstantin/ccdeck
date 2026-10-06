// A canvas card's peek beside the open git view: it opens into the part of
// the canvas the panel leaves uncovered, never over the panel.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type MutableRefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { usePeekReaders } from "../use-peek-readers";
import { setGitViewFrame } from "../git-view-fit";

/** The readers as the deck makes them, over a canvas whose box is `box`. */
function readers(box: { right: number; bottom: number }, railInset: number) {
  let got: ReturnType<typeof usePeekReaders> | null = null;
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 56, ...box, width: box.right, height: box.bottom - 56 }) } as unknown as HTMLElement;
  const ref = <T,>(current: T) => ({ current }) as MutableRefObject<T>;
  function Probe() {
    got = usePeekReaders({ nodesRef: ref([]), stateRef: ref({ agents: new Map() } as never), canvasRef: ref(canvas), railInsetRef: ref(railInset) });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return got!;
}

// The window, for a page with no canvas yet; never read while there is one.
beforeAll(() => { vi.stubGlobal("document", { documentElement: { clientWidth: 800, clientHeight: 600 } }); });
afterAll(() => { vi.unstubAllGlobals(); });
afterEach(() => setGitViewFrame(null));

describe("the room a card's peek opens into", () => {
  it("is the canvas less the rail of panels over its right edge while the git view is closed", () => {
    expect(readers({ right: 1440, bottom: 900 }, 0).peekBounds()).toEqual({ width: 1440, height: 900 });
    expect(readers({ right: 1440, bottom: 900 }, 340).peekBounds()).toEqual({ width: 1100, height: 900 });
  });

  it("stops at the open git view's left edge: the part of the canvas the panel covers is not room", () => {
    setGitViewFrame(() => {}, 864);
    expect(readers({ right: 1440, bottom: 900 }, 0).peekBounds()).toEqual({ width: 576, height: 900 });
    // A rail wider than the panel's cover still wins.
    setGitViewFrame(() => {}, 200);
    expect(readers({ right: 1440, bottom: 900 }, 340).peekBounds().width).toBe(1100);
    setGitViewFrame(null);
    expect(readers({ right: 1440, bottom: 900 }, 0).peekBounds().width).toBe(1440);
  });
});
