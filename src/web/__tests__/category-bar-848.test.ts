// #848: the tool category filter floated over the canvas permanently, and at
// narrow widths or 200% zoom its last chips were clipped out of reach.
//
// The bar is absolute inside `.canvas-wrap`, one row with no limit, and the
// canvas clips its overflow. At 400px it was 432px on a 384px canvas; at 640px
// "mcp" and "other" sat past the edge, where they could not be seen and a
// keyboard reader's focus still landed. It wraps now, and is bounded by the
// canvas — and, while #847's rails column is open, by the part of the canvas
// the column leaves, since the canvas's padding does not bound an absolute
// child. The bar still renders whenever a category is hidden (#783), so a
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

const narrow = [...css.matchAll(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");

describe("the category bar wraps inside the canvas (#848)", () => {
  it("wraps instead of running past the canvas edge", () => {
    const r = rule(".cat-filter-bar");
    expect(r).toMatch(/flex-wrap:\s*wrap/);
    expect(r).toMatch(/max-width:\s*calc\(100% - 28px\)/);
  });

  it("reads as one bar on two rows, not a stretched pill", () => {
    expect(rule(".cat-filter-bar")).toMatch(/border-radius:\s*18px/);
  });

  it("stops short of the rails column while it is open", () => {
    expect(rule(".app:has(.rails) .cat-filter-bar")).toMatch(/max-width:\s*calc\(100% - 28px - 296px\)/);
  });

  it("takes the canvas's width back when the column is a sheet on a phone", () => {
    expect(narrow).toMatch(/\.app:has\(\.rails\) \.cat-filter-bar\s*\{\s*max-width:\s*calc\(100% - 28px\)/);
  });

  it("still keeps a chip for a hidden category (#783)", () => {
    expect(app).toMatch(/\{\(presentCats\.length > 1 \|\| hiddenCats\.size > 0\) && \(/);
  });
});
