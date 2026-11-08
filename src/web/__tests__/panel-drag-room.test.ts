// A moved panel's room is the view (owner, 2026-11-08): from under the top bar
// to the status bar, the window's full width, the header always whole inside.
// Nothing else bounds the drag: not the panel's home slot, not the other panel.
//
// The bug this pins: in Workspace the machine panel's home slot is the lower
// half of the column under the Inspector's head, and the drag took its least
// top from that slot, so the panel could be moved sideways and down but never
// higher than the half it started in, never above Usage. Run as the hook
// itself (usePanelPlace under fake-react), against stubs of the panel and its
// header, with the presses a mouse would make on the header.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLACE_KEYS, parsePlace, usePanelPlace } from "../panel-place";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

type Rect = { left: number; top: number; width: number; height: number };
const HEAD = 36;
const TOPBAR = 40;
const STATUS = 24;

let store: Map<string, string>;
let win: { innerWidth: number; innerHeight: number };
/** Where the panel's home slot is on the current layout. */
let home: Rect;

beforeEach(() => {
  store = new Map();
  win = { innerWidth: 1440, innerHeight: 900 };
  const g = globalThis as Record<string, unknown>;
  g.Element = class {};
  g.window = Object.assign(win, {
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    addEventListener() {},
    removeEventListener() {},
  });
  g.requestAnimationFrame = () => 0;
  g.document = {
    querySelector: (sel: string) => {
      if (sel === ".topbar") return { getBoundingClientRect: () => ({ bottom: TOPBAR, height: TOPBAR }) };
      if (sel === ".statusbar") return { getBoundingClientRect: () => ({ height: STATUS }) };
      return null;
    },
    querySelectorAll: () => [],
  };
});
afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of ["Element", "window", "requestAnimationFrame", "document"]) delete g[k];
});

/** The panel as the browser lays it out: the inline box while it is dragged,
 *  else the stored place as panel-place.css draws it, else the home slot. */
function stubPanel(read: () => ReturnType<typeof usePanelPlace> | null) {
  const attrs = new Map<string, string>();
  const style: Record<string, string> & { removeProperty: (n: string) => void } = {
    removeProperty: (n: string) => { delete style[n]; },
  } as never;
  const rect = (): Rect => {
    if (style.top) return { left: parseFloat(style.left), top: parseFloat(style.top), width: home.width, height: home.height };
    const place = attrs.has("data-place") ? read()?.place : null;
    if (place) {
      const left = place.edge === "left" ? place.x : win.innerWidth - place.x - home.width;
      return { left, top: place.y, width: home.width, height: home.height };
    }
    return home;
  };
  const box = () => { const r = rect(); return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }; };
  const panel = {
    style, offsetLeft: 0, offsetTop: 0, offsetWidth: 320, offsetHeight: 400,
    getBoundingClientRect: box,
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { attrs.set(n, v); },
    removeAttribute: (n: string) => { attrs.delete(n); },
    sync(edge: string | undefined) { if (edge) attrs.set("data-place", edge); else attrs.delete("data-place"); },
  };
  const header = {
    setPointerCapture() {},
    getBoundingClientRect: () => { const r = rect(); return { top: r.top + 1, bottom: r.top + 1 + HEAD, left: r.left, width: r.width }; },
  };
  return { panel, header };
}

/** Mounts the machine panel's hook, as a reload does: whatever place the
 *  browser kept is read again. */
function machine() {
  let latest: ReturnType<typeof usePanelPlace> | null = null;
  const { panel, header } = stubPanel(() => latest);
  const Panel = () => { latest = usePanelPlace(PLACE_KEYS.machine); panel.sync(latest.panel["data-place"]); return null; };
  const view = mount(Panel, {});
  (latest!.panel.ref as { current: unknown }).current = panel;
  const ev = (x: number, y: number) => ({
    button: 0, pointerId: 1, clientX: x, clientY: y, target: header, currentTarget: header, preventDefault() {},
  });
  /** Presses the header and moves the pointer by (dx, dy) in steps; returns
   *  the top the panel was drawn at during the move. */
  const drag = (dx: number, dy: number) => {
    const h = header.getBoundingClientRect();
    const x = h.left + 60, y = h.top + 10;
    const grip = latest!.grip as Record<string, (e: unknown) => void>;
    grip.onPointerDown(ev(x, y));
    const tops: number[] = [];
    for (let i = 1; i <= 10; i++) {
      grip.onPointerMove(ev(x + (dx * i) / 10, y + (dy * i) / 10));
      tops.push(parseFloat(panel.style.top));
    }
    grip.onPointerUp(ev(x + dx, y + dy));
    view.rerender({});
    return tops;
  };
  return { drag, panel, view, stored: () => parsePlace(store.get(PLACE_KEYS.machine) ?? null) };
}

// Workspace at 1440 x 900 with the Inspector column: Usage is the column's top
// half under the Inspector's head (76 to 440), the machine panel the lower half.
const USAGE_TOP_WORKSPACE = 76;
const WORKSPACE_HOME: Rect = { left: 1080, top: 476, width: 320, height: 400 };
// The Board: both at the top of the rail, the machine panel one slot left.
const USAGE_TOP_BOARD = 48;
const BOARD_HOME: Rect = { left: 740, top: 48, width: 320, height: 400 };

describe("the machine panel dragged up in Workspace", () => {
  it("goes above Usage, up to the top bar's foot, and is kept there", () => {
    home = WORKSPACE_HOME;
    const m = machine();
    const tops = m.drag(0, -700);
    expect(Math.min(...tops), "drawn above Usage during the move").toBeLessThan(USAGE_TOP_WORKSPACE);
    expect(tops.at(-1), "stops at the top bar, not at its home slot").toBe(TOPBAR);
    expect(m.stored()).toEqual({ edge: "right", x: 1440 - 1080 - 320, y: TOPBAR });
  });

  it("goes above Usage again after a reload, from a place below it", () => {
    home = WORKSPACE_HOME;
    store.set(PLACE_KEYS.machine, JSON.stringify({ edge: "right", x: 40, y: 600 }));
    const m = machine();
    const tops = m.drag(0, -700);
    expect(tops.at(-1)).toBe(TOPBAR);
    expect(m.stored()?.y).toBeLessThan(USAGE_TOP_WORKSPACE);
  });

  it("goes above Usage after the window is made smaller", () => {
    win.innerWidth = 1280;
    win.innerHeight = 720;
    // Under 1320 there is no Inspector column; the lower half is still home.
    home = { left: 920, top: 396, width: 320, height: 300 };
    const m = machine();
    const tops = m.drag(0, -600);
    expect(tops.at(-1)).toBe(TOPBAR);
    expect(m.stored()?.y).toBeLessThan(USAGE_TOP_WORKSPACE);
  });

  it("goes above Usage on the Board and again back in Workspace", () => {
    home = BOARD_HOME;
    const m = machine();
    expect(m.drag(-100, -300).at(-1), "on the Board").toBeLessThan(USAGE_TOP_BOARD);
    // Back to Workspace: the home slot is the lower half again, the place stays.
    m.view.rerender({});
    home = WORKSPACE_HOME;
    store.set(PLACE_KEYS.machine, JSON.stringify({ edge: "right", x: 40, y: 600 }));
    const again = machine();
    expect(again.drag(0, -700).at(-1)).toBeLessThan(USAGE_TOP_WORKSPACE);
  });
});

describe("the room is the whole view, the header always inside", () => {
  it("lets the panel go to the window's very edges", () => {
    home = WORKSPACE_HOME;
    const m = machine();
    m.drag(-5000, 0);
    expect(m.stored()).toMatchObject({ edge: "left", x: 0 });
    m.drag(5000, 0);
    expect(m.stored()).toMatchObject({ edge: "right", x: 0 });
  });

  it("keeps the header whole above the status bar", () => {
    home = WORKSPACE_HOME;
    const m = machine();
    const tops = m.drag(0, 5000);
    // The header's foot and the panel's bottom border end where the bar begins.
    expect(tops.at(-1)! + 1 + HEAD + 1).toBe(900 - STATUS);
  });
});
