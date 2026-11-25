// A Workspace pane's tab menu closes tabs as well as showing them
// (PaneTabs.tsx). Each row shows its tab, and the × after it closes that tab
// without showing it first, through the strip's own close: the same lifecycle
// as Delete on a tab or the header's ✕. Row and × are two items of the menu
// side by side, never one inside the other; Up and Down walk the rows, Right
// reaches a row's ×, Left comes back, a bare Delete on either closes the row's
// tab, and the keyboard lands on the next row (the one before, from the last).
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceOf } from "./client-source";

// The portal cannot be server-rendered; the menu's own markup is what is read.
vi.mock("../components/AnchoredPopover", () => ({
  default: ({ children, className, role }: { children?: ReactNode; className?: string; role?: string }) =>
    createElement("div", { className, role }, children),
}));

import { TabsMenu, menuLanding, menuRowKey, type PaneTabsView } from "../components/terminal/PaneTabs";
import { tabWords } from "../components/terminal/StageHeader";
import { catalogFor } from "../i18n/catalogs";
import { en } from "../i18n/en";
import { withoutComments } from "./tsx-scan";

const LANGS = ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ro", "zh-CN", "zh-TW"] as const;

const view = (over: Partial<PaneTabsView> = {}): PaneTabsView => ({
  items: [
    { key: "s:s1", id: "wsp-ptab-p0-s:s1", name: "api refactor", status: { state: "idle", phrase: "idle" }, on: true, panel: "workspace-pane" },
    { key: "s:s2", id: "wsp-ptab-p0-s:s2", name: "docs pass", status: { state: "waiting", phrase: "waiting", emphasis: "6m" }, on: false, panel: "workspace-pane" },
    { key: "s:s3", id: "wsp-ptab-p0-s:s3", name: "a very long session name that will never fit the menu's width at all", status: { state: "idle", phrase: "idle" }, on: false, panel: "workspace-pane" },
  ],
  onSelect() {},
  onClose() {},
  ...over,
});

const menu = (open: "first" | "last" | null = "first", v = view()) => renderToStaticMarkup(createElement(TabsMenu, {
  view: v, words: tabWords, menu: open, setMenu() {}, over: true, toStrip() {},
}));

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("each row of the tab menu", () => {
  it("is the tab's radio item and, beside it, a × of its own named for the tab", () => {
    const out = menu();
    const rows = out.split('<div role="none" class="ts-tabs-row">').slice(1);
    expect(rows).toHaveLength(3);
    rows.forEach((row, i) => {
      const name = view().items[i]!.name;
      const buttons = [...row.matchAll(/<button[^>]*>/g)].map(m => m[0]);
      expect(buttons, "two items, the row and its ×").toHaveLength(2);
      // Side by side, never one inside the other: the row's button ends before the × begins.
      expect(row.indexOf("</button>")).toBeLessThan(row.indexOf(buttons[1]!));
      expect(buttons[0]).toContain('role="menuitemradio"');
      expect(buttons[0]).toContain(`aria-posinset="${i + 1}"`);
      expect(buttons[0]).toContain('aria-setsize="3"');
      expect(buttons[0]).toContain(`aria-checked="${i === 0}"`);
      expect(buttons[1]).toContain('role="menuitem"');
      expect(buttons[1]).toContain(`aria-label="Close ${name.replace(/'/g, "&#x27;")}"`);
      expect(buttons[1]).toContain(`title="Close ${name.replace(/'/g, "&#x27;")}"`);
      // Not a stop for the menu's arrows or its first focus: its row reaches it.
      expect(buttons[1]).toContain('data-menu-aside=""');
      expect(buttons[1]).toContain('tabindex="-1"');
      expect(buttons[1]).toContain('aria-keyshortcuts="Delete"');
      expect(buttons[1]).toContain('class="glyph-btn ts-tabs-x"');
    });
    // Inactive tabs too: every row has its ×, the one on show among them.
    expect(out.match(/class="glyph-btn ts-tabs-x"/g)).toHaveLength(3);
  });

  it("is drawn only while the menu is open; shut, the chevron alone", () => {
    const out = menu(null);
    expect(out).not.toContain('role="menu"');
    expect(out).not.toContain("ts-tabs-x");
    expect(out).toContain('aria-haspopup="menu"');
  });

  it("says Close and the tab's name in every language", () => {
    for (const lang of LANGS) {
      const text = catalogFor(lang)["board.stage.tabs.close"];
      expect(text, lang).toBeTruthy();
      expect(text, lang).toContain("{name}");
      if (lang !== "en") expect(text, lang).not.toBe(en["board.stage.tabs.close"]);
    }
    expect(en["board.stage.tabs.close"]).toBe("Close {name}");
  });
});

describe("a key in the tab menu", () => {
  it("goes from a row to its × with Right, and back with Left", () => {
    expect(menuRowKey(key("ArrowRight"), 1, 3, "row")).toEqual({ kind: "x", index: 1 });
    expect(menuRowKey(key("ArrowLeft"), 1, 3, "x")).toEqual({ kind: "row", index: 1 });
    expect(menuRowKey(key("ArrowLeft"), 1, 3, "row"), "nothing before a row").toBeNull();
    expect(menuRowKey(key("ArrowRight"), 1, 3, "x"), "nothing after a ×").toBeNull();
  });

  it("closes the row's tab with a bare Delete, on the row or its ×", () => {
    expect(menuRowKey(key("Delete"), 2, 3, "row")).toEqual({ kind: "close", index: 2 });
    expect(menuRowKey(key("Delete"), 0, 3, "x")).toEqual({ kind: "close", index: 0 });
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) expect(menuRowKey(key("Delete", { [mod]: true }), 0, 3, "row"), mod).toBeNull();
  });

  it("leaves a row's Up, Down, Home and End to the menu, and walks the rows with them from a ×", () => {
    for (const k of ["ArrowUp", "ArrowDown", "Home", "End"]) expect(menuRowKey(key(k), 1, 3, "row"), k).toBeNull();
    expect(menuRowKey(key("ArrowDown"), 1, 3, "x")).toEqual({ kind: "row", index: 2 });
    expect(menuRowKey(key("ArrowDown"), 2, 3, "x"), "round at the end").toEqual({ kind: "row", index: 0 });
    expect(menuRowKey(key("ArrowUp"), 0, 3, "x"), "round at the start").toEqual({ kind: "row", index: 2 });
    expect(menuRowKey(key("Home"), 2, 3, "x")).toEqual({ kind: "row", index: 0 });
    expect(menuRowKey(key("End"), 0, 3, "x")).toEqual({ kind: "row", index: 2 });
  });

  it("leaves Enter and Space (the item's own press: show, or close), Escape, Tab and the browser's chords alone", () => {
    for (const on of ["row", "x"] as const) {
      for (const k of [key("Enter"), key(" "), key("Escape"), key("Tab"), key("ArrowDown", { ctrlKey: true })]) {
        expect(menuRowKey(k, 0, 3, on), `${on} ${k.key}`).toBeNull();
      }
    }
    expect(menuRowKey(key("Delete"), 3, 3, "row"), "not a row of this menu").toBeNull();
  });
});

describe("where the keyboard lands after a close from the menu", () => {
  const items = view().items;
  it("is the next row, or the one before from the last", () => {
    expect(menuLanding(items, "s:s1")).toBe("s:s2");
    expect(menuLanding(items, "s:s2")).toBe("s:s3");
    expect(menuLanding(items, "s:s3")).toBe("s:s2");
  });

  it("is none once one tab is left (the strip and its menu go, the pane takes the keys), or for a tab not in the menu", () => {
    expect(menuLanding(items.slice(0, 2), "s:s1")).toBeNull();
    expect(menuLanding(items, "s:gone")).toBeNull();
  });
});

describe("the close it makes", () => {
  const tabs = withoutComments(sourceOf("components/terminal/PaneTabs.tsx"));
  const shell = withoutComments(sourceOf("components/terminal/StageShell.tsx"));
  const popover = withoutComments(sourceOf("components/AnchoredPopover.tsx"));

  it("is the strip's own close, keyboard and pointer alike, with the menu keeping the keyboard", () => {
    expect(tabs).toContain("land.current = menuLanding(view.items, key);");
    expect(tabs).toContain("view.onClose(key, { keys: true, menu: true });");
    expect(tabs).toContain("onClick={() => close(x.key)}>");
    // Showing stays the strip's tab and the menu's row; the × never shows.
    expect(tabs.match(/view\.onSelect\(x\.key, \{ keys: true \}\)/g)).toHaveLength(2);
  });

  it("goes through the pane's closeTab, as Delete on the strip does; only the strip's own keys move the keyboard to the strip", () => {
    expect(shell).toContain("if (how.keys && !how.menu && rest.length > 1) tabFocusRef.current = paneTabId(id, rest[Math.min(at, rest.length - 1)]!.key);");
    expect(shell).toContain("stage.closeTab(id, gone.target, { keys: !how.keys || rest.length < 2 });");
    expect(shell).toContain("if (how.keys && rest.length < 2 && !gone.on) stage.focusPaneId(id, { keys: true });");
  });

  it("keeps the menu and its chevron open for the next close, even once the strip has room again", () => {
    expect(tabs).toContain("{(over || menu) && (");
    expect(tabs).toContain("if (!over && document.activeElement === document.getElementById(id)) toStrip();");
  });

  it("leaves the × out of the menu's arrow walk and its first focus", () => {
    expect(popover).toContain(`const STOP = '[role="menuitem"]:not([data-menu-aside]), [role="menuitemradio"]:not([data-menu-aside]), [role="menuitemcheckbox"]:not([data-menu-aside])';`);
    expect(popover).toContain("root.querySelectorAll<HTMLButtonElement>(STOP)");
  });
});
