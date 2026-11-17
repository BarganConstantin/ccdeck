// The accounts header on one line (V4 top-10 #10), run rather than read.
//
// It was the title and five icons — ⓘ, +, ↗, ↻, × — which wrapped in the
// column's width. Now it is the title, + and ↻ (the act the panel is opened
// for, and the one control that shows a state while a reload is out), a ⋯
// "More actions" menu holding the share and the panel's video, and the close.
// These drive the real component (fake-react.ts has no DOM) and pin what is
// in the row, what is in the menu, the keys that open it, and where focus goes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

const { all, mount, one, textOf } = await import("./fake-react");
const { default: AccountsHeader } = await import("../components/AccountsHeader");
const { default: AnchoredPopover } = await import("../components/AnchoredPopover");
const { default: PanelInfo } = await import("../components/PanelInfo");
const { FILMS } = await import("../film-links");
import accountsEn from "../i18n/areas/accounts/en";

type El = import("./fake-react").Drawn;

const SHARE = accountsEn["accounts.header.share"];
let focused: string[] = [];
let frames: Array<() => void> = [];

beforeEach(() => {
  focused = [];
  frames = [];
  vi.stubGlobal("document", { getElementById: (id: string) => ({ focus: () => { focused.push(id); } }) });
  vi.stubGlobal("window", { requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; } });
});
afterEach(() => { vi.unstubAllGlobals(); });

function header(over: { canShare?: boolean; noSwap?: boolean; reloading?: boolean } = {}) {
  const calls = { add: 0, share: 0, reload: 0 };
  const view = mount(AccountsHeader, {
    canShare: over.canShare ?? true,
    onAdd: () => { calls.add++; },
    onShareSet: () => { calls.share++; },
    onReload: () => { calls.reload++; },
    pressProps: (_tag: string, working: boolean) => ({ disabled: false, "aria-busy": working || undefined }),
    reloading: over.reloading ?? false,
    noSwap: over.noSwap ?? false,
    closeButton: { type: "button", props: { className: "glyph-btn ap-close", "aria-label": "Close" } },
  } as never);
  return { view, calls };
}

const right = (tree: unknown) => one(tree, el => el.props.className === "ap-header-right")!;
/** The elements a list of children holds, with fragments opened. */
const flat = (n: unknown): El[] => {
  if (Array.isArray(n)) return n.flatMap(flat);
  if (!n || typeof n !== "object" || !("props" in n)) return [];
  const el = n as El;
  return typeof el.type === "symbol" ? flat(el.props.children) : [el];
};
/** What stands in the header's row, in order, by name. */
const row = (tree: unknown) => flat(right(tree).props.children).map(el =>
  el.type === AnchoredPopover ? "menu" : el.type === PanelInfo ? "panel-info" : String(el.props["aria-label"] ?? el.props.className));
const more = (tree: unknown) => one(tree, el => el.props["aria-haspopup"] === "menu")!;
const menu = (tree: unknown) => one(tree, el => el.type === AnchoredPopover);
const items = (tree: unknown) => all(menu(tree), el => el.props.role === "menuitem");

describe("the accounts header, on one line", () => {
  it("is +, ↻, ⋯ and the close: no ⓘ and no ↗ in the row", () => {
    const { view } = header();
    expect(row(view.tree)).toEqual(["Add an account", "Reload accounts", "More actions", "Close"]);
    expect(one(view.tree, el => el.type === PanelInfo)).toBeNull();
    expect(all(view.tree, el => el.props["aria-label"] === SHARE)).toEqual([]);
    expect(menu(view.tree)).toBeNull();
  });

  it("names the ⋯ as the rows' ⋯ is, says it opens a menu, and points at it only while it is open", () => {
    const { view } = header();
    const btn = more(view.tree);
    expect(btn.props["aria-label"]).toBe("More actions");
    expect(btn.props.title).toBe("More actions");
    expect(btn.props["aria-expanded"]).toBe(false);
    expect(btn.props["aria-controls"]).toBeUndefined();
    (btn.props.onClick as () => void)();
    const open = more(view.tree);
    expect(open.props["aria-expanded"]).toBe(true);
    expect(open.props["aria-controls"]).toBe(menu(view.tree)!.props.id);
  });

  it("holds the share and the video, with the words and titles they had, as the row menu's items", () => {
    const { view } = header();
    (more(view.tree).props.onClick as () => void)();
    const pop = menu(view.tree)!;
    // The row menu's own shape (AccountMenuPopover.tsx): the same popover, role and class.
    expect(pop.props.role).toBe("menu");
    expect(pop.props.className).toBe("ap-pop");
    expect(pop.props.anchorId).toBe(more(view.tree).props.id);
    expect(pop.props.labelledBy).toBe(more(view.tree).props.id);
    expect(pop.props.start).toBe("first");
    const [share, film] = items(view.tree);
    expect(items(view.tree)).toHaveLength(2);
    expect(share.props.className).toBe("ap-menu-item");
    expect(textOf(share)).toBe(SHARE);
    expect(share.props.title).toBe(accountsEn["accounts.header.shareTip"].replace("{product}", "ccdeck"));
    expect(film.type).toBe("a");
    expect(film.props.href).toBe(FILMS.claudeAccounts.href);
    expect(film.props.target).toBe("_blank");
    expect(textOf(film)).toMatch(/^Watch a 30 s video: the Claude accounts video on ccdeck\.dev, opens in your browser$/);
  });

  it("offers no share while there is nothing to share, as the ↗ did", () => {
    const { view } = header({ canShare: false });
    (more(view.tree).props.onClick as () => void)();
    expect(items(view.tree).map(el => el.type)).toEqual(["a"]);
  });

  it("opens at the first item on ArrowDown and at the last on ArrowUp, and leaves other keys alone", () => {
    for (const [key, start] of [["ArrowDown", "first"], ["ArrowUp", "last"]] as const) {
      const { view } = header();
      let prevented = false;
      (more(view.tree).props.onKeyDown as (e: unknown) => void)({ key, preventDefault: () => { prevented = true; } });
      expect(prevented, key).toBe(true);
      expect(menu(view.tree)!.props.start, key).toBe(start);
    }
    const { view } = header();
    let prevented = false;
    (more(view.tree).props.onKeyDown as (e: unknown) => void)({ key: "Enter", preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(false);
    expect(menu(view.tree)).toBeNull();
  });

  it("hands focus back to the ⋯ before an item acts, and closes", () => {
    const { view, calls } = header();
    (more(view.tree).props.onClick as () => void)();
    const id = more(view.tree).props.id as string;
    (items(view.tree)[0].props.onClick as () => void)();
    expect(focused).toEqual([id]);
    expect(calls.share).toBe(1);
    expect(menu(view.tree)).toBeNull();
  });

  it("closes on the popover's own close (Escape, a press outside, Tab out)", () => {
    const { view } = header();
    (more(view.tree).props.onClick as () => void)();
    (menu(view.tree)!.props.onClose as () => void)();
    expect(menu(view.tree)).toBeNull();
    expect(more(view.tree).props["aria-expanded"]).toBe(false);
  });

  it("closes the video item's menu only after the link has been followed", () => {
    const { view } = header();
    (more(view.tree).props.onClick as () => void)();
    (items(view.tree)[1].props.onClick as () => void)();
    expect(menu(view.tree)).not.toBeNull();
    frames.forEach(fn => fn());
    expect(menu(view.tree)).toBeNull();
  });

  it("keeps ↻ in the row, busy while its own reload is out", () => {
    const { view, calls } = header({ reloading: true });
    const reload = one(view.tree, el => el.props.className === "glyph-btn ap-refresh")!;
    expect(reload.props["aria-busy"]).toBe(true);
    (reload.props.onClick as () => void)();
    expect(calls.reload).toBe(1);
  });

  it("draws only the close while claude-swap is missing", () => {
    const { view } = header({ noSwap: true });
    expect(row(view.tree)).toEqual(["Close"]);
  });

  it("keeps the title from pushing the icons onto a second line", () => {
    const sheet = readFileSync(fileURLToPath(new URL("../styles/accounts-panel.css", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const h2 = /\.ap-header h2 \{([^}]*)\}/.exec(sheet)?.[1] ?? "";
    expect(h2).toContain("min-width: 0");
    expect(h2).toContain("text-overflow: ellipsis");
    expect(h2).toContain("white-space: nowrap");
    expect(/\.ap-header-right \{([^}]*)\}/.exec(sheet)?.[1]).toContain("flex: none");
  });
});
