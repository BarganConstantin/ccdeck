// #882: backdrop blurs and drop-shadow filters sat over the live canvas, whose
// marching dashes, spinners and bubbles never stop — so each filter was
// re-rasterised continuously: the category filter bar's 8px blur, the 4px blur
// under every dialog's scrim, and a drop-shadow on the in-flight connectors (and
// on the selected edge) whose own dashes animate forever. The bar is a solid
// slab now, the scrim is its 55% fill alone, and the moving paths carry no
// filter.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** [selector list, body] for every rule, @media bodies included. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]] as const);
const decl = (b: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(b)?.[1].trim() ?? null;
const bodyOf = (sel: string) => RULES.find(([s]) => s === sel)?.[1] ?? "";

describe("no filter re-rasterises over the live canvas (#882)", () => {
  it("blurs nothing behind any element", () => {
    const blurring = RULES
      // `\S` after the lookahead, or `\s*` backs off one space and the
      // lookahead passes at " none" — which is the occluded rule switching the
      // blur OFF.
      .filter(([, b]) => /backdrop-filter:\s*(?!none)\S/.test(b))
      .map(([sel]) => sel);
    expect(blurring).toEqual([]);
  });

  it("puts no filter on a path that animates forever", () => {
    const glowing = RULES
      .filter(([, b]) => /animation:[^;]*\binfinite\b/.test(b) && /(?:^|[;\s])filter:\s*drop-shadow/.test(b))
      .map(([sel]) => sel);
    expect(glowing).toEqual([]);
    for (const sel of [".tool-conn.status-inflight", ':root[data-theme="light"] .tool-conn.status-inflight',
                       ".react-flow__edge.rf-edge-selected .react-flow__edge-path"]) {
      expect(decl(bodyOf(sel), "filter"), sel).toBeNull();
    }
  });

  it("keeps the in-flight connector in flight: its colour and its moving dashes", () => {
    const inflight = bodyOf(".tool-conn.status-inflight");
    expect(decl(inflight, "stroke")).toBe("var(--inflight)");
    expect(decl(inflight, "animation")).toMatch(/dashflow/);
  });

  it("draws the filter bar as a solid slab in both themes", () => {
    expect(decl(bodyOf(".cat-filter-bar"), "background")).toBe("var(--panel)");
    expect(decl(bodyOf(':root[data-theme="light"] .cat-filter-bar'), "background")).toBe("var(--panel)");
  });

  it("dims the page under a dialog with its fill alone", () => {
    const scrim = bodyOf(".modal-backdrop");
    expect(decl(scrim, "background")).toBe("rgba(5,6,9,0.55)");
    expect(decl(scrim, "backdrop-filter")).toBeNull();
  });
});
