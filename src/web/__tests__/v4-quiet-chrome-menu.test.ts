// V4 top-10 #5, the canvas bar's ⋯: the bar keeps − · level · + · ⌖ and one
// "More actions" button, whose menu holds, in order, Re-arrange (R), Pause or
// Resume (Space), Clear the deck… (C) | the Command Panel (while it is on) and
// the keyboard sheet (?) | the tool filter's checkboxes (while there are kinds
// of calls to filter). Each row shows its key while the single keys are on, and
// ⋯ carries a dot while calls on the board are hidden.
//
// Run, not read: the bar and its menu are drawn on fake-react.ts's React, the
// button pressed, and each row's own press called. React Flow's pieces are
// stubbed to what the bar reads of them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Drawn } from "./fake-react";

const keys = vi.hoisted(() => ({ on: true }));
vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("reactflow", () => ({
  Controls: function Controls({ children }: { children?: unknown }) { return children; },
  ControlButton: function ControlButton() { return null; },
  useStore: (select: (s: unknown) => unknown) => select({ transform: [0, 0, 0.6], minZoom: 0.1, maxZoom: 2 }),
}));
vi.mock("../use-single-key-shortcuts", () => ({ useSingleKeyShortcuts: () => keys.on }));

const { all, mount, one, textOf } = await import("./fake-react");
const { default: CanvasControls, CANVAS_MORE_ID } = await import("../components/CanvasControls");
const { en } = await import("../i18n/en");
type Cat = import("../detail-category").DetailCategory;

const named = (name: string) => (el: Drawn) => typeof el.type === "function" && (el.type as { name: string }).name === name;

/** The bar on a board with sessions, and its ⋯ mounted on its own. */
function bar(over: Record<string, unknown> = {}) {
  const spies = {
    handleRelayout: vi.fn(), togglePause: vi.fn(), requestClear: vi.fn(), setKeyHelpOpen: vi.fn(),
    onTerminal: vi.fn(), toggleCat: vi.fn(), enableAutoFitAndRefit: vi.fn(), zoomBy: vi.fn(), zoomReset: vi.fn(),
  };
  const props = { autoFitDisabled: false, paused: false, presentCats: ["file", "shell"] as Cat[], hiddenCats: new Set<Cat>(), ...spies, ...over };
  const outer = mount(CanvasControls as (p: typeof props) => unknown, props);
  const moreEl = one(outer.tree, named("CanvasMore"))!;
  const more = mount(moreEl.type as (p: unknown) => unknown, moreEl.props);
  const button = () => one(more.tree, el => el.props.id === CANVAS_MORE_ID)!;
  const menu = () => one(more.tree, named("AnchoredPopover"));
  return { outer, more, button, menu, spies };
}
/** What the open menu lists, in order: [words, key] per row, "—" per rule,
 *  "tool calls" for the filter's group. */
function listed(menu: Drawn) {
  return all(menu, el => named("MenuRow")(el) || el.props.role === "separator" || named("CategoryFilterBar")(el))
    .map(el => (named("MenuRow")(el) ? [el.props.label, el.props.keyCap ?? null] : el.props.role === "separator" ? "—" : "tool calls"));
}
const row = (menu: Drawn, label: string) => all(menu, named("MenuRow")).find(el => el.props.label === label)!;

const focused = vi.fn();
const anchor = { focus: focused };
beforeEach(() => {
  keys.on = true;
  focused.mockClear();
  vi.stubGlobal("document", { getElementById: (id: string) => (id === CANVAS_MORE_ID ? anchor : null), activeElement: null });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the bar", () => {
  it("keeps − · level · + · ⌖ and one ⋯, and nothing else", () => {
    const { outer } = bar();
    const buttons = all(outer.tree, named("ControlButton")).map(el => el.props["aria-label"]);
    expect(buttons).toEqual([en["board.controls.zoomOut"], en["board.controls.zoomIn"], en["board.controls.recenter"]]);
    expect(one(outer.tree, named("ZoomLevel"))).not.toBeNull();
    expect(one(outer.tree, named("CanvasMore"))).not.toBeNull();
    expect(all(outer.tree, el => el.props.className === "react-flow__controls-divider")).toHaveLength(1);
  });

  it("names ⋯ More actions, a menu button that is closed", () => {
    const b = bar().button();
    expect(b.props["aria-label"]).toBe(en["accounts.row.more"]);
    expect(b.props.title).toBe(en["accounts.row.more"]);
    expect(b.props["aria-haspopup"]).toBe("menu");
    expect(b.props["aria-expanded"]).toBe(false);
    expect(b.props["aria-controls"]).toBeUndefined();
    expect(one(b, el => el.props.className === "canvas-more-dot")).toBeNull();
  });
});

describe("the ⋯ menu", () => {
  it("lists its actions in order, each with its key, and the tool filter last", () => {
    const m = bar();
    (m.button().props.onClick as () => void)();
    expect(m.button().props["aria-expanded"]).toBe(true);
    expect(m.button().props["aria-controls"]).toBe("canvas-more-menu");
    const pop = m.menu()!;
    expect(pop.props.role).toBe("menu");
    expect(pop.props.labelledBy).toBe(CANVAS_MORE_ID);
    expect(pop.props.start).toBe("first");
    expect(listed(pop)).toEqual([
      [en["board.controls.arrangeLabel"], "R"],
      [en["board.quick.action.clear"], "C"],
      "—",
      [en["board.controls.openPanel"], null],
      [en["board.controls.keys"], "?"],
      "—",
      "tool calls",
    ]);
  });

  it("offers neither pause nor resume even with a stale paused flag", () => {
    const m = bar({ paused: true });
    expect(m.button().props["aria-label"]).toBe(en["accounts.row.more"]);
    (m.button().props.onClick as () => void)();
    expect(listed(m.menu()!)).not.toContainEqual([en["board.quick.action.resume"], "Space"]);
    expect(listed(m.menu()!)).not.toContainEqual([en["board.quick.action.pause"], "Space"]);
  });

  it("leaves out the Command Panel while it is off, and the filter while there is nothing to filter", () => {
    const m = bar({ onTerminal: undefined, presentCats: ["file"] });
    (m.button().props.onClick as () => void)();
    expect(listed(m.menu()!)).toEqual([
      [en["board.controls.arrangeLabel"], "R"],
      [en["board.quick.action.clear"], "C"],
      "—",
      [en["board.controls.keys"], "?"],
    ]);
  });

  it("opens at the last row on ArrowUp and the first on ArrowDown, from the keyboard", () => {
    const m = bar();
    const up = { key: "ArrowUp", preventDefault: vi.fn() };
    (m.button().props.onKeyDown as (e: unknown) => void)(up);
    expect(up.preventDefault).toHaveBeenCalled();
    expect(m.menu()!.props.start).toBe("last");
  });

  it("draws each row's key as a muted cap it names in aria-keyshortcuts, while the single keys are on", () => {
    const m = bar();
    (m.button().props.onClick as () => void)();
    const arrange = row(m.menu()!, en["board.controls.arrangeLabel"]);
    const drawn = mount(arrange.type as (p: unknown) => unknown, arrange.props).tree as Drawn;
    expect(drawn.props.role).toBe("menuitem");
    expect(drawn.props.className).toBe("ap-menu-item");
    expect(drawn.props["aria-keyshortcuts"]).toBe("R");
    const cap = one(drawn, el => el.props.className === "canvas-more-key")!;
    expect(cap.props["aria-hidden"]).toBe(true);
    expect(textOf(cap)).toBe("R");
    keys.on = false;
    const off = mount(arrange.type as (p: unknown) => unknown, arrange.props).tree as Drawn;
    expect(off.props["aria-keyshortcuts"]).toBeUndefined();
    expect(one(off, el => el.props.className === "canvas-more-key")).toBeNull();
    expect(textOf(off)).toBe(en["board.controls.arrangeLabel"]);
  });

  it("says why ? is quiet on the keyboard row while the single keys are off", () => {
    keys.on = false;
    const m = bar();
    (m.button().props.onClick as () => void)();
    expect(listed(m.menu()!)).toContainEqual([en["board.controls.keysOff"], "?"]);
  });

  it("runs the same commands the keys run, closing the menu and handing focus back to ⋯ first", () => {
    const m = bar();
    const pick = (label: string) => {
      (m.button().props.onClick as () => void)();
      (row(m.menu()!, label).props.onPick as () => void)();
      expect(m.menu(), label).toBeNull();
    };
    pick(en["board.controls.arrangeLabel"]);
    expect(m.spies.handleRelayout).toHaveBeenCalledTimes(1);
    expect(m.spies.togglePause).not.toHaveBeenCalled();
    pick(en["board.quick.action.clear"]);
    expect(m.spies.requestClear).toHaveBeenCalledWith("button");
    pick(en["board.controls.openPanel"]);
    expect(m.spies.onTerminal).toHaveBeenCalledWith(anchor);
    pick(en["board.controls.keys"]);
    const toggle = m.spies.setKeyHelpOpen.mock.calls[0][0] as (o: boolean) => boolean;
    expect(toggle(false)).toBe(true);
    expect(focused).toHaveBeenCalledTimes(4);
  });
});

describe("the tool filter in the ⋯ menu", () => {
  it("is one checkbox per kind on the board, a menuitemcheckbox, ticked while the kind shows", () => {
    const m = bar({ presentCats: ["file", "shell", "web"], hiddenCats: new Set<Cat>(["shell"]) });
    (m.button().props.onClick as () => void)();
    const groupEl = one(m.menu()!, named("CategoryFilterBar"))!;
    expect(groupEl.props.presentCats).toEqual(["file", "shell", "web"]);
    const group = mount(groupEl.type as (p: unknown) => unknown, groupEl.props).tree as Drawn;
    expect(group.props.role).toBe("group");
    expect(group.props["aria-labelledby"]).toBe(groupEl.props.headId);
    expect(textOf(one(group, el => el.props.className === "cat-tools-head"))).toBe(en["board.detail.toolCalls"]);
    const boxes = all(group, el => el.type === "input");
    expect(boxes.map(b => [b.props.role, b.props.checked])).toEqual([
      ["menuitemcheckbox", true], ["menuitemcheckbox", false], ["menuitemcheckbox", true],
    ]);
    // A hidden kind's dot goes hollow (the row's `off`), and Enter ticks as Space does.
    expect(all(group, el => typeof el.props.className === "string" && el.props.className.includes(" off")))
      .toHaveLength(1);
    (boxes[1].props.onChange as () => void)();
    expect(m.spies.toggleCat).toHaveBeenLastCalledWith("shell");
    const enter = { key: "Enter", preventDefault: vi.fn() };
    (boxes[0].props.onKeyDown as (e: unknown) => void)(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(m.spies.toggleCat).toHaveBeenLastCalledWith("file");
    // Show all, under a rule, while anything is hidden.
    const showAll = one(group, el => el.props.className === "ap-menu-item cat-tools-all")!;
    expect(showAll.props.role).toBe("menuitem");
    expect(textOf(showAll)).toBe(en["board.cat.showAll"]);
  });

  it("puts a dot on ⋯ and says so in its name while a kind on the board is hidden", () => {
    const b = bar({ hiddenCats: new Set<Cat>(["shell"]) }).button();
    expect(b.props["aria-label"]).toBe(en["board.controls.moreFiltered"]);
    expect(b.props.title).toBe(en["board.controls.moreFiltered"]);
    const dot = one(b, el => el.props.className === "canvas-more-dot")!;
    expect(dot.props["aria-hidden"]).toBe(true);
  });

  it("puts no dot on ⋯ for a hidden kind that has left the board, and keeps its way back in the menu", () => {
    const m = bar({ presentCats: ["file"], hiddenCats: new Set<Cat>(["shell"]) });
    expect(m.button().props["aria-label"]).toBe(en["accounts.row.more"]);
    expect(one(m.button(), el => el.props.className === "canvas-more-dot")).toBeNull();
    (m.button().props.onClick as () => void)();
    expect(listed(m.menu()!).at(-1)).toBe("tool calls");
  });
});
