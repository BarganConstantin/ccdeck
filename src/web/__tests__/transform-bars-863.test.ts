// #863: the quota bars, the context-window bar and the quota pace marker
// animated width and left — a layout pass every frame of every change. They
// move by transform now: the fills are full width and scaled from the left, the
// way the machine panel's `.sd-fill` already was, and the marker rides a rail
// as wide as the track, so translateX's percentage (of the rail's own width)
// lands it where `left` did.
//
// The usage-history bars keep their `height` transition, on purpose. Their
// entrance already owns `transform` (a `scaleY` rise held with `both`), a
// `scaleY` for the height would squash the selected column's 1px ring along
// with the bar, and ninety bars inside a fixed-height chart only reflow the
// chart. The audit judged that cost negligible; it is the one left.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const usage = read("../components/UsagePanel.tsx");
const ctx = read("../components/ContextModal.tsx");

function body(selector: string): string {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[1] ?? "";
}
const decl = (selector: string, prop: string) =>
  new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body(selector))?.[1].trim() ?? null;

describe("the panel readouts move by transform (#863)", () => {
  for (const sel of [".qb-fill", ".ctx-window-fill"]) {
    it(`${sel} covers its track and scales from its left edge`, () => {
      // Absolutely, over the whole of its positioned track, rather than as a
      // `width: 100%` — panel-overflow.test.ts pins every percentage width.
      expect(decl(sel, "position")).toBe("absolute");
      expect(decl(sel, "inset")).toBe("0");
      expect(decl(sel, "width")).toBeNull();
      expect(decl(sel, "transform-origin")).toBe("left center");
      expect(decl(sel, "transition")).toMatch(/^transform 400ms/);
    });
  }

  it("sets the fills' readings as a scale, not a width", () => {
    expect(usage).toMatch(/className="qb-fill" style=\{\{ transform: `scaleX\(\$\{fillW \/ 100\}\)`/);
    expect(ctx).toMatch(/className="ctx-window-fill" style=\{\{ transform: `scaleX\(/);
    expect(usage).not.toMatch(/className="qb-fill" style=\{\{ width:/);
    expect(ctx).not.toMatch(/className="ctx-window-fill" style=\{\{ width:/);
  });

  it("moves the pace marker on a rail as wide as the track", () => {
    expect(decl(".qb-pace-rail", "inset")).toBe("0");
    expect(decl(".qb-pace-rail", "transition")).toMatch(/^transform 400ms/);
    expect(decl(".qb-pace-rail", "pointer-events")).toBe("none");
    expect(usage).toMatch(/className="qb-pace-rail" style=\{\{ transform: `translateX\(\$\{pace\.expectedPct\}%\)` \}\}/);
    // The marker itself stands still inside it, at the rail's left edge.
    expect(decl(".qb-pace-marker", "left")).toBe("0");
    expect(decl(".qb-pace-marker", "transition")).toBeNull();
  });

  it("leaves none of the three easing a layout property", () => {
    for (const sel of [".qb-fill", ".ctx-window-fill", ".qb-pace-rail", ".qb-pace-marker"]) {
      expect(decl(sel, "transition") ?? "", sel).not.toMatch(/\b(width|left|height|top)\b/);
    }
  });

  it("keeps the history bars' height transition, for the reasons at the top", () => {
    expect(decl(".uh-bar", "transition")).toMatch(/^height /);
    expect(decl(".uh-bar", "animation")).toMatch(/uh-bar-rise/);
  });
});
