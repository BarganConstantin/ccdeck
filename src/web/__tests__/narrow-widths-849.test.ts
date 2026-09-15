// #849: at narrow widths the topbar overflowed, the page scrolled sideways, and
// the machine panel sat off-screen where no scroll reached it.
//
// Measured at 400px: the topbar's content ran 513px against 385 available, six
// action buttons sat past the right edge, and the machine panel's left edge was
// at -199, fixed, beyond any scroll. The machine panel's half went with #847 —
// it no longer stands beside usage — and what is left is the bar and the
// column at phone widths.
//
// The bar's own rule already said what should happen: the readouts give first
// and the controls not at all. A flex item's default `min-width: auto` kept the
// readout group from shrinking, so the controls were pushed instead. The column
// becomes a sheet below the sheet's existing 640px breakpoint rather than
// leaving the canvas a sliver.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first top-level rule for this selector. */
function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return re.exec(css)?.[1] ?? "";
}

/** Every `@media (max-width: 640px)` block's contents. */
const narrow = [...css.matchAll(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");

describe("the topbar keeps its controls on screen (#849)", () => {
  it("lets the readouts shrink to nothing before a control moves", () => {
    const r = rule(".topbar .readout");
    expect(r).toMatch(/min-width:\s*0/);
    expect(r).toMatch(/overflow:\s*hidden/);
  });

  it("still never shrinks the controls", () => {
    expect(rule(".topbar .actions")).toMatch(/flex:\s*none/);
  });

  it("spends less on padding and gaps on a narrow screen", () => {
    expect(narrow).toMatch(/\.topbar\s*\{[^}]*padding:\s*0 10px/);
    expect(narrow).toMatch(/\.topbar \.actions\s*\{[^}]*gap:\s*8px/);
    // The settings run's offset shrinks with it, so the pair still stands apart.
    expect(narrow).toMatch(/\.topbar \.action-run-utility\s*\{[^}]*margin-left:\s*4px/);
  });
});

describe("the rail panels at phone widths (#849)", () => {
  it("span the window instead of standing side by side past its left edge", () => {
    // They stay side by side on a desktop (the owner's call after #847 stacked
    // them); only below 640px, where the shifted machine panel sat at -199,
    // does each of them take the window's width.
    expect(narrow).toMatch(/\.app \.usage-panel,\s*\.app \.sysdetail\s*\{[^}]*left:\s*8px[^}]*right:\s*8px[^}]*width:\s*auto/);
  });
});
