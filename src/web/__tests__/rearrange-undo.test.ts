// Re-arrange threw a hand-built board away for good.
//
// R, and the canvas stack's Re-arrange button, cleared every pin, every stored
// position and the three stored keys (the layout, the frame it was packed for,
// the viewport), then wrote the new arrangement over storage 80ms later. Nothing
// asked first and nothing kept a copy, so a reload could not bring the old board
// back either: one stray press and an afternoon of dragging was gone. C asks
// before it acts. R is pressed too often to ask, so it keeps what it throws away
// for a few seconds instead, behind an Undo on the canvas.
//
// Run, not read: useBoardLayout and the notice are called under fake-react,
// against a stubbed store and fake timers. The ⌘Z half is in
// rearrange-undo-chord.test.ts, which needs the keydown harness's own React.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { all, mount, textOf, type Drawn } from "./fake-react";
import { useBoardLayout } from "../use-board-layout";

type Layout = ReturnType<typeof useBoardLayout>;
type Point = { x: number; y: number };

const LAYOUT_KEY = "agent-dag.layout";
const FRAME_KEY = "agent-dag.layoutFrame";
const VIEWPORT_KEY = "agent-dag.viewport";

/** A board somebody arranged by hand: three cards, two of them dragged. */
const HAND_BUILT = JSON.stringify({
  v: 2,
  positions: { a: { x: 40, y: 60 }, b: { x: 910, y: 24 }, c: { x: 132, y: 704 } },
  pins: ["a", "c"],
});
const FRAME = JSON.stringify({ width: 1180, height: 760 });
const VIEW = { x: -35, y: 18, zoom: 0.82 };

/** Where the render after R puts the cards: one column, from scratch. */
const REARRANGED: Array<[string, Point]> = [["a", { x: 0, y: 0 }], ["b", { x: 0, y: 220 }], ["c", { x: 0, y: 440 }]];

function fakeStore(seed: Record<string, string>) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

/** A deck restored from the hand-built board, settled, with the view it was left at. */
function deck() {
  const store = fakeStore({ [LAYOUT_KEY]: HAND_BUILT, [FRAME_KEY]: FRAME, [VIEWPORT_KEY]: JSON.stringify(VIEW) });
  const page = { hidden: false, listeners: [] as Array<() => void> };
  vi.stubGlobal("document", {
    get hidden() { return page.hidden; },
    addEventListener: (type: string, fn: () => void) => { if (type === "visibilitychange") page.listeners.push(fn); },
    removeEventListener: () => {},
  });
  const setHidden = (hidden: boolean) => { page.hidden = hidden; for (const fn of page.listeners) fn(); };
  vi.stubGlobal("window", {
    localStorage: store,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  });
  let view = { ...VIEW };
  const camera = {
    fitLeft: vi.fn(),
    moveCamera: vi.fn((want: typeof VIEW) => { view = { ...want }; return 1; }),
    currentViewport: () => ({ ...view }),
  };
  const m = mount(() => useBoardLayout(camera as unknown as Parameters<typeof useBoardLayout>[0]), {});
  const layout = () => m.tree as Layout;
  // The signature the first layout pass left behind, as snapshotToFlow writes it.
  layout().lastLayoutSigRef.current = "a,b,c#lanes:";
  return { store, camera, layout, setHidden, setView: (v: typeof VIEW) => { view = { ...v }; } };
}

/** What the render R schedules does: lays every card out afresh. */
function drawRearranged(layout: Layout) {
  for (const [id, at] of REARRANGED) layout.positionsRef.current.set(id, at);
  layout.lastLayoutSigRef.current = "a,b,c#lanes:";
}

/** R, the render it asks for, and the store it writes 80ms later. */
function rearrange(d: ReturnType<typeof deck>) {
  d.layout().handleRelayout();
  drawRearranged(d.layout());
  vi.advanceTimersByTime(80);
}

/** The Undo the notice offers — absent while the deck had none. */
const undo = (d: ReturnType<typeof deck>) => d.layout().rearrangeUndo?.undo();
const shown = (d: ReturnType<typeof deck>) => d.layout().rearrangeUndo?.open === true;

const entries = <V>(m: Map<string, V>) => [...m].sort(([x], [y]) => x.localeCompare(y));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("re-arrange can be undone", () => {
  it("puts back every pin and position R threw away, in memory and in storage", () => {
    const d = deck();
    const before = {
      positions: entries(d.layout().positionsRef.current),
      pinned: entries(d.layout().pinnedRef.current),
      stored: entries(d.store.data),
    };
    expect(before.pinned.map(([id]) => id)).toEqual(["a", "c"]);

    rearrange(d);
    // R did what it does: pins gone, and the new board written over the old one.
    expect(d.layout().pinnedRef.current.size).toBe(0);
    expect(d.store.data.get(LAYOUT_KEY)).not.toBe(HAND_BUILT);

    undo(d);
    expect(entries(d.layout().pinnedRef.current)).toEqual(before.pinned);
    expect(entries(d.layout().positionsRef.current)).toEqual(before.positions);
    expect(entries(d.store.data)).toEqual(before.stored);
    // The board is drawn from the restored maps on the render it schedules, not
    // laid out again: the signature it was settled under comes back with them.
    expect(d.layout().lastLayoutSigRef.current).toBe("a,b,c#lanes:");
  });

  it("goes back to the view R's fit replaced", () => {
    const d = deck();
    rearrange(d);
    expect(d.camera.fitLeft).toHaveBeenCalledTimes(1);
    undo(d);
    expect(d.camera.moveCamera).toHaveBeenLastCalledWith(VIEW, expect.any(Number));
  });

  it("restores even when it is pressed before R has stored the new board", () => {
    const d = deck();
    const before = entries(d.store.data);
    d.layout().handleRelayout();
    drawRearranged(d.layout());
    undo(d);
    // R's own store and fit, 80ms on, must not land on top of the undo.
    vi.advanceTimersByTime(1_000);
    expect(entries(d.store.data)).toEqual(before);
    expect(d.camera.fitLeft).not.toHaveBeenCalled();
    expect(d.layout().pinnedRef.current.size).toBe(2);
  });

  it("offers it once R has run, and only then", () => {
    const d = deck();
    expect(shown(d)).toBe(false);
    rearrange(d);
    expect(shown(d)).toBe(true);
    undo(d);
    expect(shown(d)).toBe(false);
  });

  it("stays for a few seconds, then goes, and Undo does nothing once it has", () => {
    const d = deck();
    rearrange(d);
    vi.advanceTimersByTime(6_000);
    expect(shown(d)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(shown(d)).toBe(false);
    expect(undo(d)).toBe(false);
    expect(d.layout().pinnedRef.current.size).toBe(0);
    expect(entries(d.layout().positionsRef.current)).toEqual(entries(new Map(REARRANGED)));
  });

  it("closes on dismiss — Escape, or a drag — and keeps R's board", () => {
    const d = deck();
    rearrange(d);
    d.layout().rearrangeUndo?.dismiss();
    expect(shown(d)).toBe(false);
    expect(undo(d)).toBe(false);
    expect(d.layout().pinnedRef.current.size).toBe(0);
  });

  it("starts the window again on a second R, and still undoes to the board the first R replaced", () => {
    const d = deck();
    const before = { positions: entries(d.layout().positionsRef.current), pinned: entries(d.layout().pinnedRef.current), stored: entries(d.store.data) };
    rearrange(d);
    vi.advanceTimersByTime(5_000);
    // A second press — stray, or a re-pack after a pan — while the offer is up.
    d.setView({ x: 120, y: -40, zoom: 0.6 });
    rearrange(d);
    vi.advanceTimersByTime(5_000);
    expect(shown(d)).toBe(true);
    undo(d);
    // Its own copy would be the first R's board, which is what is on screen:
    // the hand-built one comes back instead, with the view it had.
    expect(entries(d.layout().pinnedRef.current)).toEqual(before.pinned);
    expect(entries(d.layout().positionsRef.current)).toEqual(before.positions);
    expect(entries(d.store.data)).toEqual(before.stored);
    expect(d.camera.moveCamera).toHaveBeenLastCalledWith(VIEW, expect.any(Number));
  });

  it("copies the board afresh for an R after the offer has ended", () => {
    const d = deck();
    rearrange(d);
    vi.advanceTimersByTime(8_000);
    expect(shown(d)).toBe(false);
    // The reader drags a card on the new board, and presses R again.
    d.layout().pinnedRef.current.set("b", { x: 500, y: 500 });
    d.layout().positionsRef.current.set("b", { x: 500, y: 500 });
    rearrange(d);
    undo(d);
    expect(entries(d.layout().pinnedRef.current)).toEqual([["b", { x: 500, y: 500 }]]);
  });

  it("holds the clock while the pointer is on it", () => {
    const d = deck();
    rearrange(d);
    vi.advanceTimersByTime(3_000);
    d.layout().rearrangeUndo?.hold("hover");
    vi.advanceTimersByTime(30_000);
    expect(shown(d)).toBe(true);
    d.layout().rearrangeUndo?.release("hover");
    // What was left of the window, and never less than a moment to move back.
    vi.advanceTimersByTime(1_500);
    expect(shown(d)).toBe(true);
    vi.advanceTimersByTime(4_000);
    expect(shown(d)).toBe(false);
  });

  it("holds the clock while focus is in it, and until both have let go", () => {
    const d = deck();
    rearrange(d);
    d.layout().rearrangeUndo?.hold("focus");
    d.layout().rearrangeUndo?.hold("hover");
    vi.advanceTimersByTime(30_000);
    d.layout().rearrangeUndo?.release("hover");
    vi.advanceTimersByTime(30_000);
    expect(shown(d)).toBe(true);
    d.layout().rearrangeUndo?.release("focus");
    vi.advanceTimersByTime(8_000);
    expect(shown(d)).toBe(false);
  });

  it("holds the clock while the tab is not being looked at", () => {
    const d = deck();
    rearrange(d);
    vi.advanceTimersByTime(1_000);
    d.setHidden(true);
    vi.advanceTimersByTime(60_000);
    expect(shown(d)).toBe(true);
    d.setHidden(false);
    vi.advanceTimersByTime(5_000);
    expect(shown(d)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(shown(d)).toBe(false);
  });

  it("says so politely, and says the board is back after Undo", () => {
    const d = deck();
    rearrange(d);
    expect(d.layout().rearrangeUndo?.said).toBe("Layout re-arranged. Undo available.");
    undo(d);
    expect(d.layout().rearrangeUndo?.said).toBe("Layout restored.");
  });
});

describe("the notice on the canvas", () => {
  /** The notice as drawn for one state of the hook, with spies for its calls. */
  async function notice(open: boolean) {
    vi.stubGlobal("document", { activeElement: null });
    const { default: RearrangeUndo } = await import("../components/RearrangeUndo");
    const undo = { open, said: open ? "Layout re-arranged. Undo available." : "", undo: vi.fn(() => true), dismiss: vi.fn(), hold: vi.fn(), release: vi.fn() };
    const m = mount(RearrangeUndo as (p: { undo: typeof undo }) => unknown, { undo });
    const strip = () => all(m.tree, el => el.props.className === "rearrange-undo")[0] as Drawn | undefined;
    const button = () => all(m.tree, el => el.type === "button")[0] as Drawn | undefined;
    const region = () => all(m.tree, el => el.props.role === "status")[0] as Drawn | undefined;
    return { undo, strip, button, region };
  }

  it("reads plainly, with Undo as the one control", async () => {
    const n = await notice(true);
    expect(n.strip()).toBeDefined();
    expect(textOf(n.strip())).toMatch(/^Layout re-arranged\s*Undo/);
    expect(n.button()!.props.type).toBe("button");
    (n.button()!.props.onClick as () => void)();
    expect(n.undo.undo).toHaveBeenCalledTimes(1);
  });

  it("pauses on hover and on focus, through the hook's hold and release", async () => {
    const n = await notice(true);
    const props = n.strip()!.props as Record<string, (e?: unknown) => void>;
    props.onPointerEnter();
    expect(n.undo.hold).toHaveBeenLastCalledWith("hover");
    props.onPointerLeave();
    expect(n.undo.release).toHaveBeenLastCalledWith("hover");
    props.onFocus();
    expect(n.undo.hold).toHaveBeenLastCalledWith("focus");
    // Tab from the strip's one control to whatever follows it lets go; a move
    // inside it would not.
    props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(n.undo.release).toHaveBeenLastCalledWith("focus");
  });

  it("keeps its live region mounted before there is anything to say", async () => {
    const closed = await notice(false);
    expect(closed.strip()).toBeUndefined();
    expect(closed.region()).toBeDefined();
    expect(closed.region()!.props["aria-live"] ?? "polite").toBe("polite");
  });
});
