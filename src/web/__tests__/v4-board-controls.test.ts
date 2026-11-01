// V4's Board / Controls (V4's Figma): the canvas's command stack became one
// horizontal bar at the board's bottom right. This pins the order of the items
// (read from the component's source), the box the bar is drawn in, the room it
// leaves for the minimap and the character, the zoom figure's rounding, and
// that the files this change touched hold no literal colour. Tokens only.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";
import { zoomPercent } from "../zoom-percent";
import { en } from "../i18n/en";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const component = read("../components/CanvasControls.tsx");
const stripped = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule(s) whose selector list is exactly `selector`. */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " "));
    if (!sels.includes(selector)) continue;
    // First rule wins: a later one for the same selector is a forced-colours
    // or media override (touch-and-forced-colours.css), not the bar's own value.
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out[d[1]] ??= d[2].replace(/\s+/g, " ");
  }
  return out;
}

describe("the bar's items, left to right", () => {
  // Each item is found by what only it carries, in source order, which is the
  // DOM order and so the tab order.
  const order = [
    'aria-label={t("board.controls.zoomOut")}',
    "<ZoomLevel />",
    'aria-label={t("board.controls.zoomIn")}',
    "react-flow__controls-divider",
    'aria-label={t("board.controls.recenter")}',
    'aria-label={t("board.controls.arrangeLabel")}',
    "aria-label={pauseLabel(t)}",
    'aria-label={t("board.controls.clearLabel")}',
    "react-flow__controls-divider",
    'aria-label={t("board.controls.keysLabel")}',
    'aria-label="Open the Command Panel"',
  ];
  it("says those names in the words V4 drew", () => {
    expect([
      en["board.controls.zoomOut"], en["board.controls.zoomIn"], en["board.controls.recenter"],
      en["board.controls.arrangeLabel"], en["board.controls.clearLabel"], en["board.controls.keysLabel"], en["board.pill.pause"],
    ]).toEqual(["Zoom out", "Zoom in", "Recenter view", "Re-arrange the canvas", "Clear the deck", "Open the keyboard shortcuts", "Pause the canvas"]);
  });
  it("runs zoom out, level, zoom in | recenter, re-arrange, pause, clear | keyboard, Command Panel", () => {
    let from = 0;
    for (const needle of order) {
      const at = component.indexOf(needle, from);
      expect(at, needle).toBeGreaterThanOrEqual(from);
      from = at + needle.length;
    }
  });
  it("sits bottom right, and the dividers are decoration", () => {
    expect(component).toMatch(/<Controls position="bottom-right"/);
    const dividers = component.match(/<span className="react-flow__controls-divider" aria-hidden \/>/g) ?? [];
    expect(dividers).toHaveLength(2);
  });
  it("names the level for both halves of what it does", () => {
    expect(component).toContain("aria-label={`Zoom ${level}, reset to 100%`}");
    expect(component).toContain("rf.zoomTo(1)");
  });
  it("reads the level from the store as a string, in its own component, so a zoom re-renders one button", () => {
    expect(component).toContain("const zoomLevel = (s: ReactFlowState) => zoomPercent(s.transform[2]);");
    const own = component.slice(component.indexOf("function ZoomLevel()"));
    expect(own).toContain("useStore(zoomLevel)");
    expect(own).toContain("data-zoom-level");
    expect(component.match(/useStore\(zoomLevel\)/g)).toHaveLength(1);
  });
  it("keeps the keyboard glyph Settings › Keyboard wears", () => {
    expect(component).toContain('<SettingsSectionGlyph section="keyboard" />');
  });
});

describe("the zoom figure", () => {
  it("is a whole percent", () => {
    expect(zoomPercent(0.8)).toBe("80%");
    expect(zoomPercent(1)).toBe("100%");
    expect(zoomPercent(1.0049)).toBe("100%");
    expect(zoomPercent(1.006)).toBe("101%");
    expect(zoomPercent(0.5)).toBe("50%");
    expect(zoomPercent(2)).toBe("200%");
  });
});

describe("the bar's box", () => {
  it("is one row on --panel with a --line edge, --r-ctl, 2px padding and gap, the overlay shadow", () => {
    const d = decls(".react-flow__controls");
    expect(d["display"]).toBe("flex");
    expect(d["flex-direction"]).toBe("row");
    expect(d["align-items"]).toBe("center");
    expect(d["gap"]).toBe("2px");
    expect(d["padding"]).toBe("2px");
    expect(d["background"]).toBe("var(--panel)");
    expect(d["border"]).toBe("1px solid var(--line)");
    expect(d["border-radius"]).toBe("var(--r-ctl)");
    expect(d["box-shadow"]).toBe("var(--shadow-overlay)");
  });
  it("stands 12px in from the board's right and bottom edges", () => {
    expect(decls(".react-flow")["--board-controls-edge"]).toBe("12px");
    expect(decls(".react-flow__panel.react-flow__controls")["margin"]).toBe("var(--board-controls-edge)");
  });
  it("has buttons 24 square at Compact (--ctl-h less 4) at --r-tag, and a divider 1 by 16 in --line-soft", () => {
    // Never under the deck's 24px target floor, which the two tightest
    // densities (--ctl-h 24 and 26) would otherwise take it below.
    expect(decls(".react-flow")["--board-controls-btn"]).toBe("max(24px, calc(var(--ctl-h) - 4px))");
    const b = decls(".react-flow__controls-button");
    expect(b["width"]).toBe("var(--board-controls-btn)");
    expect(b["height"]).toBe("var(--board-controls-btn)");
    // The bar's radius less its inset, 6 less 2 (V4 decision 21).
    expect(b["border-radius"]).toBe("var(--r-tag)");
    const d = decls(".react-flow__controls-divider");
    expect(d["width"]).toBe("1px");
    expect(d["height"]).toBe("16px");
    expect(d["background"]).toBe("var(--line-soft)");
  });
  it("prints the level in mono 11 on 14, --text-secondary, padded 0 4", () => {
    const z = decls(".react-flow__controls-button[data-zoom-level]");
    expect(z["font"]).toBe("400 11px/14px var(--font-mono)");
    expect(z["color"]).toBe("var(--text-secondary)");
    expect(z["padding"]).toBe("0 4px");
    expect(z["width"]).toBe("auto");
    // Four figures wide at the least, so zoom out does not slide from under
    // a pointer when the label narrows from 100% to 99%.
    expect(z["min-width"]).toBe("calc(4ch + 8px)");
  });
  it("keeps a fingertip at the 28px the buttons stood at before, under a coarse pointer", () => {
    expect(stripped).toMatch(/@media \(pointer: coarse\) \{\s*\.react-flow \{ --board-controls-btn: max\(28px, calc\(var\(--ctl-h\) - 4px\)\); \}/);
  });
  it("paints over the character, which lands behind it on the canvas floor", () => {
    expect(decls(".react-flow__panel.react-flow__controls")["z-index"]).toBe("6");
    expect(Number(decls(".fm")["z-index"])).toBeLessThan(6);
  });
  it("has no top hairline left on a grouped button", () => {
    expect(stripped).not.toContain("data-group-start");
    expect(component).not.toContain("data-group-start");
  });
});

describe("the room the minimap and the character leave for it", () => {
  it("is one property: the edge, the bar (button + 2 padding + 2 edge) and an 8px gap", () => {
    const d = decls(".react-flow");
    expect(d["--board-controls-gap"]).toBe("8px");
    expect(d["--board-controls-room"]).toBe(
      "calc(var(--board-controls-edge) + var(--board-controls-btn) + 6px + var(--board-controls-gap))");
  });
  it("is read by the minimap's bottom offset, and the minimap's right edge is the bar's", () => {
    const m = decls(".react-flow__panel.react-flow__minimap");
    expect(m["margin-bottom"]).toBe("var(--board-controls-room)");
    expect(m["margin-right"]).toBe("var(--board-controls-edge)");
    expect(decls(".fm")["right"]).toBe("var(--board-controls-edge)");
  });
  it("lifts only the character's ledge: its floor stays the canvas's, the same gutter both sides", () => {
    const fm = decls(".fm");
    expect(fm["margin-bottom"]).toBeUndefined();
    expect(fm["bottom"]).toBe("var(--flow-gutter)");
    expect(fm["--fm-y"]).toBe("calc(-1 * (var(--minimap-h) + var(--board-controls-room) - var(--flow-gutter)))");
    expect(decls('.fm[data-place="floor"]')["left"]).toBe("var(--board-controls-edge)");
  });
});

describe("the notices on the bar's row", () => {
  it("stand bottom left on the bar's edge and stop short of the bar's widest", () => {
    const d = decls(".react-flow");
    expect(d["--board-controls-reserve"]).toBe("calc(8 * var(--board-controls-btn) + 64px)");
    const n = decls(".canvas-notices");
    expect(n["left"]).toBe("var(--board-controls-edge)");
    expect(n["right"]).toBe("auto");
    expect(n["bottom"]).toBe("var(--board-controls-edge)");
    expect(n["max-width"]).toBe(
      "calc(100% - 2 * var(--board-controls-edge) - var(--board-controls-reserve) - var(--board-controls-gap))");
  });
  it("stand a row up on a phone, clear of the minimap", () => {
    expect(stripped).toMatch(/@media \(max-width: 640px\) \{\s*\.canvas-notices \{\s*bottom: var\(--board-controls-room\);/);
  });
});

describe("literal colours", () => {
  it("none in the bar's source, the zoom helper, or the blocks this change wrote", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
    // Comments name issues (#1768) that read as short hex, so only code is swept.
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code(component)).not.toMatch(literal);
    expect(code(read("../zoom-percent.ts"))).not.toMatch(literal);
    for (const sel of [".react-flow", ".react-flow__panel.react-flow__controls", ".react-flow__controls",
                       ".react-flow__controls-divider", ".react-flow__controls-button[data-zoom-level]",
                       ".react-flow__panel.react-flow__minimap"]) {
      expect(JSON.stringify(decls(sel)), sel).not.toMatch(literal);
    }
  });
});
