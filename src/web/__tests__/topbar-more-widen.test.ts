// A menu or a focused control on the phone's chrome lost the keyboard when the
// window grew past a phone's width.
//
// It began with the topbar's ⋯. Under 480px History, Browser watch and
// Feedback folded into it, and above that the sheet hid the ⋯ and drew the
// three again. A menu open across that line was placed against a button that
// was no longer drawn: AnchoredPopover follows its anchor on every resize, a
// hidden element's box is all zeros, and the menu went to the window's corner,
// open and holding focus, under a button nobody could see. So a popover whose
// anchor stops being drawn closes, the way one whose anchor is gone already
// did, and focus inside it goes where the caller says. That half is the
// popover's own and still holds for every popover the deck hangs off a
// control (the first describe below).
//
// The ⋯ is gone since the panel toggles left the topbar (2026-10-08). Under
// 641px every control stands in the dock along the bottom (EdgeRails.tsx), the
// three rare dialogs behind its More, and above it the stripes on the window's
// edges and the topbar's two utilities. React swaps the two whole at the
// breakpoint rather than the sheet hiding one, so the control the keyboard was
// on is taken out of the page, and nothing that unmounts can hand focus on.
// The surface that mounts takes it instead: useFocusHandover remembers the
// control focus was on, by its rail id, and puts focus on the same control on
// the other side of the swap — the old fallback's guarantee, "the button the
// focused item stands for", kept across a remount.
//
// Run, not read: AnchoredPopover, EdgeDock, EdgeRail and UtilityRun are drawn
// on fake-react.ts's React, against a window whose resize the test fires and a
// document whose elements the test lays out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, mount, one, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
// Escape, the Tab trap and the stack are the hook's, and not what is asked
// here: a ref for the surface is all the popover takes from it.
vi.mock("../components/use-modal-dismiss", async () => {
  const { react } = await import("./fake-react");
  return { useModalDismiss: () => react.useRef(null) };
});
vi.mock("../components/use-outside-press", () => ({ useOutsidePress: () => {} }));

let singleKeys = true;
vi.mock("../use-single-key-shortcuts", () => ({ useSingleKeyShortcuts: () => singleKeys }));

const { default: AnchoredPopover } = await import("../components/AnchoredPopover");
const { EdgeDock, EdgeRail, UtilityRun } = await import("../components/EdgeRails");
const { railItems } = await import("../rail-items");

type Box = { top: number; right: number; bottom: number; left: number; width: number; height: number };
const NONE: Box = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };

/** An element of the page: its box while drawn, and focus. */
interface Fake {
  id?: string;
  drawn: boolean;
  box: Box;
  focus: (o?: unknown) => void;
  getBoundingClientRect: () => Box;
  getClientRects: () => Box[];
}
let page: { activeElement: unknown; body: object; getElementById: (id: string) => unknown; querySelectorAll: (s: string) => unknown[] };
const listeners = new Map<string, Set<(e?: unknown) => void>>();

function fake(id: string, box: Box): Fake {
  const f: Fake = {
    id, drawn: true, box,
    focus: () => { page.activeElement = f; },
    getBoundingClientRect: () => (f.drawn ? f.box : NONE),
    getClientRects: () => (f.drawn ? [f.box] : []),
  };
  return f;
}

/** A menu button near the right end of a 420px window, the dock's More. */
let more: Fake;
/** The controls its items stand for, as the wider window draws them. */
let folded: Fake[];
/** The menu's three items, once it is drawn. */
let items: Fake[];
/** The popover's own surface: its size, and where `place` put it. */
let surface: { style: Record<string, string>; dataset: Record<string, string>; offsetWidth: number; offsetHeight: number; contains: (n: unknown) => boolean; querySelectorAll: () => unknown[] };

beforeEach(() => {
  listeners.clear();
  more = fake("dock-more", { top: 11, bottom: 41, left: 380, right: 410, width: 30, height: 30 });
  folded = ["history", "watch", "feedback"].map((n, i) => {
    const f = fake(n, { top: 11, bottom: 41, left: 300 + i * 40, right: 330 + i * 40, width: 30, height: 30 });
    f.drawn = false;
    return f;
  });
  items = ["Usage history", "Browser watch", "Send feedback"].map(n => fake(n, NONE));
  surface = {
    style: {}, dataset: {}, offsetWidth: 200, offsetHeight: 110,
    contains: n => items.includes(n as Fake),
    querySelectorAll: () => items,
  };
  page = {
    activeElement: null,
    body: {},
    getElementById: id => (id === "dock-more" ? more : id === "dock-more-menu" ? surface : null),
    querySelectorAll: () => [],
  };
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", {
    innerWidth: 420, innerHeight: 800,
    // The hint's timers, which the chrome's surfaces clear as they unmount.
    setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: (t: string, f: (e?: unknown) => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
    removeEventListener: (t: string, f: (e?: unknown) => void) => { listeners.get(t)?.delete(f); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Attaches the popover's ref to its surface, as React would before effects. */
function attach(tree: unknown) {
  const pop = tree && typeof tree === "object" && "ref" in tree ? (tree as Drawn).ref : null;
  if (pop && typeof pop === "object") (pop as { current: unknown }).current = surface;
}

/** The window grows past a phone's width: the menu's button stops being
 *  drawn, and the controls its items stand for are drawn instead. */
function widen() {
  (window as unknown as { innerWidth: number }).innerWidth = 700;
  more.drawn = false;
  for (const f of folded) f.drawn = true;
  for (const f of listeners.get("resize") ?? []) f();
}

function openMenu(fallbackFocus?: () => unknown) {
  const onClose = vi.fn();
  mount(AnchoredPopover as (p: Record<string, unknown>) => unknown, {
    anchorId: "dock-more", id: "dock-more-menu", role: "menu", labelledBy: "dock-more", onClose, fallbackFocus, children: null,
  }, { commit: attach });
  return onClose;
}

describe("a popover whose anchor stops being drawn", () => {
  it("is placed beside its anchor while the anchor is drawn", () => {
    openMenu();
    expect(Number.parseFloat(surface.style.top)).toBeGreaterThanOrEqual(41);
    expect(Number.parseFloat(surface.style.left)).toBeGreaterThan(150);
  });

  it("closes rather than going to the window's corner", () => {
    const onClose = openMenu();
    const at = { ...surface.style };
    widen();
    // Not moved: it was placed at the anchor and left there for its last frame.
    expect(surface.style).toEqual(at);
    expect(onClose).toHaveBeenCalled();
  });

  it("hands focus where its caller says when the focus was inside it", () => {
    const onClose = openMenu(() => folded[1]);
    items[1].focus();
    widen();
    expect(onClose).toHaveBeenCalled();
    expect(page.activeElement).toBe(folded[1]);
  });

  it("leaves focus alone when it was somewhere else", () => {
    const elsewhere = fake("canvas", NONE);
    openMenu(() => folded[0]);
    elsewhere.focus();
    widen();
    expect(page.activeElement).toBe(elsewhere);
  });
});

// ── the swap at 640px ──────────────────────────────────────────────────────

const noop = () => {};
const ref = () => ({ current: null });
const toggles = { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() };
const rails = () => railItems({
  providers: { kind: "reported", claude: true, codex: true },
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
  openSettings: noop, onFeedback: noop, toggles,
} as unknown as Parameters<typeof railItems>[0]);

/** A surface's root element: the controls it holds, by rail id, and the focus
 *  events the document would deliver to it. */
function surfaceOf(ids: string[]) {
  const on = new Map<string, (e: unknown) => void>();
  const controls = new Map(ids.map(id => [id, fake(id, NONE)]));
  return {
    controls,
    addEventListener: (t: string, f: (e: unknown) => void) => { on.set(t, f); },
    removeEventListener: (t: string) => { on.delete(t); },
    querySelector: (sel: string) => controls.get(/data-rail-item="([\w-]+)"/.exec(sel)?.[1] ?? "") ?? null,
    contains: (n: unknown) => [...controls.values()].includes(n as Fake),
    /** Focus lands on one of its controls. */
    focusIn: (id: string) => { const c = controls.get(id)!; c.focus(); on.get("focusin")?.({ target: { dataset: { railItem: id } } }); },
    /** Focus leaves it for `to`. */
    focusOut: (to: unknown) => on.get("focusout")?.({ relatedTarget: to }),
  };
}

/** Mounts a surface with its root attached to `root`, as React would before effects. */
function draw<P>(component: (p: P) => unknown, props: P, root: object) {
  return mount(component, props, {
    commit: tree => {
      const r = tree && typeof tree === "object" && "ref" in tree ? (tree as Drawn).ref : null;
      if (r && typeof r === "object") (r as { current: unknown }).current = root;
    },
  });
}

const DOCK_IDS = ["session-list", "accounts", "usage", "machine", "settings", "more"];
const dockProps = () => { const r = rails(); return { items: [...r.left, ...r.right[0], r.utilities[0]], more: [...r.right[1], r.utilities[1]] }; };

describe("the chrome when the window crosses a phone's width", () => {
  it("puts focus on the same control on the other side of the swap", () => {
    // The dock's Usage had focus; the window widens; the dock is unmounted and
    // focus falls to <body>. The right stripe mounts with its own Usage, and
    // takes it.
    const dock = surfaceOf(DOCK_IDS);
    const shown = draw(EdgeDock, dockProps(), dock);
    dock.focusIn("usage");
    shown.unmount();
    page.activeElement = page.body;
    const stripe = surfaceOf(["usage", "machine", "history", "browser-watch"]);
    draw(EdgeRail, { side: "right" as const, label: "Right panels", groups: rails().right }, stripe);
    expect(page.activeElement).toBe(stripe.controls.get("usage"));
  });

  it("does the same the other way, from a stripe or the topbar's utilities into the dock", () => {
    const utilities = surfaceOf(["settings", "feedback"]);
    const shown = draw(UtilityRun, { items: rails().utilities }, utilities);
    utilities.focusIn("settings");
    shown.unmount();
    page.activeElement = page.body;
    const dock = surfaceOf(DOCK_IDS);
    draw(EdgeDock, dockProps(), dock);
    expect(page.activeElement).toBe(dock.controls.get("settings"));
  });

  it("hands over nothing once focus has left the chrome for somewhere else", () => {
    const dock = surfaceOf(DOCK_IDS);
    const shown = draw(EdgeDock, dockProps(), dock);
    dock.focusIn("machine");
    const canvas = fake("canvas", NONE);
    dock.focusOut(canvas);
    canvas.focus();
    shown.unmount();
    page.activeElement = page.body;
    const stripe = surfaceOf(["usage", "machine", "history", "browser-watch"]);
    draw(EdgeRail, { side: "right" as const, label: "Right panels", groups: rails().right }, stripe);
    expect(page.activeElement).toBe(page.body);
  });

  it("never takes focus from where the reader already is", () => {
    const dock = surfaceOf(DOCK_IDS);
    const shown = draw(EdgeDock, dockProps(), dock);
    dock.focusIn("usage");
    shown.unmount();
    const elsewhere = fake("search", NONE);
    page.activeElement = elsewhere;
    const stripe = surfaceOf(["usage", "machine", "history", "browser-watch"]);
    draw(EdgeRail, { side: "right" as const, label: "Right panels", groups: rails().right }, stripe);
    expect(page.activeElement).toBe(elsewhere);
  });

  it("gives focus in More's open menu to the control the focused row stands for", () => {
    // The ⋯'s own guarantee, carried over: a reader on "Browser watch" in the
    // menu when the window widens lands on Browser watch on the right stripe,
    // not on <body>. The menu is portalled out of the dock, so its rows have
    // to say which control they stand for themselves.
    const dock = surfaceOf(DOCK_IDS);
    const shown = draw(EdgeDock, dockProps(), dock);
    const more = one(shown.tree, e => typeof e.type === "function" && "items" in e.props && "index" in e.props)!;
    const menuView = mount(more.type as (p: Record<string, unknown>) => unknown, more.props);
    (one(menuView.tree, e => e.type === "button" && e.props.id === "dock-more")!.props.onClick as () => void)();
    const rows = all(menuView.tree, e => e.props.role === "menuitem");
    const watch = rows[1];
    expect(watch.props["data-rail-item"], "the row says which control it stands for").toBe("browser-watch");
    (watch.props.onFocus as ((e: unknown) => void) | undefined)?.({ target: { dataset: { railItem: "browser-watch" } } });
    menuView.unmount();
    shown.unmount();
    page.activeElement = page.body;
    const stripe = surfaceOf(["usage", "machine", "history", "browser-watch"]);
    draw(EdgeRail, { side: "right" as const, label: "Right panels", groups: rails().right }, stripe);
    expect(page.activeElement).toBe(stripe.controls.get("browser-watch"));
  });
});
