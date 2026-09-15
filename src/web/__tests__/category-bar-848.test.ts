// #848: the tool category filter floated over the canvas permanently, and at
// narrow widths or 200% zoom its last chips were clipped out of reach.
//
// The bar is absolute inside `.canvas-wrap`, one row with no limit, and the
// canvas clips its overflow. At 400px it was 432px on a 384px canvas; at 640px
// "mcp" and "other" sat past the edge, where they could not be seen and a
// keyboard reader's focus still landed. It wraps now, and is bounded by the
// canvas. The bar still renders whenever a category is hidden (#783), so a
// hidden category keeps its chip.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("../App.tsx");

/** The body of the first top-level rule for this selector. */
function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return re.exec(css)?.[1] ?? "";
}

describe("the category bar wraps inside the canvas (#848)", () => {
  it("wraps instead of running past the canvas edge", () => {
    const r = rule(".cat-filter-bar");
    expect(r).toMatch(/flex-wrap:\s*wrap/);
    expect(r).toMatch(/max-width:\s*calc\(100% - 28px\)/);
  });

  it("reads as one bar on two rows, not a stretched pill", () => {
    // A surface's radius from the sheet's hierarchy, not an 18px capsule: a
    // floating group of controls is a small panel.
    expect(rule(".cat-filter-bar")).toMatch(/border-radius:\s*var\(--r-panel\)/);
  });

  it("still keeps a chip for a hidden category (#783)", () => {
    expect(app).toMatch(/\{\(presentCats\.length > 1 \|\| hiddenCats\.size > 0\) && \(/);
  });
});
