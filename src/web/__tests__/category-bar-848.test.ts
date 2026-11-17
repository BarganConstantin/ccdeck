// #848: the tool category filter floated over the canvas permanently, and at
// narrow widths or 200% zoom its last chips were clipped out of reach.
//
// The bar is absolute inside `.canvas-wrap`, one row with no limit, and the
// canvas clips its overflow. At 400px it was 432px on a 384px canvas; at 640px
// "mcp" and "other" sat past the edge, where they could not be seen and a
// keyboard reader's focus still landed. It wraps now, and is bounded by the
// canvas. The bar still renders whenever a category is hidden (#783), so a
// hidden category keeps its chip.
//
// CHANGED ON PURPOSE (V4 top-10 #5): the filter no longer floats over the canvas.
// Its rows are the last group of the canvas bar's ⋯ menu, a popover placed in
// the window (AnchoredPopover, popover-place.ts), so #848's promise — every
// category reachable at any width or zoom — is now the menu's: one row per
// category in a column, a menu no wider than the window, and a height the
// placement caps and scrolls.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";
import { toolFilterShown } from "../components/CanvasControls";
import type { DetailCategory } from "../detail-category";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("../App.tsx");
const controls = read("../components/CanvasControls.tsx");
const popover = read("../components/AnchoredPopover.tsx");

/** The body of the first top-level rule for this selector. */
function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return re.exec(css)?.[1] ?? "";
}

describe("the category bar wraps inside the canvas (#848)", () => {
  it("wraps instead of running past the canvas edge", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): .cat-filter-bar's wrap and its 100% - 28px
    // bound → no bar; the rows are a menu no wider than the window, placed and
    // height-capped in it, because the filter is a group of the ⋯ menu now.
    expect(rule(".cat-filter-bar")).toBe("");
    expect(rule(".ap-pop.canvas-more-pop")).toMatch(/max-width:\s*calc\(100vw - 16px\)/);
    expect(popover).toContain("{ width: window.innerWidth, height: window.innerHeight }");
    expect(popover).toContain('el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;');
    expect(rule(".anchored-popover")).toMatch(/overflow-y:\s*auto/);
  });

  it("reads as one bar on two rows, not a stretched pill", () => {
    // CHANGED ON PURPOSE (V4 top-10 #5): one bar on --r-ctl that wrapped → a column
    // of menu rows, one per category, in the menu's own surface, because a menu
    // grows down, never off the side.
    expect(rule(".cat-tools-group")).toMatch(/flex-direction:\s*column/);
    expect(rule(".ap-pop[role=\"menu\"]")).toMatch(/flex-direction:\s*column/);
    expect(rule(".anchored-popover")).toMatch(/border-radius:\s*var\(--r-overlay\)/);
  });

  it("still keeps a chip for a hidden category (#783)", () => {
    // CHANGED ON PURPOSE (critique 3, point 7): a phone's Board is a stack of
    // cards with no bubbles to filter, so the bar is not drawn there; wider,
    // the rule is the one #783 set.
    // CHANGED ON PURPOSE (V4 top-10 #5): App's `{!phone && (…) && <CategoryFilterBar`
    // → the same rule in CanvasControls (toolFilterShown), which a phone never
    // draws (no canvas there), because the filter is a group of the ⋯ menu.
    expect(app).not.toContain("<CategoryFilterBar");
    expect(controls).toContain("return presentCats.length > 1 || hiddenCats.size > 0;");
    expect(controls).toContain("const filter = toggleCat && toolFilterShown(presentCats, hiddenCats) ? toggleCat : null;");
    const none = new Set<DetailCategory>();
    expect(toolFilterShown(["file"], none)).toBe(false);
    expect(toolFilterShown(["file", "shell"], none)).toBe(true);
    // A category hidden and then gone from the board still has its row's way back.
    expect(toolFilterShown([], new Set<DetailCategory>(["shell"]))).toBe(true);
  });
});
