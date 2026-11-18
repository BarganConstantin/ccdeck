// A panel header's ⓘ and its menu (critique 3, one meaning per glyph): the
// panel's video is behind it, in words that say what a press does and how long
// the film is, as the same plain link out the old ▷ was.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, one, textOf } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { default: PanelInfo } = await import("../components/PanelInfo");
const { default: AnchoredPopover } = await import("../components/AnchoredPopover");
const { FILMS } = await import("../film-links");

beforeEach(() => {
  vi.stubGlobal("window", { requestAnimationFrame: (run: () => void) => { run(); return 1; } });
  vi.stubGlobal("document", { getElementById: () => null });
});
afterEach(() => vi.unstubAllGlobals());

const info = (tree: unknown) => one(tree, e => e.type === "button" && String(e.props.className).includes("panel-info"))!;
const menu = (tree: unknown) => one(tree, e => e.type === AnchoredPopover);
const item = (tree: unknown) => one(tree, e => e.props?.role === "menuitem");

it("is an ⓘ named for its panel that opens a menu, shut until pressed", () => {
  const view = mount(PanelInfo, { film: "usage", panel: "Usage" });
  const button = info(view.tree);
  expect(button.props["aria-label"]).toBe("About Usage");
  expect(button.props["aria-haspopup"]).toBe("menu");
  expect(button.props["aria-expanded"]).toBe(false);
  expect(menu(view.tree)).toBeNull();
  view.unmount();
});

it("holds the video, said with its length, as a link out to its page", () => {
  const view = mount(PanelInfo, { film: "usage", panel: "Usage" });
  (info(view.tree).props.onClick as () => void)();
  expect(info(view.tree).props["aria-expanded"]).toBe(true);
  expect(menu(view.tree)?.props.role).toBe("menu");
  const link = item(view.tree)!;
  expect(link.type).toBe("a");
  expect(link.props.href).toBe(FILMS.usage.href);
  expect(link.props.target).toBe("_blank");
  expect(link.props.rel).toBe("noopener noreferrer");
  // The words a reader sees, then where it goes for a screen reader.
  expect(textOf(link)).toBe("Watch a 30 s video: the cost and quota video on ccdeck.dev, opens in your browser");
  view.unmount();
});

it("closes once the link has been followed, and the arrows open it at either end", () => {
  const view = mount(PanelInfo, { film: "claudeAccounts", panel: "Claude accounts" });
  (info(view.tree).props.onClick as () => void)();
  (item(view.tree)!.props.onClick as () => void)();
  expect(menu(view.tree)).toBeNull();
  const press = (key: string) => (info(view.tree).props.onKeyDown as (e: unknown) => void)({ key, preventDefault() {} });
  press("ArrowUp");
  expect(menu(view.tree)?.props.start).toBe("last");
  (menu(view.tree)!.props.onClose as () => void)();
  press("ArrowDown");
  expect(menu(view.tree)?.props.start).toBe("first");
  expect(item(view.tree)!.props.href).toBe(FILMS.claudeAccounts.href);
  view.unmount();
});
