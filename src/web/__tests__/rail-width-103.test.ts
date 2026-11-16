// The Sessions list's width, dragged at its right edge (internal #103).
//
// The owner: grab the line between the Sessions list and the board, drag it
// left or right, and keep the width. The rules are pure functions and run as a
// table; the edge runs under fake-react with a stand-in for the elements it
// writes; the sheet and App's wiring are read from their source.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

const { mount, one } = await import("./fake-react");
const {
  MAIN_MIN, RAIL_KEY_STEP, RAIL_KEY_STEP_BIG, RAIL_W, RAIL_WIDTH_KEY, WINDOW_SHARE,
  clampRailWidth, dragMax, fitRailWidth, parseRailWidth, railCap, useRailWidthChoice,
} = await import("../rail-width");
const { default: RailEdge } = await import("../components/RailEdge");
const { leftColumnWidth } = await import("../use-left-column");
type El = import("./fake-react").Drawn;

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let store: Map<string, string>;
type Heard = { type: string; fn: (e: unknown) => void; capture: boolean };
let heard: Heard[];
/** The window's keydown listeners in the capture phase: the drag's Esc. */
const escapes = () => heard.filter(h => h.type === "keydown" && h.capture);
/** A key pressed anywhere, as the window's capture listeners hear it first. */
const pressOnWindow = (k: string) => {
  const e = { key: k, stopped: false, prevented: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  for (const h of escapes()) h.fn(e);
  return e;
};
beforeEach(() => {
  store = new Map();
  heard = [];
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    innerWidth: 1440,
    dispatchEvent() { return true; },
    addEventListener(type: string, fn: (e: unknown) => void, capture?: boolean) { heard.push({ type, fn, capture: capture === true }); },
    removeEventListener(type: string, fn: (e: unknown) => void, capture?: boolean) {
      heard = heard.filter(h => !(h.type === type && h.fn === fn && h.capture === (capture === true)));
    },
  };
});
afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

describe("the numbers", () => {
  it("drags 224 to 560, 8 px a key and 32 with Shift, keeps 400 of the board, at most 40% of the window", () => {
    expect(RAIL_W).toEqual({ min: 224, max: 560 });
    expect([RAIL_KEY_STEP, RAIL_KEY_STEP_BIG]).toEqual([8, 32]);
    expect(MAIN_MIN).toBe(400);
    expect(WINDOW_SHARE).toBe(0.4);
    expect(RAIL_WIDTH_KEY).toBe("agent-dag.sessionListWidth");
  });

  it("reads a kept width, and nothing from a missing or broken one", () => {
    expect(parseRailWidth(null)).toBeNull();
    expect(parseRailWidth("")).toBeNull();
    expect(parseRailWidth("wide")).toBeNull();
    expect(parseRailWidth("-40")).toBeNull();
    expect(parseRailWidth("300")).toBe(300);
    expect(parseRailWidth("301.6")).toBe(302);
    expect(parseRailWidth("100")).toBe(224);
    expect(parseRailWidth("9000")).toBe(560);
    expect(clampRailWidth(10)).toBe(224);
  });

  it("caps the list at 40% of the window, never under the density's width", () => {
    expect(railCap(288, 1920)).toBe(560);
    expect(railCap(288, 1280)).toBe(512);
    expect(railCap(264, 1024)).toBe(409);
    expect(railCap(264, 600)).toBe(264);
    expect(railCap(288, 0)).toBe(560);
  });

  it("draws the reader's width, else the density's, held to the cap; the kept width is not changed", () => {
    expect(fitRailWidth(null, 264, 512)).toBe(264);
    expect(fitRailWidth(400, 264, 512)).toBe(400);
    expect(fitRailWidth(540, 264, 512)).toBe(512);
    // Narrower than the density's is the reader's to choose.
    expect(fitRailWidth(232, 264, 512)).toBe(232);
    // A window too narrow for even the density's width keeps that width.
    expect(fitRailWidth(400, 264, 200)).toBe(264);
  });

  it("lets a drag widen only while the board keeps 400 beside the list", () => {
    expect(dragMax(288, 1000, 560)).toBe(560);
    expect(dragMax(288, 500, 560)).toBe(388);
    expect(dragMax(288, 300, 560)).toBe(288);
    expect(dragMax(288, 1000, 409)).toBe(409);
    expect(dragMax(288, Number.POSITIVE_INFINITY, 512)).toBe(512);
  });

  it("gives the column the list's width, and the accounts panel the density's", () => {
    expect(leftColumnWidth("session-list", 264, 400)).toBe(400);
    expect(leftColumnWidth("accounts", 264, 400)).toBe(264);
    expect(leftColumnWidth(null, 264, 400)).toBe(0);
    expect(leftColumnWidth("session-list", 264)).toBe(264);
  });
});

describe("the kept width", () => {
  it("is written when a width is chosen and removed on a reset", () => {
    let api: ReturnType<typeof useRailWidthChoice> | null = null;
    mount(() => { api = useRailWidthChoice(); return null; }, {});
    expect(api!.chosen).toBeNull();
    api!.choose(377.4);
    expect(store.get(RAIL_WIDTH_KEY)).toBe("377");
    expect(api!.chosen).toBe(377);
    api!.reset();
    expect(store.has(RAIL_WIDTH_KEY)).toBe(false);
    expect(api!.chosen).toBeNull();
  });

  it("comes back on the next load", () => {
    store.set(RAIL_WIDTH_KEY, "420");
    let api: ReturnType<typeof useRailWidthChoice> | null = null;
    mount(() => { api = useRailWidthChoice(); return null; }, {});
    expect(api!.chosen).toBe(420);
  });
});

/** A stand-in for the edge, the list and the column a drag writes. */
function elements() {
  const styleOf = () => {
    const values = new Map<string, string>();
    return { values, setProperty: (k: string, v: string) => { values.set(k, v); } };
  };
  const column = { style: styleOf(), attrs: new Map<string, string>(),
    setAttribute(k: string, v: string) { this.attrs.set(k, v); }, removeAttribute(k: string) { this.attrs.delete(k); } };
  const list = { style: styleOf() };
  const edge = {
    attrs: new Map<string, string>(), captured: new Set<number>(), focused: false,
    setPointerCapture(id: number) { this.captured.add(id); },
    hasPointerCapture(id: number) { return this.captured.has(id); },
    releasePointerCapture(id: number) { this.captured.delete(id); },
    focus() { this.focused = true; },
    setAttribute(k: string, v: string) { this.attrs.set(k, v); },
    closest(sel: string) { return sel === ".left-column" ? column : sel === ".session-list" ? list : null; },
  };
  return { column, list, edge };
}

describe("the edge", () => {
  const drawn = (p: Partial<Parameters<typeof RailEdge>[0]> = {}) => {
    const calls = { width: [] as number[], reset: 0 };
    const m = mount(RailEdge, {
      width: 288, cap: 512,
      onWidth: (w: number) => calls.width.push(w), onReset: () => { calls.reset++; },
      ...p,
    });
    const edge = () => one(m.tree, el => el.props.className === "sl-edge") as El;
    return { m, calls, edge };
  };
  const key = (el: El, k: string, shiftKey = false) => {
    const e = { key: k, shiftKey, defaultPrevented: false, stopped: false, currentTarget: elements().edge,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    (el.props.onKeyDown as (e: unknown) => void)(e);
    return e;
  };
  const pointer = (clientX: number, target: unknown, more: Record<string, unknown> = {}) => ({
    button: 0, pointerId: 7, clientX, currentTarget: target,
    preventDefault() {}, stopPropagation() {}, ...more,
  });

  it("is a separator a keyboard can reach, named, with the values it stands at, for the list", () => {
    const { edge } = drawn();
    const e = edge();
    expect(e.props.role).toBe("separator");
    expect(e.props.tabIndex).toBe(0);
    expect(e.props["aria-orientation"]).toBe("vertical");
    expect(e.props["aria-controls"]).toBe("session-list");
    expect([e.props["aria-valuemin"], e.props["aria-valuemax"], e.props["aria-valuenow"]]).toEqual([224, 512, 288]);
    expect(e.props["aria-label"]).toBe("Sessions list width");
    expect(e.props.title).toBe("Drag to widen or narrow the list · arrow keys move it · double-click resets it");
  });

  it("moves 8 px an arrow, 32 with Shift, right widens; Home and End to the range's ends; the board keeps its keys", () => {
    const { calls, edge } = drawn();
    expect(key(edge(), "ArrowRight").stopped).toBe(true);
    key(edge(), "ArrowRight", true);
    key(edge(), "ArrowLeft");
    key(edge(), "ArrowLeft", true);
    key(edge(), "Home");
    key(edge(), "End");
    const other = key(edge(), "a");
    expect(other.defaultPrevented).toBe(false);
    expect(other.stopped).toBe(false);
    expect(calls.width).toEqual([296, 320, 280, 256, 224, 512]);
  });

  it("does not move past its ends", () => {
    const top = drawn({ width: 512 });
    key(top.edge(), "ArrowRight");
    expect(top.calls.width).toEqual([]);
    const bottom = drawn({ width: 224 });
    key(bottom.edge(), "ArrowLeft");
    expect(bottom.calls.width).toEqual([]);
  });

  it("gives the list back its density's width on Enter and on a double click", () => {
    const { calls, edge } = drawn();
    key(edge(), "Enter");
    (edge().props.onDoubleClick as (e: unknown) => void)({ preventDefault() {} });
    expect(calls.reset).toBe(2);
    expect(calls.width).toEqual([]);
  });

  it("drags the column and the list with the pointer, off their easing, and settles once on release", () => {
    const { calls, edge } = drawn();
    const el = elements();
    const e = edge();
    (e.props.onPointerDown as (e: unknown) => void)(pointer(100, el.edge));
    expect(el.edge.captured.has(7)).toBe(true);
    // The press takes no focus (the terminal keeps it, no ring is drawn); the
    // window hears Esc while the drag lasts.
    expect(el.edge.focused).toBe(false);
    expect(escapes()).toHaveLength(1);
    expect(el.column.attrs.has("data-resizing")).toBe(true);
    (e.props.onPointerMove as (e: unknown) => void)(pointer(150, el.edge));
    (e.props.onPointerMove as (e: unknown) => void)(pointer(180, el.edge));
    expect(el.column.style.values.get("--left-col-w")).toBe("calc(368px + var(--ui-panel-increase, 0px))");
    expect(el.column.style.values.get("--list-w")).toBe("calc(368px + var(--ui-panel-increase, 0px))");
    expect(el.edge.attrs.get("aria-valuenow")).toBe("368");
    expect(calls.width).toEqual([]);
    (e.props.onPointerUp as (e: unknown) => void)(pointer(180, el.edge));
    (e.props.onLostPointerCapture as (e: unknown) => void)(pointer(180, el.edge));
    expect(calls.width).toEqual([368]);
    expect(el.column.attrs.has("data-resizing")).toBe(false);
    // Released: Esc is the deck's again.
    expect(escapes()).toHaveLength(0);
    expect(pressOnWindow("Escape").stopped).toBe(false);
  });

  it("holds the drag inside the range and the window's cap", () => {
    const { calls, edge } = drawn();
    const el = elements();
    const e = edge();
    (e.props.onPointerDown as (e: unknown) => void)(pointer(100, el.edge));
    (e.props.onPointerMove as (e: unknown) => void)(pointer(900, el.edge));
    expect(el.column.style.values.get("--list-w")).toBe("calc(512px + var(--ui-panel-increase, 0px))");
    (e.props.onPointerMove as (e: unknown) => void)(pointer(-400, el.edge));
    (e.props.onPointerUp as (e: unknown) => void)(pointer(-400, el.edge));
    expect(calls.width).toEqual([224]);
  });

  it("puts everything back when the browser takes the pointer, or on Esc", () => {
    const cancelled = drawn();
    const a = elements();
    const e = cancelled.edge();
    (e.props.onPointerDown as (e: unknown) => void)(pointer(100, a.edge));
    (e.props.onPointerMove as (e: unknown) => void)(pointer(160, a.edge));
    (e.props.onPointerCancel as (e: unknown) => void)(pointer(160, a.edge));
    expect(cancelled.calls.width).toEqual([]);
    expect(a.column.style.values.get("--list-w")).toBe("calc(288px + var(--ui-panel-increase, 0px))");
    expect(a.column.style.values.get("--left-col-w")).toBe("calc(288px + var(--ui-panel-increase, 0px))");
    expect(a.column.attrs.has("data-resizing")).toBe(false);

    const escaped = drawn();
    const b = elements();
    const f = escaped.edge();
    (f.props.onPointerDown as (e: unknown) => void)(pointer(100, b.edge));
    (f.props.onPointerMove as (e: unknown) => void)(pointer(160, b.edge));
    // Another key on the way is not the drag's.
    expect(pressOnWindow("a").stopped).toBe(false);
    // Esc wherever the focus is (the terminal's, in Workspace): the drag's, and no one else's.
    const esc = pressOnWindow("Escape");
    expect([esc.stopped, esc.prevented]).toEqual([true, true]);
    expect(b.edge.captured.has(7)).toBe(false);
    expect(b.column.attrs.has("data-resizing")).toBe(false);
    expect(escapes()).toHaveLength(0);
    (f.props.onPointerUp as (e: unknown) => void)(pointer(160, b.edge));
    expect(escaped.calls.width).toEqual([]);
    expect(b.column.style.values.get("--list-w")).toBe("calc(288px + var(--ui-panel-increase, 0px))");
  });

  it("stops listening for Esc when the list goes mid-drag", () => {
    const { m, edge } = drawn();
    const el = elements();
    (edge().props.onPointerDown as (e: unknown) => void)(pointer(100, el.edge));
    expect(escapes()).toHaveLength(1);
    m.unmount();
    expect(escapes()).toHaveLength(0);
  });

  it("leaves Esc alone when nothing is being dragged, and a press that does not move settles nothing", () => {
    const { calls, edge } = drawn();
    const el = elements();
    const esc = { key: "Escape", shiftKey: false, currentTarget: el.edge, stopped: false, prevented: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    (edge().props.onKeyDown as (e: unknown) => void)(esc);
    expect([esc.stopped, esc.prevented]).toEqual([false, false]);
    (edge().props.onPointerDown as (e: unknown) => void)(pointer(100, el.edge));
    (edge().props.onPointerUp as (e: unknown) => void)(pointer(100, el.edge));
    expect(calls.width).toEqual([]);
  });

  it("ignores any button but the main one", () => {
    const { edge } = drawn();
    const el = elements();
    (edge().props.onPointerDown as (e: unknown) => void)(pointer(100, el.edge, { button: 2 }));
    expect(el.edge.captured.size).toBe(0);
    expect(el.column.attrs.has("data-resizing")).toBe(false);
  });
});

describe("the sheet", () => {
  const column = read("styles/left-column.css");
  const list = read("styles/session-list.css");

  it("draws the list at --list-w, else the rail token, before the phone's full-width rule", () => {
    const own = ".left-column > .session-list { width: var(--list-w, calc(var(--rail-w) + var(--ui-panel-increase, 0px))); }";
    expect(column).toContain(own);
    expect(column.indexOf(own)).toBeLessThan(column.indexOf("@media (max-width: 640px)"));
    // The list's own rule is the rail token, as before, for every other place it is drawn.
    expect(list).toContain("width: calc(var(--rail-w) + var(--ui-panel-increase, 0px));");
  });

  it("does not ease or select while a drag moves it", () => {
    expect(column).toMatch(/\.left-column\[data-resizing\] \{ transition: none; user-select: none; \}/);
  });

  it("lets a narrow pane header cut its state word instead of drawing it over the context chip", () => {
    const stage = read("styles/terminal-stage.css");
    const narrow = stage.slice(stage.indexOf("@container ts-head (max-width: 480px)"));
    const block = narrow.slice(0, narrow.indexOf("\n}\n"));
    expect(block).toContain(".ts-meta { overflow: hidden; }");
    expect(block).toContain(".ts-meta-state { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }");
    // Wider headers keep the state whole; the tool and its argument give way first.
    expect(stage).toMatch(/\.ts-meta-state \{ flex: none;/);
  });

  it("puts the edge in the list's last 8 px, a col-resize cursor, a line when hovered, held or focused", () => {
    const rule = /\.session-list > \.sl-edge \{([^}]*)\}/.exec(list)?.[1] ?? "";
    expect(rule).toMatch(/position: absolute;/);
    expect(rule).toMatch(/right: 0;/);
    expect(rule).toMatch(/width: 8px;/);
    expect(rule).toMatch(/cursor: col-resize;/);
    expect(rule).toMatch(/touch-action: none;/);
    expect(list).toMatch(/\.left-column\[data-resizing\] \.sl-edge \{ box-shadow: inset -2px 0 0 var\(--accent\); \}/);
    expect(list).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.session-list > \.sl-edge:hover \{ box-shadow: inset -2px 0 0 var\(--accent\); \}/);
    expect(list).toMatch(/\.session-list > \.sl-edge:focus-visible \{ outline: var\(--focus-w\) solid var\(--accent\);/);
  });
});

describe("App's wiring", () => {
  const app = code("App.tsx");

  it("draws the list at the reader's width held to the window, and the column and the right panels follow it", () => {
    expect(app).toContain("const listWidth = fitRailWidth(railChoice.chosen, railWidth, railCapNow);");
    expect(app).toContain("useRightPanels(leftColumnWidth(leftPanel, railWidth, listWidth)");
    expect(app).toMatch(/railWidth, phone \? railWidth : listWidth\);/);
  });

  it("draws the edge everywhere but on a phone, where the list is the screen's width", () => {
    // The column holds the list's width as --list-w; the list inherits it.
    expect(app).toContain("<LeftColumn width={leftColumnTarget} listWidth={phone ? undefined : listWidth}>");
    expect(app).toMatch(/edge=\{phone \? undefined : \(\s*<RailEdge width=\{listWidth\} cap=\{railCapNow\} onWidth=\{railChoice\.choose\} onReset=\{railChoice\.reset\} \/>/);
  });

  it("puts the edge last in the list, and the list's width on the column, whose list inherits it", () => {
    const sl = code("components/SessionList.tsx");
    expect(sl).toMatch(/\{edge\}\s*<\/aside>/);
    // The list's <aside> is as it was: no width of its own on it.
    expect(sl).not.toContain("--list-w");
    const column = code("components/LeftColumn.tsx");
    expect(column).toContain('{ "--list-w": `calc(${listWidth}px + var(--ui-panel-increase, 0px))` }');
    expect(column).toContain("...(listWidth === undefined ? null :");
  });
});
