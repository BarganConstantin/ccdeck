// V4 top-10 #6, pressed: the Inspector's Details row remembers being opened,
// and the title block's ⋯ opens a menu holding Export JSON and Remove from
// board that answers its keys and Escape. The components run on fake-react, so
// a press is a call of the handler the component drew and the state it sets
// draws again; the menu's Escape goes the way App's one Escape listener sends
// it, through the dismiss stack AnchoredPopover registers on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, one, all, textOf, type Drawn } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { DetailMore, DetailActions } = await import("../components/Detail");
const { default: AnchoredPopover } = await import("../components/AnchoredPopover");
const { modalStack } = await import("../modal-dismiss");
const { INSPECTOR_DETAILS_KEY } = await import("../inspector-tab");
import type { AgentNodeData } from "../types";

const AGENT = { id: "s", sessionId: "sess-1", label: "api", kind: "root", state: "done" } as unknown as AgentNodeData;

let stored: Record<string, string>;
let anchor: { focus: ReturnType<typeof vi.fn>; getClientRects: () => unknown[] };
beforeEach(() => {
  stored = {};
  anchor = { focus: vi.fn(), getClientRects: () => [{}] };
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; } },
    requestAnimationFrame: (run: () => void) => { run(); return 1; },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("document", { getElementById: () => anchor, activeElement: null, body: { nodeType: 1 } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Details", () => {
  const details = (tree: unknown) => one(tree, e => e.type === "details")!;
  const toggle = (tree: unknown, open: boolean) =>
    (details(tree).props.onToggle as (e: unknown) => void)({ currentTarget: { open } });

  it("is shut by default, and holds what it was given", () => {
    const view = mount(DetailMore, { calls: 0, children: "the record" });
    expect(details(view.tree).props.open).toBe(false);
    expect(details(view.tree).props.className).toBe("detail-more");
    expect(textOf(one(view.tree, e => e.props?.className === "detail-more-body"))).toBe("the record");
    expect(stored[INSPECTOR_DETAILS_KEY]).toBeUndefined();
    view.unmount();
  });

  it("remembers being opened, for the next session selected and the next load", () => {
    const first = mount(DetailMore, { calls: 3, children: null });
    toggle(first.tree, true);
    expect(details(first.tree).props.open).toBe(true);
    expect(stored[INSPECTOR_DETAILS_KEY]).toBe("1");
    first.unmount();
    // A fresh mount — another session's panel, or a reload — reads it back.
    const again = mount(DetailMore, { calls: 3, children: null });
    expect(details(again.tree).props.open).toBe(true);
    toggle(again.tree, false);
    expect(details(again.tree).props.open).toBe(false);
    expect(stored[INSPECTOR_DETAILS_KEY]).toBe("0");
    again.unmount();
    expect(details(mount(DetailMore, { calls: 3, children: null }).tree).props.open).toBe(false);
  });

  it("writes nothing for the toggle a details drawn open fires as it mounts", () => {
    stored[INSPECTOR_DETAILS_KEY] = "1";
    const writes = vi.spyOn(window.localStorage, "setItem");
    const view = mount(DetailMore, { calls: 0, children: null });
    toggle(view.tree, true);
    expect(writes).not.toHaveBeenCalled();
    view.unmount();
  });

  it("costs only the memory when the store refuses", () => {
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("SecurityError"); } });
    const view = mount(DetailMore, { calls: 0, children: null });
    expect(details(view.tree).props.open).toBe(false);
    expect(() => toggle(view.tree, true)).not.toThrow();
    expect(details(view.tree).props.open).toBe(true);
    view.unmount();
  });
});

describe("the ⋯ menu", () => {
  const props = () => ({ agent: AGENT, onExportSession: vi.fn(), onRemove: vi.fn(), singleKeys: true });
  const more = (tree: unknown) => one(tree, e => e.type === "button" && String(e.props.className).includes("hero-more"))!;
  const menu = (tree: unknown) => one(tree, e => e.type === AnchoredPopover);
  const items = (tree: unknown) => all(tree, e => e.props?.role === "menuitem");
  const press = (el: Drawn) => (el.props.onClick as () => void)();

  it("is a quiet icon button named More actions, shut until pressed", () => {
    const view = mount(DetailActions, props());
    const button = more(view.tree);
    expect(button.props["aria-label"]).toBe("More actions");
    expect(button.props.title).toBe("More actions");
    expect(button.props["aria-haspopup"]).toBe("menu");
    expect(button.props["aria-expanded"]).toBe(false);
    expect(button.props["aria-controls"]).toBeUndefined();
    expect(button.props.className).toBe("glyph-btn hero-more");
    expect(menu(view.tree)).toBeNull();
    view.unmount();
  });

  it("opens a menu off itself holding Export JSON and Remove from board, with their titles", () => {
    const view = mount(DetailActions, props());
    press(more(view.tree));
    const button = more(view.tree);
    expect(button.props["aria-expanded"]).toBe(true);
    const pop = menu(view.tree)!;
    expect(pop.props.role).toBe("menu");
    expect(pop.props.anchorId).toBe(button.props.id);
    expect(pop.props.labelledBy).toBe(button.props.id);
    expect(button.props["aria-controls"]).toBe(pop.props.id);
    expect(pop.props.start).toBe("first");
    expect(items(view.tree).map(textOf)).toEqual(["Export JSON", "Remove from board"]);
    const [exp, rem] = items(view.tree);
    expect(exp.props.title).toBe("Download this session as JSON");
    expect(String(rem.props.title)).toMatch(/^Take this session's cards off the board \(Delete\)\. The session carries on; /);
    // Not a danger item: the session list brings a removed session back.
    for (const item of items(view.tree)) expect(item.props.className).toBe("ap-menu-item");
    view.unmount();
  });

  it("runs Export for this session and Remove, each after handing focus back to the ⋯ and shutting", () => {
    const p = props();
    const view = mount(DetailActions, p);
    press(more(view.tree));
    press(items(view.tree)[0]);
    expect(p.onExportSession).toHaveBeenCalledWith("sess-1");
    expect(anchor.focus).toHaveBeenCalledTimes(1);
    expect(menu(view.tree)).toBeNull();
    expect(more(view.tree).props["aria-expanded"]).toBe(false);
    press(more(view.tree));
    press(items(view.tree)[1]);
    expect(p.onRemove).toHaveBeenCalledTimes(1);
    expect(menu(view.tree)).toBeNull();
    view.unmount();
  });

  it("opens at the last item on ArrowUp and the first on ArrowDown, and a second press shuts it", () => {
    const view = mount(DetailActions, props());
    const key = (k: string) => {
      const e = { key: k, preventDefault: vi.fn() };
      (more(view.tree).props.onKeyDown as (e: unknown) => void)(e);
      return e;
    };
    expect(key("ArrowUp").preventDefault).toHaveBeenCalled();
    expect(menu(view.tree)!.props.start).toBe("last");
    press(more(view.tree));
    expect(menu(view.tree)).toBeNull();
    key("ArrowDown");
    expect(menu(view.tree)!.props.start).toBe("first");
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
    view.unmount();
  });

  it("shuts on Escape and hands focus back to the ⋯", () => {
    const view = mount(DetailActions, props());
    press(more(view.tree));
    const pop = menu(view.tree)!;
    // The popover as the page draws it: it registers on the dismiss stack, and
    // App's Escape (use-deck-shortcuts.ts) dismisses the top of that stack.
    const depth = modalStack.depth();
    const drawn = mount(AnchoredPopover as (p: typeof pop.props) => unknown, pop.props);
    expect(modalStack.depth()).toBe(depth + 1);
    expect(modalStack.dismissTop()).toBe(true);
    expect(anchor.focus).toHaveBeenCalled();
    expect(menu(view.tree)).toBeNull();
    expect(more(view.tree).props["aria-expanded"]).toBe(false);
    drawn.unmount();
    expect(modalStack.depth()).toBe(depth);
    view.unmount();
  });

  it("offers only what it was given", () => {
    const view = mount(DetailActions, { ...props(), onRemove: undefined });
    press(more(view.tree));
    expect(items(view.tree).map(textOf)).toEqual(["Export JSON"]);
    view.unmount();
  });
});
