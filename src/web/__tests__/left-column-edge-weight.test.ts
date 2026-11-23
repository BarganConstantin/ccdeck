// The line between the left column and the board (the owner, 2026-11-23: it
// looked too thick). Measured in a browser first: one 1px border, no second
// line beside it, so two device pixels on a 2x screen, and on a Contrast
// theme's dark --line that reads as a bar. On a 2x screen the line is now one
// device pixel: half a pixel of inset shadow on a 1px strip at the column's
// right edge. A border under 1px is drawn 1px, and a 0.5px box is snapped to
// whole pixels and vanished in the browser check; a shadow is drawn at the
// screen's resolution. At 1x the border stays: one device pixel already.
//
// This suite lays nothing out, so it reads the sheet: which rule draws the line
// at which density, that the strip sits between the panels and the drag edge,
// that a phone gets none, and that a forced-colours theme still sees it.
import { describe, expect, it } from "vitest";
import { sheetRules } from "./sheet-cascade";

const rules = sheetRules();
const HIDPI = "(min-resolution: 2dppx) and (min-width: 641px)";

/** The last declaration of `prop` on exactly this selector in this media block. */
function decl(selector: string, prop: string, media: string | null = null): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (r.media !== media || !r.selectors.includes(selector)) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
    if (m) found = m[1].trim();
  }
  return found;
}

describe("the left column's edge", () => {
  it("is the column's 1px --line border at 1x, one device pixel already", () => {
    expect(decl(".left-column", "border-right")).toBe("1px solid var(--line)");
  });

  it("is one device pixel on a 2x screen: the border goes and half a pixel of inset shadow draws it", () => {
    expect(decl(".left-column", "border-right-width", HIDPI)).toBe("0");
    expect(decl(".left-column::after", "content", HIDPI)).toBe('""');
    expect(decl(".left-column::after", "position", HIDPI)).toBe("absolute");
    expect(decl(".left-column::after", "top", HIDPI)).toBe("0");
    expect(decl(".left-column::after", "right", HIDPI)).toBe("0");
    expect(decl(".left-column::after", "bottom", HIDPI)).toBe("0");
    expect(decl(".left-column::after", "width", HIDPI)).toBe("1px");
    // Half a pixel on the right side, in the colour the border had, so only
    // the weight changes.
    expect(decl(".left-column::after", "box-shadow", HIDPI)).toBe("inset -0.5px 0 0 var(--line)");
    // Neither of the two ways that do not draw one device pixel.
    expect(decl(".left-column::after", "border-right", HIDPI)).toBeUndefined();
    expect(decl(".left-column::after", "background", HIDPI)).toBeUndefined();
  });

  it("stands over the panels and under the drag edge, and takes no pointer", () => {
    const strip = Number(decl(".left-column::after", "z-index", HIDPI));
    const panel = Number(rules.find(r => r.media === null && r.selectors.includes(".left-column > .session-list") && /z-index/.test(r.body))
      ?.body.match(/z-index\s*:\s*(\d+)/)?.[1]);
    const edge = Number(decl(".left-column > .sl-edge", "z-index"));
    expect(panel).toBe(1);
    expect(edge).toBe(3);
    expect(strip).toBeGreaterThan(panel);
    expect(strip).toBeLessThan(edge);
    // The 8px edge under the pointer is the drag's; the strip never takes it.
    expect(decl(".left-column::after", "pointer-events", HIDPI)).toBe("none");
  });

  it("draws nowhere on a phone, where the column is the screen's width", () => {
    // The strip's block holds only at 641px and up; the phone keeps its flat column.
    expect(HIDPI).toContain("(min-width: 641px)");
    const stripRules = rules.filter(r => r.selectors.includes(".left-column::after") && /content\s*:/.test(r.body));
    expect(stripRules.map(r => r.media)).toEqual([HIDPI]);
    expect(decl(".left-column", "border-right", "(max-width: 640px)")).toBe("0");
  });

  it("keeps its shadow under forced colours, which drop shadows, in the text colour", () => {
    expect(decl(".left-column::after", "forced-color-adjust", "(forced-colors: active)")).toBe("none");
    expect(decl(".left-column::after", "box-shadow", "(forced-colors: active)")).toBe("inset -0.5px 0 0 CanvasText");
  });

  it("leaves the hover, drag and focus marks on the drag edge as they were", () => {
    expect(decl(".left-column[data-resizing] .sl-edge", "box-shadow")).toBe("inset -2px 0 0 var(--accent)");
    expect(decl(".left-column > .sl-edge", "width")).toBe("8px");
  });
});
