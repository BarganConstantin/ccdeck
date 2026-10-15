// The chrome's one hint (components/use-hint.tsx) and Escape.
//
// WCAG 1.4.13 asks that content shown on hover or focus can be dismissed
// without moving the pointer or the focus, and this deck has one way an
// overlay answers Escape: the dismiss stack (modal-dismiss.ts), read by the one
// window listener in use-deck-shortcuts.ts. modal-dismiss.test.ts refuses any
// component that hand-rolls its own Escape; a hint that did would also answer
// a press meant for a menu under it, or clear the canvas selection on the same
// press that took it down. So the hint registers on the stack while it is up,
// as a POPOVER — the board stays in view around it, so it must hold back none
// of the canvas letters (dialogDepth) — and unregisters when it goes, by
// whatever route it goes.
//
// The hook is run here on a React of five hooks, with a window whose timers
// the test drives, against the real stack; App is a component the suite has
// no DOM to mount.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceOf } from "./client-source";

const rt = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Instance {
    slots: Array<Record<string, unknown>>;
    cleanups: Array<(() => void) | undefined>;
    pending: Array<{ i: number; run: () => void | (() => void) }>;
    cursor: number;
    result: unknown;
    render: () => void;
  }
  let current: Instance | null = null;
  const changed = (a: Deps, b: Deps) => !a || !b || b.some((d, k) => !Object.is(d, a[k]));
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const I = current!;
    const i = I.cursor++;
    const slot = I.slots[i];
    if (!slot || changed(slot.deps as Deps, deps)) { I.slots[i] = { deps }; I.pending.push({ i, run }); }
  };
  const react = {
    useState<T>(init: T | (() => T)) {
      const I = current!;
      const i = I.cursor++;
      if (!I.slots[i]) I.slots[i] = { v: typeof init === "function" ? (init as () => T)() : init };
      const slot = I.slots[i];
      const set = (next: T | ((was: T) => T)) => {
        const v = typeof next === "function" ? (next as (was: T) => T)(slot.v as T) : next;
        if (!Object.is(v, slot.v)) { slot.v = v; I.render(); }
      };
      return [slot.v as T, set] as const;
    },
    useRef<T>(init: T) {
      const I = current!;
      const i = I.cursor++;
      if (!I.slots[i]) I.slots[i] = { ref: { current: init } };
      return I.slots[i].ref as { current: T };
    },
    useCallback<F>(fn: F, deps: readonly unknown[]) {
      const I = current!;
      const i = I.cursor++;
      const slot = I.slots[i];
      if (!slot || changed(slot.deps as Deps, deps)) I.slots[i] = { fn, deps };
      return I.slots[i].fn as F;
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
  function mount<A, R>(hook: (arg: A) => R, arg: A) {
    const I: Instance = { slots: [], cleanups: [], pending: [], cursor: 0, result: null, render: () => {} };
    I.render = () => {
      I.cursor = 0;
      I.pending = [];
      current = I;
      try { I.result = hook(arg); } finally { current = null; }
      for (const p of I.pending) {
        I.cleanups[p.i]?.();
        const back = p.run();
        I.cleanups[p.i] = typeof back === "function" ? back : undefined;
      }
    };
    I.render();
    return {
      get now() { return I.result as R; },
      unmount() { for (const c of I.cleanups) c?.(); },
    };
  }
  return { react, mount };
});

vi.mock("react", () => rt.react);
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

const { useHint, skipsDelay, FIRST_HINT_DELAY_MS, SKIP_DELAY_WINDOW_MS, HINT_GRACE_MS } = await import("../components/use-hint");
const { modalStack } = await import("../modal-dismiss");

interface Timer { fn: () => void; ms: number; id: number }
let timers: Timer[];
let mounted: Array<{ unmount: () => void }>;

beforeEach(() => {
  timers = [];
  mounted = [];
  let next = 1;
  vi.stubGlobal("window", {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.push({ fn, ms, id }); return id; },
    clearTimeout: (id: number) => { timers = timers.filter(t => t.id !== id); },
  });
  // Where the hint is portalled to, and nothing more.
  vi.stubGlobal("document", { body: {} });
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A hint, mounted, and a control to point it at. */
function hint() {
  const view = rt.mount(useHint, "right" as const);
  mounted.push(view);
  return view;
}
const BOX = { left: 2, right: 27, top: 52, bottom: 160, width: 25, height: 108, x: 2, y: 52 } as DOMRect;
const control = (focusVisible = true) => ({
  currentTarget: { matches: (q: string) => q === ":focus-visible" && focusVisible, getBoundingClientRect: () => BOX },
});
const SPEC = { label: "Session list", keys: "L" };
const shown = (view: ReturnType<typeof hint>) => view.now.node != null && view.now.node !== false;
/** Lets the clock pass the skip window, so a case's first hint is a first hint.
 *  A clock of its own that only ever moves forward, well past anything real:
 *  read off the real clock, a case that ran a few milliseconds after another
 *  case's mocked hide landed inside that hide's window on a fast machine, and
 *  its "first" hint came at once (CI, all three platforms). */
let clock = 1e9;
const later = () => { clock += SKIP_DELAY_WINDOW_MS * 10; vi.spyOn(performance, "now").mockReturnValue(clock); };

describe("the hint is a popover on the one dismiss stack", () => {
  it("registers while it is up, as a popover, and is what Escape reaches first", () => {
    const view = hint();
    expect(modalStack.depth()).toBe(0);
    view.now.bind(SPEC).onFocus(control() as never);
    expect(shown(view)).toBe(true);
    expect(modalStack.depth()).toBe(1);
    // A popover: it holds back none of the canvas letters (#1175).
    expect(modalStack.dialogDepth()).toBe(0);
    // Escape, as use-deck-shortcuts.ts answers it: the top of the stack goes.
    expect(modalStack.dismissTop()).toBe(true);
    expect(shown(view)).toBe(false);
    expect(modalStack.depth(), "the hint left its entry behind").toBe(0);
  });

  it("unregisters by every other way it goes, so a stale entry never swallows the next Escape", () => {
    for (const leave of [
      (h: ReturnType<typeof hint>) => h.now.bind(SPEC).onBlur(),
      (h: ReturnType<typeof hint>) => h.now.bind(SPEC).onPointerDown(),
    ]) {
      const view = hint();
      view.now.bind(SPEC).onFocus(control() as never);
      expect(modalStack.depth()).toBe(1);
      leave(view);
      expect(shown(view)).toBe(false);
      expect(modalStack.depth()).toBe(0);
    }
    // And by leaving with the pointer, after the grace that lets it cross
    // onto the hint (1.4.13's "hoverable").
    const view = hint();
    view.now.bind(SPEC).onFocus(control() as never);
    view.now.bind(SPEC).onPointerLeave();
    expect(shown(view), "gone before the pointer could reach it").toBe(true);
    const grace = timers.find(t => t.ms === HINT_GRACE_MS)!;
    expect(grace).toBeTruthy();
    grace.fn();
    expect(shown(view)).toBe(false);
    expect(modalStack.depth()).toBe(0);
  });

  it("is one hint on screen: the next control's takes over at once and leaves one entry", () => {
    later();
    const left = hint();
    const right = hint();
    left.now.bind(SPEC).onFocus(control() as never);
    right.now.bind({ label: "Usage", keys: "U" }).onPointerEnter({ pointerType: "mouse", ...control(false) } as never);
    expect(shown(right), "the neighbour waited the first hint's delay").toBe(true);
    expect(shown(left), "two hints on screen").toBe(false);
    expect(modalStack.depth()).toBe(1);
    modalStack.dismissTop();
    expect(modalStack.depth()).toBe(0);
  });

  it("listens for no key of its own", () => {
    // modal-dismiss.test.ts's rule, asked of this file by name: the stack is
    // its only route to Escape.
    const src = sourceOf("components/use-hint.tsx");
    expect(src).not.toMatch(/["']Escape["']/);
    expect(src).not.toMatch(/addEventListener\(\s*["']keydown["']/);
    expect(src).toContain('modalStack.push(hide, 0, "popover")');
  });
});

describe("when the hint comes", () => {
  it("waits for a resting mouse the first time, and never comes for a touch or a pen", () => {
    later();
    const view = hint();
    for (const pointerType of ["touch", "pen"]) {
      view.now.bind(SPEC).onPointerEnter({ pointerType, ...control(false) } as never);
      expect(timers, pointerType).toHaveLength(0);
      expect(shown(view), pointerType).toBe(false);
    }
    view.now.bind(SPEC).onPointerEnter({ pointerType: "mouse", ...control(false) } as never);
    expect(shown(view)).toBe(false);
    const wait = timers.find(t => t.ms === FIRST_HINT_DELAY_MS)!;
    expect(wait, "no first-hint delay was set").toBeTruthy();
    wait.fn();
    expect(shown(view)).toBe(true);
  });

  it("comes at once under keyboard focus, and not for a focus the pointer made", () => {
    later();
    const view = hint();
    view.now.bind(SPEC).onFocus(control(false) as never);
    expect(shown(view)).toBe(false);
    view.now.bind(SPEC).onFocus(control(true) as never);
    expect(shown(view)).toBe(true);
    expect(timers.filter(t => t.ms === FIRST_HINT_DELAY_MS)).toHaveLength(0);
  });

  it("says nothing for a control whose hint would add nothing", () => {
    const view = hint();
    view.now.bind(null).onFocus(control() as never);
    view.now.bind(null).onPointerEnter({ pointerType: "mouse", ...control(false) } as never);
    expect(shown(view)).toBe(false);
    expect(timers).toHaveLength(0);
    expect(modalStack.depth()).toBe(0);
  });

  it("skips the first one's delay while another is up, or a moment after one went", () => {
    expect(skipsDelay(1_000, -Infinity, false)).toBe(false);
    expect(skipsDelay(1_000, -Infinity, true)).toBe(true);
    expect(skipsDelay(1_000, 1_000 - SKIP_DELAY_WINDOW_MS + 1, false)).toBe(true);
    expect(skipsDelay(1_000, 1_000 - SKIP_DELAY_WINDOW_MS, false)).toBe(false);
  });
});
