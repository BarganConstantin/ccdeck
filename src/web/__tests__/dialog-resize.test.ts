// Resizing a tracker's dialog (DialogResize.tsx): the hook that holds the
// size, the handles on its edges and corners, keyboard mode and the Size menu,
// run through the hooks-only React (fake-react.ts) with a stand-in for the
// dialog's box; and the sheet and host wiring that the browser pass measures.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount, one, textOf, type Drawn } from "./fake-react";
import type { DialogResize as Resize } from "../components/DialogResize";
import { DIALOG_CAP, DIALOG_MIN, DIALOG_SHARE, EDGES, SHEET_QUERY, WINDOW_GAP, type Rect } from "../integrations/dialog-size";

const media = vi.hoisted(() => ({ sheet: false }));
vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../use-media-query", () => ({ useMediaQuery: () => media.sheet }));
const { DialogResizeHandles, DialogSizeMenu, useDialogResize } = await import("../components/DialogResize");
const { modalStack } = await import("../modal-dismiss");

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const key = (kind: string) => `agent-dag.integrations.${kind}.dialog-size`;

const store = new Map<string, string>();
const unmounts: Array<() => void> = [];
beforeEach(() => {
  store.clear();
  media.sheet = false;
  vi.stubGlobal("window", {
    innerWidth: 1440, innerHeight: 900, dispatchEvent: () => true,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "0px" }));
});
afterEach(() => { for (const u of unmounts.splice(0)) u(); vi.unstubAllGlobals(); });

/** The dialog as the hook and the handles see it: its box, its scrim's box
 *  (the window) and the custom properties a drag writes. */
function dialogAt(rect: Rect, room = { width: 1440, height: 900 }) {
  const props = new Map<string, string>();
  const el = {
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    parentElement: { getBoundingClientRect: () => ({ left: 0, top: 0, ...room }) },
    style: { setProperty: (k: string, v: string) => props.set(k, v) },
    dataset: {} as Record<string, string>,
  };
  return { el, props, move(next: Rect) { rect = next; } };
}

function host(kind: string, el: unknown) {
  const ref = { current: el as HTMLElement };
  const view = mount((p: { kind: string }) => useDialogResize(p.kind, ref), { kind });
  unmounts.push(view.unmount);
  return { view, get r() { return view.tree as unknown as Resize; } };
}

const focusable = () => ({ isConnected: true, focus: vi.fn() });

describe("the size the hook holds", () => {
  it("opens at the default, with nothing on the dialog's style for the sheet to clamp but its own numbers", () => {
    const { r } = host("jira", dialogAt({ left: 86.5, top: 54, width: 1267, height: 792 }).el);
    expect(r.enabled).toBe(true);
    expect(r.style).toEqual({});
    expect(r.preset).toBe("default");
    expect(r.keyboard).toBeNull();
  });

  it("brings back the size this provider was left at, and only this provider's", () => {
    store.set(key("jira"), '{"width":900,"height":600}');
    expect(host("jira", null).r.style).toEqual({ "--ig-w": "900px", "--ig-h": "600px" });
    expect(host("gitlab", null).r.style).toEqual({});
  });

  it("keeps a drag's size and the place it left the dialog", () => {
    const h = host("jira", dialogAt({ left: 86.5, top: 54, width: 1267, height: 792 }).el);
    h.r.commit({ left: 100, top: 50, width: 1000.4, height: 700.6 });
    expect(store.get(key("jira"))).toBe('{"width":1000,"height":701}');
    expect(h.r.style).toEqual({ "--ig-w": "1000px", "--ig-h": "701px", "--ig-x": "-120px", "--ig-y": "-50px" });
    expect(h.r.preset).toBeNull();
  });

  it("chooses the menu's sizes: the default keeps the place, Fill the window centres it", () => {
    const h = host("jira", dialogAt({ left: 86.5, top: 54, width: 1267, height: 792 }).el);
    h.r.commit({ left: 100, top: 50, width: 1000, height: 700 });
    h.r.choose("default");
    expect(store.has(key("jira"))).toBe(false);
    expect(h.r.style).toEqual({ "--ig-x": "-120px", "--ig-y": "-50px" });
    expect(h.r.preset).toBe("default");
    h.r.choose("fill");
    expect(store.get(key("jira"))).toBe('"fill"');
    expect(h.r.style).toEqual({ "--ig-w": "100vw", "--ig-h": "100dvh" });
    expect(h.r.preset).toBe("fill");
    h.r.choose("smaller");
    expect(store.get(key("jira"))).toBe('{"width":720,"height":480}');
    expect(h.r.preset).toBe("smaller");
  });

  it("goes back to the default size, centred, on Reset size", () => {
    store.set(key("jira"), '{"width":900,"height":600}');
    const h = host("jira", dialogAt({ left: 100, top: 50, width: 900, height: 600 }).el);
    h.r.commit({ left: 100, top: 50, width: 900, height: 600 });
    h.r.reset();
    expect(store.has(key("jira"))).toBe(false);
    expect(h.r.style).toEqual({});
    expect(h.r.preset).toBe("default");
  });

  it("draws nothing to resize on a phone's sheet", () => {
    store.set(key("jira"), '{"width":900,"height":600}');
    media.sheet = true;
    const { r } = host("jira", null);
    expect(r.enabled).toBe(false);
    expect(r.style).toBeUndefined();
  });
});

describe("keyboard mode", () => {
  const start = () => {
    const d = dialogAt({ left: 86.5, top: 54, width: 1267, height: 792 });
    const h = host("jira", d.el);
    const back = focusable();
    const depth = modalStack.depth();
    h.r.startKeyboard(back as unknown as HTMLElement);
    return { d, h, back, depth };
  };

  it("steps 32 with an arrow and 128 with Shift, and writes nothing until Enter keeps it", () => {
    const { h, back, depth } = start();
    expect(h.r.keyboard?.rect).toEqual({ left: 86.5, top: 54, width: 1267, height: 792 });
    expect(modalStack.depth()).toBe(depth + 1);
    expect(h.r.stepKeyboard("ArrowRight", false)).toBe(true);
    expect(h.r.keyboard?.rect.width).toBe(1299);
    expect(h.r.style).toMatchObject({ "--ig-w": "1299px", "--ig-h": "792px" });
    // Two presses before a render step from each other, not from the same place.
    expect(h.r.stepKeyboard("ArrowLeft", true)).toBe(true);
    expect(h.r.stepKeyboard("ArrowUp", false)).toBe(true);
    expect(h.r.keyboard?.rect).toMatchObject({ width: 1171, height: 760 });
    expect(h.r.stepKeyboard("ArrowDown", true)).toBe(true);
    expect(h.r.stepKeyboard("ArrowDown", true)).toBe(true);
    expect(h.r.keyboard?.rect.height).toBe(868); // the window less 16 a side
    expect(h.r.stepKeyboard("a", false)).toBe(false);
    expect(h.r.stepKeyboard("Tab", false)).toBe(false);
    expect(store.has(key("jira"))).toBe(false);
    h.r.endKeyboard(true);
    expect(h.r.keyboard).toBeNull();
    expect(store.get(key("jira"))).toBe('{"width":1171,"height":868}');
    expect(back.focus).toHaveBeenCalled();
    expect(modalStack.depth()).toBe(depth);
  });

  it("puts the size and the place back on Escape, before anything else closes", () => {
    store.set(key("jira"), '{"width":900,"height":600}');
    const d = dialogAt({ left: 270, top: 150, width: 900, height: 600 });
    const h = host("jira", d.el);
    const back = focusable();
    h.r.startKeyboard(back as unknown as HTMLElement);
    h.r.stepKeyboard("ArrowRight", true);
    h.r.stepKeyboard("ArrowDown", true);
    expect(h.r.style).toMatchObject({ "--ig-w": "1028px", "--ig-h": "728px" });
    // Escape reaches the deck's dismiss stack, whose top is keyboard mode.
    expect(modalStack.dismissTop()).toBe(true);
    expect(h.r.keyboard).toBeNull();
    expect(h.r.style).toEqual({ "--ig-w": "900px", "--ig-h": "600px" });
    expect(store.get(key("jira"))).toBe('{"width":900,"height":600}');
    expect(back.focus).toHaveBeenCalled();
  });

  it("ends, putting the size back, when the window narrows to a phone's sheet", () => {
    const { h } = start();
    h.r.stepKeyboard("ArrowRight", false);
    media.sheet = true;
    h.view.rerender();
    expect(h.r.keyboard).toBeNull();
    expect(h.r.enabled).toBe(false);
    expect(store.has(key("jira"))).toBe(false);
  });

  it("is a band that takes the arrows, says what they do and announces the size", () => {
    const resize = {
      dialogRef: { current: null }, commit: vi.fn(), reset: vi.fn(),
      keyboard: { before: { chosen: null, offset: null }, rect: { left: 0, top: 0, width: 1299.4, height: 792 }, inside: false },
      stepKeyboard: vi.fn((k: string) => k.startsWith("Arrow")), endKeyboard: vi.fn(),
    } as unknown as Resize;
    const handles = mount(DialogResizeHandles, { resize });
    unmounts.push(handles.unmount);
    const spec = one(handles.tree, e => typeof e.type === "function" && (e.type as { name: string }).name === "KeyboardBand")!;
    const band = mount(spec.type as (p: Record<string, unknown>) => unknown, spec.props);
    unmounts.push(band.unmount);
    const root = band.tree as Drawn;
    expect(root.props.className).toBe("ig-rs-keys");
    expect(root.props.role).toBe("application");
    expect(root.props.tabIndex).toBe(-1);
    expect(root.props["aria-label"]).toBe("Resize with the keyboard");
    const help = one(root, e => e.props.id === root.props["aria-describedby"]);
    expect(textOf(help)).toContain("by 32 pixels, or 128 with Shift");
    expect(textOf(one(root, e => e.props.role === "status"))).toBe("1299 by 792 pixels");
    expect(textOf(one(root, e => e.props.className === "ig-rs-keys-hint"))).toBe("←→↑↓ 32 px · Shift 128 · ↵ keep · Esc cancel");
    const press = (k: string, shiftKey = false) => {
      const e = { key: k, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      (root.props.onKeyDown as (e: unknown) => void)(e);
      return e;
    };
    const arrow = press("ArrowRight", true);
    expect(resize.stepKeyboard).toHaveBeenCalledWith("ArrowRight", true);
    expect(arrow.preventDefault).toHaveBeenCalled();
    const tab = press("Tab");
    expect(tab.preventDefault).not.toHaveBeenCalled();
    const enter = press("Enter");
    expect(resize.endKeyboard).toHaveBeenCalledWith(true);
    expect(enter.stopPropagation).toHaveBeenCalled();
    (root.props.onBlur as () => void)();
    expect(resize.endKeyboard).toHaveBeenCalledTimes(2);
  });
});

describe("the handles", () => {
  const drawn = (rect: Rect) => {
    const d = dialogAt(rect);
    const resize = { dialogRef: { current: d.el }, commit: vi.fn(), reset: vi.fn(), keyboard: null } as unknown as Resize;
    const view = mount(DialogResizeHandles, { resize });
    unmounts.push(view.unmount);
    const edge = (name: string) => one(view.tree, e => e.props["data-edge"] === name)!;
    const grip = () => one(view.tree, e => e.props.className === "ig-rs-grip")!;
    const readout = () => one(view.tree, e => e.props.className === "ig-rs-readout");
    return { d, resize, view, edge, grip, readout };
  };
  const pointer = (clientX: number, clientY: number, extra: Record<string, unknown> = {}) => ({
    button: 0, clientX, clientY, pointerId: 1, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() }, ...extra,
  });

  it("are eight zones, all hidden from assistive technology, and a grip", () => {
    const { view, grip } = drawn({ left: 200, top: 100, width: 1000, height: 700 });
    const edges = all(view.tree, e => e.props.className === "ig-rs");
    expect(edges.map(e => e.props["data-edge"])).toEqual([...EDGES]);
    for (const e of edges) expect(e.props["aria-hidden"]).toBe("true");
    expect(grip().props["aria-hidden"]).toBe("true");
    expect(grip().props.title).toBe("Drag to resize · double-click for the default size");
  });

  it("move the west edge with the pointer, keep the east one, show the size, and keep it on release", () => {
    const { d, resize, edge, readout } = drawn({ left: 200, top: 100, width: 1000, height: 700 });
    (edge("w").props.onPointerDown as (e: unknown) => void)(pointer(200, 400));
    expect(d.el.dataset.resizing).toBe("w");
    (edge("w").props.onPointerMove as (e: unknown) => void)(pointer(100, 420));
    expect(d.props.get("--ig-w")).toBe("1100px");
    expect(d.props.get("--ig-h")).toBe("700px");
    // Centred would be 170 from the left; it is 100, so 70 to the left of it.
    expect(d.props.get("--ig-x")).toBe("-70px");
    expect(textOf(readout())).toBe("1100 × 700");
    (edge("w").props.onPointerUp as () => void)();
    expect(resize.commit).toHaveBeenCalledWith({ left: 100, top: 100, width: 1100, height: 700 });
    expect(d.el.dataset.resizing).toBeUndefined();
    expect(readout()).toBeNull();
  });

  it("move both of a corner's edges", () => {
    const { d, resize, edge } = drawn({ left: 200, top: 100, width: 1000, height: 700 });
    (edge("nw").props.onPointerDown as (e: unknown) => void)(pointer(200, 100));
    expect(d.el.dataset.resizing).toBe("n w");
    (edge("nw").props.onPointerMove as (e: unknown) => void)(pointer(150, 60));
    (edge("nw").props.onPointerUp as () => void)();
    expect(resize.commit).toHaveBeenCalledWith({ left: 150, top: 60, width: 1050, height: 740 });
  });

  it("keep the size as it was after a press that did not move, the default included", () => {
    const { resize, grip } = drawn({ left: 86.5, top: 54, width: 1267, height: 792 });
    (grip().props.onPointerDown as (e: unknown) => void)(pointer(1350, 840));
    (grip().props.onPointerMove as (e: unknown) => void)(pointer(1350, 840));
    (grip().props.onPointerUp as () => void)();
    expect(resize.commit).not.toHaveBeenCalled();
  });

  it("go back to the default size on a double click on the grip", () => {
    const { resize, grip } = drawn({ left: 200, top: 100, width: 1000, height: 700 });
    (grip().props.onDoubleClick as () => void)();
    expect(resize.reset).toHaveBeenCalled();
  });

  it("answer only the main button", () => {
    const { d, resize, edge } = drawn({ left: 200, top: 100, width: 1000, height: 700 });
    const e = pointer(1200, 400, { button: 2 });
    (edge("e").props.onPointerDown as (e: unknown) => void)(e);
    expect(e.currentTarget.setPointerCapture).not.toHaveBeenCalled();
    (edge("e").props.onPointerMove as (e: unknown) => void)(pointer(1300, 400));
    (edge("e").props.onPointerUp as () => void)();
    expect(d.props.size).toBe(0);
    expect(resize.commit).not.toHaveBeenCalled();
  });
});

describe("the Size menu", () => {
  const drawn = (preset: string | null) => {
    const trigger = focusable();
    vi.stubGlobal("document", { getElementById: () => trigger });
    const resize = { preset, choose: vi.fn(), reset: vi.fn(), startKeyboard: vi.fn() } as unknown as Resize;
    const view = mount(DialogSizeMenu, { resize });
    unmounts.push(view.unmount);
    const button = () => one(view.tree, e => e.type === "button" && e.props["aria-haspopup"] === "menu")!;
    const items = () => all(view.tree, e => e.props.role === "menuitem");
    const item = (label: string) => items().find(e => textOf(e).startsWith(label))!;
    return { trigger, resize, view, button, items, item };
  };

  it("is a named button in the header that opens a menu of five", () => {
    const { button, items } = drawn("default");
    expect(button().props["aria-label"]).toBe("Size");
    expect(button().props["aria-expanded"]).toBe(false);
    expect(items()).toHaveLength(0);
    (button().props.onClick as () => void)();
    expect(button().props["aria-expanded"]).toBe(true);
    expect(items().map(textOf)).toEqual(["Default size", "Fill the window", "Smaller · 720 × 480", "Resize with the keyboard", "Reset size"]);
  });

  it("marks the size that is on", () => {
    const { button, item } = drawn("fill");
    (button().props.onClick as () => void)();
    expect(item("Fill the window").props["aria-current"]).toBe(true);
    expect(item("Default size").props["aria-current"]).toBeUndefined();
  });

  it("opens from the keyboard, on the first item with Down and the last with Up", () => {
    const { view, button } = drawn(null);
    const press = (key: string) => (button().props.onKeyDown as (e: unknown) => void)({ key, preventDefault: vi.fn() });
    press("ArrowUp");
    expect(one(view.tree, e => e.props.role === "menu")?.props.start).toBe("last");
    press("ArrowDown");
    expect(one(view.tree, e => e.props.role === "menu")?.props.start).toBe("first");
  });

  it("chooses a size, closes, and gives focus back to the button", () => {
    const { trigger, resize, button, item, items } = drawn("default");
    (button().props.onClick as () => void)();
    (item("Fill the window").props.onClick as () => void)();
    expect(resize.choose).toHaveBeenCalledWith("fill");
    expect(items()).toHaveLength(0);
    expect(trigger.focus).toHaveBeenCalled();
    (button().props.onClick as () => void)();
    (item("Reset size").props.onClick as () => void)();
    expect(resize.reset).toHaveBeenCalled();
  });

  it("starts keyboard mode with focus to come back to the button", () => {
    const { trigger, resize, button, item } = drawn("default");
    (button().props.onClick as () => void)();
    (item("Resize with the keyboard").props.onClick as () => void)();
    expect(resize.startKeyboard).toHaveBeenCalledWith(trigger);
  });
});

describe("the sheet and the host", () => {
  const css = strip(read("styles/integrations.css"));
  const rule = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  };

  it("clamps the size from the same numbers as the arithmetic", () => {
    const r = rule(".modal.ig-modal");
    const share = `${Math.round(DIALOG_SHARE * 100)}`;
    expect(r).toContain(`min(${share}vw, ${DIALOG_CAP.width}px)`);
    expect(r).toContain(`min(${share}dvh, ${DIALOG_CAP.height}px)`);
    expect(r).toContain(`min(${DIALOG_MIN.width}px, var(--ig-room-w))`);
    expect(r).toContain(`min(${DIALOG_MIN.height}px, var(--ig-room-h))`);
    expect(r).toContain(`calc(100vw - ${2 * WINDOW_GAP}px)`);
    expect(r).toContain(`calc(100dvh - ${2 * WINDOW_GAP}px - var(--ig-top))`);
    // Offset with left and top, never a transform: a transform would make the
    // dialog the containing block of its fixed popovers and move them.
    expect(r).toMatch(/position:\s*relative/);
    expect(r).not.toMatch(/transform|translate/);
  });

  it("gives each edge its cursor, an 8px zone outside the 1px border, and a 2px accent line", () => {
    expect(rule('.ig-rs[data-edge="n"]')).toMatch(/top:\s*-9px;[^}]*height:\s*9px;[^}]*cursor:\s*ns-resize/);
    expect(rule('.ig-rs[data-edge="s"]')).toMatch(/cursor:\s*ns-resize/);
    expect(rule('.ig-rs[data-edge="e"]')).toMatch(/right:\s*-9px;[^}]*width:\s*9px;[^}]*cursor:\s*ew-resize/);
    expect(rule('.ig-rs[data-edge="w"]')).toMatch(/cursor:\s*ew-resize/);
    expect(rule('.ig-rs[data-edge="nw"]')).toMatch(/cursor:\s*nwse-resize/);
    expect(rule('.ig-rs[data-edge="se"]')).toMatch(/cursor:\s*nwse-resize/);
    expect(rule('.ig-rs[data-edge="ne"]')).toMatch(/cursor:\s*nesw-resize/);
    expect(rule('.ig-rs[data-edge="sw"]')).toMatch(/cursor:\s*nesw-resize/);
    expect(rule('.ig-rs[data-edge="n"]::before')).toMatch(/height:\s*2px/);
    expect(css).toMatch(/\.ig-modal\[data-resizing~="e"\] > \.ig-rs\[data-edge="e"\]::before[^{]*\{\s*opacity:\s*1/);
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*\.ig-modal:not\(\[data-resizing\]\):has\(/);
  });

  it("is a full-screen sheet on a phone, at the width the hook calls a sheet", () => {
    expect(SHEET_QUERY).toBe("(max-width: 640px)");
    expect(css).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.modal\.ig-modal\s*\{[^}]*position:\s*static;[^}]*width:\s*100vw;[^}]*height:\s*100dvh;/);
  });

  it("draws the handles and the Size button only off the phone, and clips the content in a frame", () => {
    const modal = read("components/IntegrationModal.tsx");
    expect(modal).toContain("const resize = useDialogResize(kind, dialogRef);");
    expect(modal).toMatch(/style=\{resize\.style\}/);
    expect(modal).toContain('<div className="ig-frame">');
    expect(modal).toContain("{resize.enabled && <DialogResizeHandles resize={resize} />}");
    expect(modal).toContain("<FreshnessTools.Provider value={resize.enabled ? <DialogSizeMenu resize={resize} /> : null}>");
    // The Size button sits between the freshness line and Refresh, only when
    // they are drawn in the header's slot.
    expect(read("components/IntegrationFreshness.tsx")).toMatch(/\{slot && tools\}\s*<button type="button" className="glyph-btn ig-refresh"/);
  });

  it("never lets the header move the dialog", () => {
    const resizer = read("components/DialogResize.tsx");
    const modal = read("components/IntegrationModal.tsx");
    expect(modal).not.toMatch(/ig-head[^>]*onPointerDown/);
    expect(resizer).not.toContain("ig-head");
  });
});
