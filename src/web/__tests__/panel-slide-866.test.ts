// #866: opening or closing the accounts panel animated its width. The panel was
// the grid's first column and the canvas its 1fr neighbour, so every frame re-
// laid the canvas out, and the board was measured against a canvas that was
// still moving. #941 kept the panel at 288px and slid it in with a transform,
// so the canvas took its new width in one frame.
//
// THAT CONTRACT WAS CHANGED ON PURPOSE (2026-10-08). The canvas taking its new
// width in one frame is the jump the owner asked to have removed: the column
// eases its width now and the canvas rides beside it (styles/left-column.css).
// What #866 guarded still holds, by other means, and is what this file pins:
//   · the panels never resize — each keeps its own width from its first frame
//     to its last, so nothing inside one reflows mid-move;
//   · the board is not re-measured on every frame — the canvas reading the
//     layout packs against is held until the column settles, and taken once.
// The cost #866 named, a layout of the canvas per frame, was measured in a
// headless browser with a 12-session board: no frame of a switch, an open or
// a close moved React Flow's viewport, and none re-packed the board.
import { describe, it, expect } from "vitest";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const body = (selector: string) =>
  new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("the left column moves, and what is in it does not resize (#866)", () => {
  it("keeps each panel at its own width, with no width animation of its own", () => {
    expect(body(".accounts-panel")).toMatch(/width:\s*288px/);
    expect(body(".session-list")).toMatch(/width:\s*240px/);
    for (const sel of [".accounts-panel", ".session-list"]) expect(body(sel), sel).not.toMatch(/\b(animation|transition)\s*:/);
    // The panels' own slide keyframes went with the slide.
    expect(css).not.toMatch(/@keyframes side-(in|out)\b/);
  });

  it("eases only the column's width, and the panels by transform and opacity", () => {
    expect(body(".left-column")).toMatch(/transition:\s*width var\(--column-move\)/);
    const panels = /\.left-column > \.session-list,\s*\.left-column > \.accounts-panel\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(panels).toMatch(/position:\s*absolute/);
    expect(panels).toMatch(/transition:\s*transform var\(--column-move\) var\(--column-ease\),\s*opacity/);
  });

  it("holds the board's reading of the canvas until the column settles", () => {
    const app = sourceOf("App.tsx");
    expect(app).toMatch(/const columnSettleRef = useColumnSettle\(leftColumnTarget\);/);
    expect(app).toMatch(/useCanvasSize\(columnSettleRef\)/);
    const size = sourceOf("use-canvas-size.ts");
    expect(size).toMatch(/settleAt: \(\) => settleRef\?\.current \?\? 0,/);
    // The drift watchdog's reading is never held; the board's is
    // (heldReading, canvas-reading-held.test.ts).
    expect(size).toMatch(/paneSizeRef\.current = \{ width: r\.width, height: r\.height \};\s*reading\.read\(r\.width, r\.height\);/);
  });
});
