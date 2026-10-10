// The phone's dock (EdgeRails.tsx), which stands in for both edge stripes and
// the topbar's two utilities under 641px.
//
// The eight panel toggles left the topbar for the window's edges (2026-10-08):
// a stripe down each side, one control-height wide. On a 390px phone two
// stripes would take 60px of the screen, so there the controls stand in one
// dock along the bottom, where a thumb is — the four panels and Settings a tap
// away, and the three rare dialogs (Usage history, Browser watch, Send
// feedback) behind a More, the same three the phone topbar's ⋯ folded before.
//
// These pin what the dock holds and in what order, that it is one toolbar
// (one Tab stop, the arrows inside), that More is a menu button that opens at
// either end, that the page keeps the dock's height free at its foot, and how
// an open panel is marked on the dock: the same line the stripes draw, on the
// edge it shares with the panel above it.
//
// Run, not read, where it is behaviour: EdgeDock and its More are drawn on
// fake-react.ts's React. The breakpoint, the room and the line are the sheet's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, mount, one, textOf, type Drawn } from "./fake-react";
import { cascade, el, mediaApplies, selects, sheetRules } from "./sheet-cascade";
import { sourceOf } from "./client-source";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
let singleKeys = true;
vi.mock("../use-single-key-shortcuts", () => ({ useSingleKeyShortcuts: () => singleKeys }));

const { EdgeDock, PHONE_QUERY } = await import("../components/EdgeRails");
const { default: AnchoredPopover } = await import("../components/AnchoredPopover");
const { railItems } = await import("../rail-items");

const noop = () => {};
const ref = () => ({ current: null });
const toggles = { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() };

/** The eight controls as App.tsx defines them, for a machine with or without
 *  Claude Code, a panel open or not, Browser watch's unread count. */
function rails({ claude = true, usageOpen = false, unread = 0, onHistory = noop } = {}) {
  return railItems({
    providers: { kind: "reported", claude, codex: true },
    sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
    usagePanelOpen: usageOpen, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
    setUsageHistoryOpen: onHistory, watchOn: false, watchUnseen: unread, setBrowserWatchOpen: noop,
    openSettings: noop, onFeedback: noop, toggles,
  } as unknown as Parameters<typeof railItems>[0]);
}

/** The dock exactly as App.tsx composes it from the rails. */
function dockFor(r: ReturnType<typeof rails>) {
  return mount(EdgeDock, { items: [...r.left, ...r.right[0], r.utilities[0]], more: [...r.right[1], r.utilities[1]] });
}

/** The control elements the dock draws: its RailButtons, then its More. */
const buttons = (tree: unknown) => all(tree, e => typeof e.type === "function" && "item" in e.props);
const moreOf = (tree: unknown) => one(tree, e => typeof e.type === "function" && "items" in e.props && "index" in e.props)!;

/** The More component on its own, run, with its button and (once open) its menu. */
function openMore(tree: unknown) {
  const more = moreOf(tree);
  const view = mount(more.type as (p: Record<string, unknown>) => unknown, more.props);
  const button = () => one(view.tree, e => e.type === "button" && e.props.id === "dock-more")!;
  const menu = () => one(view.tree, e => e.type === AnchoredPopover);
  return { view, button, menu };
}

let focused: string[] = [];
beforeEach(() => {
  focused = [];
  singleKeys = true;
  vi.stubGlobal("document", {
    getElementById: (id: string) => ({ focus: () => focused.push(id) }),
    activeElement: null,
    body: {},
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the dock holds the four panels and Settings, then More", () => {
  it("in the order the edges hold them: the left column's two, the right rail's two, then the gear", () => {
    const view = dockFor(rails());
    // The left stripe's order, Accounts first since 2026-10-08.
    expect(buttons(view.tree).map(b => (b.props.item as { id: string }).id))
      .toEqual(["accounts", "session-list", "usage", "machine", "settings"]);
    expect((moreOf(view.tree).props.items as { id: string }[]).map(i => i.id))
      .toEqual(["history", "browser-watch", "feedback"]);
  });

  it("drops Accounts on a machine without Claude Code, and keeps the rest in place", () => {
    // Every account the panel lists is a Claude account; a Codex-only machine
    // gets no control for a panel with nothing in it.
    const view = dockFor(rails({ claude: false }));
    expect(buttons(view.tree).map(b => (b.props.item as { id: string }).id))
      .toEqual(["session-list", "usage", "machine", "settings"]);
  });

  it("is what App.tsx draws at a phone's width, in place of both stripes and the topbar's utilities", () => {
    const app = sourceOf("App.tsx");
    expect(app).toContain("const phone = useMediaQuery(PHONE_QUERY);");
    expect(app).toMatch(/\{phone\s*\?\s*<EdgeDock items=\{\[\.\.\.rails\.left, \.\.\.rails\.right\[0\], rails\.utilities\[0\]\]\} more=\{\[\.\.\.rails\.right\[1\], rails\.utilities\[1\]\]\} \/>\s*:\s*<EdgeRail side="left"/);
    expect(app).toMatch(/\{!phone && <EdgeRail side="right"/);
    expect(app).toMatch(/\{!phone && <div className="actions"><UtilityRun items=\{rails\.utilities\} \/><\/div>\}/);
  });

  it("swaps at the sheet's own narrow breakpoint, so the dock is drawn exactly where it is mounted", () => {
    // The query React mounts the dock by and the block the sheet draws it in
    // are one width: a window between the two would have a dock with no
    // styles, or stripes with no controls.
    expect(PHONE_QUERY).toBe("(max-width: 640px)");
    const dock = [el("div", ["edge-dock"])];
    const display = (w: number) => cascade(s => selects(s, dock), "display", w);
    expect(display(640)).toBe("flex");
    expect(display(320)).toBe("flex");
    expect(display(641)).toBe("none");
    expect(display(1440)).toBe("none");
  });
});

describe("the dock is one toolbar", () => {
  it("is a toolbar named for what it holds, horizontal, with one Tab stop", () => {
    const view = dockFor(rails());
    const root = view.tree as Drawn;
    expect(root.props.role).toBe("toolbar");
    expect(root.props["aria-label"]).toBe("Panels and tools");
    expect(root.props["aria-orientation"] ?? "horizontal").toBe("horizontal");
    expect(typeof root.props.onKeyDown).toBe("function");
    expect(buttons(view.tree).map(b => b.props.tabbable)).toEqual([true, false, false, false, false]);
    expect(moreOf(view.tree).props.tabbable).toBe(false);
  });

  it("draws the short word under each glyph, where a column is a sixth of a phone", () => {
    const view = dockFor(rails());
    expect(buttons(view.tree).map(b => b.props.variant)).toEqual(["dock", "dock", "dock", "dock", "dock"]);
    expect(buttons(view.tree).map(b => (b.props.item as { short: string }).short))
      .toEqual(["Accounts", "Sessions", "Usage", "Machine", "Settings"]);
  });

  it("gives every control a thumb's target on the narrowest phone", () => {
    // Six columns share the dock's width less its 2px sides, each 48px tall:
    // at 320px that is 52px a column, over the 44px a touch target wants and
    // well over 2.5.8's 24.
    const dockBtn = [el("div", ["edge-dock"]), el("button", ["rail-btn", "rail-btn-dock"])];
    expect(cascade(s => selects(s, dockBtn), "height", 320)).toBe("48px");
    expect(cascade(s => selects(s, dockBtn), "flex", 320)).toBe("1 1 0");
    const pad = cascade(s => selects(s, [el("div", ["edge-dock"])]), "padding", 320)!.split(/\s+/);
    expect((320 - 2 * parseFloat(pad[1])) / 6).toBeGreaterThanOrEqual(44);
  });
});

describe("More is a menu button for the three rare dialogs", () => {
  it("says what it holds, and is a closed menu button until pressed", () => {
    const { button, menu } = openMore(dockFor(rails()).tree);
    expect(button().props["aria-haspopup"]).toBe("menu");
    expect(button().props["aria-expanded"]).toBe(false);
    expect(button().props["aria-controls"]).toBeUndefined();
    expect(button().props["aria-label"]).toBe("More: Usage history, Browser watch, not watching, Send feedback");
    expect(menu()).toBeNull();
  });

  it("opens a menu of the three by their whole names, focus on the first", () => {
    const { button, menu } = openMore(dockFor(rails()).tree);
    (button().props.onClick as () => void)();
    expect(button().props["aria-expanded"]).toBe(true);
    expect(button().props["aria-controls"]).toBe("dock-more-menu");
    expect(menu()!.props.role).toBe("menu");
    expect(menu()!.props.start).toBe("first");
    const rows = all(menu(), e => e.props.role === "menuitem");
    expect(rows.map(r => textOf(r))).toEqual(["Usage history", "Browser watch", "Send feedback"]);
  });

  it("opens at either end from the keyboard, the way a native menu button does", () => {
    for (const [key, start] of [["ArrowDown", "first"], ["ArrowUp", "last"]] as const) {
      const { button, menu } = openMore(dockFor(rails()).tree);
      (button().props.onKeyDown as (e: unknown) => void)({ key, preventDefault: noop });
      expect(menu()!.props.start, key).toBe(start);
    }
  });

  it("carries Browser watch's unread count, in the chrome's grey, while the row it stands for is folded", () => {
    const { button, menu } = openMore(dockFor(rails({ unread: 2 })).tree);
    expect(button().props["aria-label"]).toBe("More: Usage history, Browser watch, not watching, 2 unread, Send feedback");
    expect(textOf(one(button(), e => e.props.className === "rail-badge"))).toBe("2");
    (button().props.onClick as () => void)();
    expect(all(menu(), e => e.props.role === "menuitem").map(r => textOf(r))[1]).toBe("Browser watch · 2 unread");
  });

  it("hands focus back to More before the dialog opens, so the dialog gives it back there", () => {
    const opened: string[] = [];
    const { button, menu } = openMore(dockFor(rails({ onHistory: () => { opened.push(`history after ${focused.join(",")}`); } })).tree);
    (button().props.onClick as () => void)();
    const first = all(menu(), e => e.props.role === "menuitem")[0];
    (first.props.onClick as () => void)();
    expect(opened).toEqual(["history after dock-more"]);
    expect(menu()).toBeNull();
  });
});

describe("the page around the dock", () => {
  const narrow = sheetRules().filter(r => r.media != null && mediaApplies(r.media, 390) && !mediaApplies(r.media, 641));
  const decl = (selector: string, prop: string) => {
    let out: string | null = null;
    for (const r of narrow) {
      if (!r.selectors.includes(selector)) continue;
      const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(r.body);
      if (m) out = m[1].trim();
    }
    return out;
  };

  it("keeps the dock's height free at the foot of the page, safe area and all", () => {
    // The dock is fixed, outside the grid; the page's own padding is what
    // stops the canvas's controls and the left column ending under it.
    const dockHeight = decl(".edge-dock", "height");
    expect(dockHeight).toBe("calc(var(--dock-h) + env(safe-area-inset-bottom))");
    expect(decl(".app", "padding-bottom")).toBe(dockHeight);
    expect(cascade(s => selects(s, [el("html", [], { states: ["root"] })]), "--dock-h", 390)).toBe("56px");
  });

  it("gives the stripes' width back to the page, which has no stripes there", () => {
    const root = [el("html", [], { states: ["root"] })];
    expect(cascade(s => selects(s, root), "--edge-w", 390)).toBe("0px");
    expect(cascade(s => selects(s, root), "--edge-w", 641)).toBe("40px");
  });

  it("marks an open panel with the stripes' line, on the dock's top edge, in the foreground and not the accent", () => {
    // The line sits on the seam the dock shares with the panel above it: its
    // top is the dock's own top padding and edge, above the button.
    const btn = [el("div", ["edge-dock"]), el("button", ["rail-btn", "rail-btn-dock"])];
    const open = [el("div", ["edge-dock"]), el("button", ["rail-btn", "rail-btn-dock"], { attrs: { "aria-expanded": "true" } })];
    const before = (chain: typeof btn, prop: string) => cascade(s => {
      const m = /::before$/.exec(s);
      return m ? selects(s.slice(0, m.index), chain) : null;
    }, prop, 390);
    const pad = cascade(s => selects(s, [el("div", ["edge-dock"])]), "padding", 390)!.split(/\s+/);
    const edge = parseFloat(cascade(s => selects(s, [el("div", ["edge-dock"])]), "border-top", 390)!);
    expect(before(btn, "top")).toBe(`-${parseFloat(pad[0]) + edge}px`);
    expect(before(btn, "height")).toBe("2px");
    expect(before(btn, "background")).toBe("var(--text)");
    expect(before(btn, "opacity")).toBe("0");
    expect(before(open, "opacity")).toBe("1");
  });

  it("says an open panel to assistive tech as the disclosure it is, not a tab", () => {
    const view = dockFor(rails({ usageOpen: true }));
    const usage = buttons(view.tree).find(b => (b.props.item as { id: string }).id === "usage")!;
    const drawn = mount(usage.type as (p: Record<string, unknown>) => unknown, usage.props);
    const button = one(drawn.tree, e => e.type === "button")!;
    expect(button.props["aria-expanded"]).toBe(true);
    expect(button.props["aria-controls"]).toBe("usage-panel");
    expect(button.props.role).toBeUndefined();
    expect(button.props["aria-selected"]).toBeUndefined();
  });
});
