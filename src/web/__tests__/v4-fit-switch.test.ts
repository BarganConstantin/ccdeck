// Two follow-ups to the board from a distance (owner's critique, round 3,
// point 1), run through the hooks themselves with React's hooks stood in for:
//
//   - the switch to and from the packed board pans the camera in the frame the
//     cards move, so the card the reader zooms at stays where it is, and the
//     cards take their new places with no travel;
//   - an explicit Fit all holds: the fits that follow on their own keep the
//     whole board in view, below the auto-fit's 40% floor, until the reader
//     pans or zooms by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";

/** React's hooks for a component rendered by hand: refs kept by call order
 *  across renders, effects collected for the test to run in React's order. */
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], at: 0,
  layout: [] as (() => void)[], passive: [] as (() => void)[],
}));
vi.mock("react", async orig => ({
  ...(await orig<typeof import("react")>()),
  useRef: (current: unknown) => (hooks.refs[hooks.at++] ??= { current }),
  useCallback: (fn: unknown) => fn,
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
  useLayoutEffect: (fn: () => void) => { hooks.layout.push(fn); },
  useEffect: (fn: () => void) => { hooks.passive.push(fn); },
}));
const rf = vi.hoisted(() => ({ setViewport: vi.fn(), getViewport: vi.fn(), getNodes: vi.fn() }));
vi.mock("reactflow", () => ({ useReactFlow: () => rf, useStoreApi: () => ({ getState: () => ({}) }) }));
vi.mock("../layout-storage", () => ({ loadViewport: () => null, saveViewport: vi.fn() }));
vi.mock("../components/SessionPeek", () => ({ hidePeek: vi.fn() }));

const { useCamera } = await import("../use-camera");
const { useCanvasViewport } = await import("../use-canvas-viewport");
const { useRepackAnchor, REPACK_ATTR } = await import("../use-repack-anchor");
const { boardSqueeze } = await import("../packed-board");
const { AUTO_FIT_MIN_ZOOM } = await import("../fit-board");

/** One render: hooks counted from the top, effects run as React runs them. */
function render<T>(hook: () => T, run = true): T {
  hooks.at = 0;
  hooks.layout = [];
  hooks.passive = [];
  const out = hook();
  if (run) {
    for (const fn of hooks.layout) fn();
    for (const fn of hooks.passive) fn();
  }
  return out;
}

beforeEach(() => { hooks.refs = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

// ── the switch ──────────────────────────────────────────────────────────────

describe("the switch to and from the packed board", () => {
  const card = (id: string, x: number, y = 0): Node => ({ id, type: "agent", position: { x, y }, width: 260, height: 100, data: { sessionId: id } });
  const nodes = [card("a", 400), card("b", 1554)];
  const squeeze = boardSqueeze(nodes);

  function mount() {
    const attrs = new Set<string>();
    const order: string[] = [];
    const el = {
      setAttribute: (name: string) => { attrs.add(name); order.push(`set ${name}`); },
      removeAttribute: (name: string) => { attrs.delete(name); order.push(`remove ${name}`); },
    };
    const panBy = vi.fn((dx: number) => { order.push(`pan ${dx}`); });
    const focusRef = { current: null as { x: number; y: number; reader: boolean } | null };
    const view = { x: 40, y: 30, zoom: 0.66 };
    const input = (packed: boolean) => ({
      packed, nodes, squeeze: packed ? squeeze : null, focusRef, canvasRef: { current: el as unknown as HTMLElement },
      getViewport: () => view, panBy,
    });
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { fn(); return 0; });
    return { attrs, order, panBy, focusRef, view, input };
  }
  const screen = (x: number, view: { x: number; zoom: number }) => x * view.zoom + view.x;

  it("zooming in: pans by as much as the card under the pointer moved, so it stays within a pixel", () => {
    const { order, panBy, focusRef, view, input } = mount();
    render(() => useRepackAnchor(input(true)));
    // The pointer on "b" where the packed board draws it.
    const before = screen(squeeze.at(1554), view);
    focusRef.current = { x: before + 30, y: 60, reader: true };
    render(() => useRepackAnchor(input(false)));
    expect(panBy).toHaveBeenCalledTimes(1);
    const after = screen(1554, { ...view, x: view.x + panBy.mock.calls[0][0] });
    expect(Math.abs(after - before)).toBeLessThan(1);
    // No travel while the cards move, and travel back once they are there.
    expect(order[0]).toBe(`set ${REPACK_ATTR}`);
    expect(order.at(-1)).toBe(`remove ${REPACK_ATTR}`);
  });

  it("zooming out: the same, laid out to packed", () => {
    const { panBy, focusRef, view, input } = mount();
    render(() => useRepackAnchor(input(false)));
    const before = screen(1554, view);
    focusRef.current = { x: before + 30, y: 60, reader: true };
    render(() => useRepackAnchor(input(true)));
    const after = screen(squeeze.at(1554), { ...view, x: view.x + panBy.mock.calls[0][0] });
    expect(Math.abs(after - before)).toBeLessThan(1);
  });

  it("leaves the camera to a fit or a focus that crosses, and still takes the travel off", () => {
    const { attrs, order, panBy, focusRef, input } = mount();
    render(() => useRepackAnchor(input(true)));
    focusRef.current = { x: 500, y: 60, reader: false };
    render(() => useRepackAnchor(input(false)));
    expect(panBy).not.toHaveBeenCalled();
    expect(order).toEqual([`set ${REPACK_ATTR}`, `remove ${REPACK_ATTR}`]);
    expect(attrs.size).toBe(0);
  });

  it("does nothing while the board stays on one side of the threshold", () => {
    const { order, panBy, focusRef, input } = mount();
    focusRef.current = { x: 500, y: 60, reader: true };
    render(() => useRepackAnchor(input(true)));
    render(() => useRepackAnchor(input(true)));
    expect(panBy).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });
});

// ── Fit all holds ───────────────────────────────────────────────────────────

describe("an explicit Fit all holds until the reader pans or zooms by hand", () => {
  /** Four columns of eight sessions: no 1440x900 canvas shows that whole at 40%. */
  const board = Array.from({ length: 32 }, (_, i) => ({
    id: `s${i}`, type: "agent", position: { x: Math.floor(i / 8) * 1200, y: (i % 8) * 260 }, width: 260, height: 100,
  }));
  let width = 1129;

  function stage() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: 836, width, height: 836 }) };
    const drawn = board.map(n => ({ dataset: { id: n.id }, offsetWidth: 260, offsetHeight: 100 }));
    vi.stubGlobal("document", {
      hidden: true, querySelector: () => canvas,
      querySelectorAll: (selector: string) => (selector === ".react-flow__node" ? drawn : []),
    });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    rf.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1 });
    rf.getNodes.mockReturnValue(board);
    const camera = render(() => useCamera(), false);
    const disableAutoFit = vi.fn();
    // As App wires it: a move by hand turns the auto-fit off and lets Fit all go.
    const tookWheel = () => { disableAutoFit(); camera.releaseFitAll(); };
    const viewport = render(() => useCanvasViewport({
      applyViewport: camera.applyViewport, takeOver: camera.takeOver, lastFitTimeRef: camera.lastFitTimeRef,
      cameraEpochRef: camera.cameraEpochRef, disableAutoFit: tookWheel, markInteract: () => {},
      canvasRef: { current: null }, applyZoom: () => null,
    }), false);
    /** The zoom the last fit asked the pane for. */
    const lastZoom = () => (rf.setViewport.mock.calls.at(-1)![0] as { zoom: number }).zoom;
    return { camera, viewport, disableAutoFit, lastZoom };
  }

  beforeEach(() => { width = 1129; });

  it("keeps the whole board in view when a panel opens after Fit all", () => {
    const { camera, lastZoom } = stage();
    camera.fitAll();
    expect(lastZoom()).toBeLessThan(AUTO_FIT_MIN_ZOOM);
    // A panel opens: the canvas narrows and the reframe refits on its own.
    width = 865;
    vi.advanceTimersByTime(2000);
    camera.fitLeft();
    expect(lastZoom()).toBeLessThan(AUTO_FIT_MIN_ZOOM);
  });

  it("returns to the auto-fit's floor after the reader wheel-zooms", () => {
    const { camera, viewport, disableAutoFit, lastZoom } = stage();
    camera.fitAll();
    vi.advanceTimersByTime(2000);
    // A wheel on the pane: a move with a source event, after the fit's window.
    viewport.onMove({ type: "wheel" } as unknown as MouseEvent, { x: 10, y: 10, zoom: 0.3 });
    expect(disableAutoFit).toHaveBeenCalled();
    width = 865;
    camera.fitLeft();
    expect(lastZoom()).toBe(AUTO_FIT_MIN_ZOOM);
  });

  it("returns to the floor after a zoom step from the buttons or the keys", () => {
    const { camera, lastZoom } = stage();
    camera.fitAll();
    camera.zoomBy(1.2);
    camera.fitLeft();
    expect(lastZoom()).toBe(AUTO_FIT_MIN_ZOOM);
  });

  it("never holds without a Fit all: the auto-fit starts at its floor", () => {
    const { camera, lastZoom } = stage();
    camera.fitLeft();
    expect(lastZoom()).toBe(AUTO_FIT_MIN_ZOOM);
  });
});
