// The panels and the board's room (owner, 2026-11-10 critique, point 4).
//
// An open Usage panel floated over the minimap and half the character on its
// edge, and a second right-hand column made it worse. The rule now: no
// floating panel stands over the minimap or the character. They step in past
// every panel their span meets, 12px clear of it as they are of the canvas's
// edge, and are not drawn when what the panels leave of the canvas cannot hold
// them. The fit keeps the board out from under the panels and inside the left
// edge, and leaves the floor row, where the Auto-fit chip stands, free.
//
// Geometry: a 1440 window, 40px stripes, panels 320 wide in their slots
// (machine-panel.css --rail-r: 8px in from the canvas, the machine panel a
// further 320 + 20 when Usage is open), the minimap's 142px box.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOARD_EDGE, fitMinimap, minimapInset } from "../panel-place";
import { FIT_MARGIN } from "../use-layout-frame";
import { sheetText } from "./sheet-source";

const MAP = 142;
const span = (left: number, width = 320) => ({ left, right: left + width });
/** The Board with no column open: the canvas between the two stripes. */
const BOARD = { left: 40, right: 1400 };
/** The Inspector (360) open and the left column (280): two right-hand columns and one on the left. */
const CROWDED = { left: 40 + 280, right: 1440 - 40 - 360 };
/** The home slots on a canvas whose right edge is `r`. */
const usageHome = (r: number) => span(r - 8 - 320);
const machineShifted = (r: number) => span(r - 8 - 320 - 20 - 320);

/** Where the minimap stands for an inset: its span on the canvas. */
const mapAt = (canvas: { right: number }, inset: number) =>
  ({ left: canvas.right - BOARD_EDGE - inset - MAP, right: canvas.right - BOARD_EDGE - inset });

describe("the minimap and the character beside the panels", () => {
  it("stand where they always stood with no panel open", () => {
    expect(minimapInset([], BOARD, MAP)).toBe(0);
  });

  it("step in past Usage in its slot, 12 clear of it", () => {
    const inset = minimapInset([usageHome(BOARD.right)], BOARD, MAP)!;
    expect(inset).toBe(8 + 320);
    expect(usageHome(BOARD.right).left - mapAt(BOARD, inset).right).toBe(BOARD_EDGE);
  });

  it("step past both panels side by side", () => {
    const panels = [usageHome(BOARD.right), machineShifted(BOARD.right)];
    const inset = minimapInset(panels, BOARD, MAP)!;
    expect(inset).toBe(8 + 320 + 20 + 320);
    expect(machineShifted(BOARD.right).left - mapAt(BOARD, inset).right).toBe(BOARD_EDGE);
  });

  it("stay clear of a floating panel with the Inspector open as well", () => {
    const inset = minimapInset([usageHome(CROWDED.right)], CROWDED, MAP)!;
    expect(inset).toBe(8 + 320);
    expect(mapAt(CROWDED, inset).left).toBeGreaterThanOrEqual(CROWDED.left + BOARD_EDGE);
  });

  it("are not drawn when the panels leave no room for them", () => {
    expect(minimapInset([usageHome(CROWDED.right), machineShifted(CROWDED.right)], CROWDED, MAP)).toBeNull();
  });

  it("are moved by a panel the reader put over them, and not by one put elsewhere", () => {
    expect(minimapInset([span(1000)], BOARD, MAP)).toBe(BOARD.right - 1000);
    expect(minimapInset([span(100)], BOARD, MAP)).toBe(0);
    // Beside the minimap on its left, not over it: it stays.
    expect(minimapInset([span(1100, 140)], BOARD, MAP)).toBe(0);
  });

  it("never stand under a panel or past the canvas's left edge", () => {
    const lefts = [40, 300, 640, 900, 1000, 1072, 1150, 1240];
    for (const a of lefts) for (const b of lefts) for (const canvas of [BOARD, CROWDED]) {
      const panels = [span(a), span(b, 280)];
      const inset = minimapInset(panels, canvas, MAP);
      if (inset === null) continue;
      const map = mapAt(canvas, inset);
      expect(map.left, `${a}/${b}`).toBeGreaterThanOrEqual(canvas.left + BOARD_EDGE);
      for (const p of panels) expect(p.right <= map.left || p.left >= map.right + BOARD_EDGE, `${a}/${b}`).toBe(true);
    }
  });

  it("keep the sheet's edge", () => {
    const flow = /^\.react-flow \{([^}]*)\}/m.exec(sheetText())?.[1] ?? "";
    expect(flow).toContain(`--board-controls-edge: ${BOARD_EDGE}px;`);
  });
});

describe("the sheet", () => {
  const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const at = sheet.indexOf(`${selector} {`);
    return at < 0 ? "" : sheet.slice(at, sheet.indexOf("}", at));
  };

  it("moves the minimap and the character's ledge by the same inset", () => {
    expect(rule(".react-flow__panel.react-flow__minimap")).toContain("margin-right: calc(var(--board-controls-edge) + var(--minimap-in, 0px));");
    expect(rule("\n.fm")).toContain("right: calc(var(--board-controls-edge) + var(--minimap-in, 0px));");
  });

  it("hides both, and only both, when there is no room", () => {
    expect(rule('.canvas-wrap[data-minimap="off"] :is(.react-flow__minimap, .fm)')).toContain("visibility: hidden;");
  });

  it("does not animate the step: they stand where they are put", () => {
    expect(rule(".react-flow__panel.react-flow__minimap")).not.toMatch(/transition|animation/);
    expect(sheet).not.toMatch(/--minimap-in[^;]*;[^}]*transition/);
  });
});

describe("fitMinimap, on the panels as they stand", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => { delete g.document; delete g.window; });

  function run(panels: { left: number; width?: number; dock?: string }[], { phone = false, canvas = BOARD } = {}) {
    const style = new Map<string, string>();
    const attrs = new Map<string, string>();
    let asked = "";
    const cell = {
      style: { setProperty: (k: string, v: string) => { style.set(k, v); } },
      setAttribute: (k: string, v: string) => { attrs.set(k, v); },
      removeAttribute: (k: string) => { attrs.delete(k); },
      getBoundingClientRect: () => canvas,
      querySelector: (sel: string) => (sel === ".react-flow__minimap" ? { offsetWidth: MAP } : null),
    };
    g.document = {
      querySelector: (sel: string) => (sel === ".canvas-wrap" ? cell : null),
      querySelectorAll: (sel: string) => {
        asked = sel;
        return panels.map(p => ({
          offsetLeft: p.left, offsetWidth: p.width ?? 320,
          getAttribute: (n: string) => (n === "data-dock" ? p.dock ?? null : null),
        }));
      },
    };
    g.window = { matchMedia: () => ({ matches: phone }) };
    fitMinimap();
    return { inset: style.get("--minimap-in"), off: attrs.get("data-minimap") ?? null, asked };
  }

  it("writes the inset on the canvas for an open panel", () => {
    expect(run([{ left: usageHome(BOARD.right).left }])).toMatchObject({ inset: "328px", off: null });
  });

  it("does not count a panel on its way out", () => {
    expect(run([]).asked).toBe(".usage-panel:not(.leaving), .sysdetail:not(.leaving)");
  });

  it("marks the minimap off when there is no room, and keeps no inset", () => {
    const panels = [{ left: usageHome(CROWDED.right).left }, { left: machineShifted(CROWDED.right).left }];
    expect(run(panels, { canvas: CROWDED })).toMatchObject({ inset: "0px", off: "off" });
  });

  it("leaves Workspace's docked column and the phone's sheets out of it", () => {
    expect(run([{ left: usageHome(BOARD.right).left, dock: "docked" }])).toMatchObject({ inset: "0px", off: null });
    expect(run([{ left: 0, width: 390 }], { phone: true, canvas: { left: 0, right: 390 } })).toMatchObject({ inset: "0px", off: null });
    // A part popped out of the column floats like the Board's.
    expect(run([{ left: usageHome(BOARD.right).left, dock: "float" }]).inset).toBe("328px");
  });
});

describe("the fit's padding", () => {
  const camera = readFileSync(fileURLToPath(new URL("../use-camera.ts", import.meta.url)), "utf8");
  const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

  it("frames the board in the canvas less the panels' strip, from inside the left edge", () => {
    // The width the fit fills is the canvas less what the floating panels
    // cover of its right edge (railCover) and a margin each side; the board's
    // left edge lands on the left margin, so no card is cut there.
    // fitLeft measures (use-camera.ts) and fit-board.ts decides, since round 3.
    const fit = readFileSync(fileURLToPath(new URL("../fit-board.ts", import.meta.url)), "utf8");
    expect(camera).toContain("const railWidth = railCover(pane);");
    expect(fit).toContain("((paneRect.width - railWidth - MARGIN * 2) / (box.w + lane)) * FILL");
    expect(fit).toContain("x: MARGIN - minX * zoom,");
    expect(fit).toContain("MARGIN : Math.max(MARGIN, (paneRect.height - h * zoom) / 2)) - minY * zoom,");
  });

  it("leaves the floor row, where the Auto-fit chip and Undo stand, under the board", () => {
    // The notices stand 12 off the floor and are 24 tall; the control bar's row
    // is at most 12 + 28 + 6 + 8. The board's foot is at least FIT_MARGIN up.
    expect(sheet).toMatch(/\.canvas-notices \{[^}]*bottom: var\(--board-controls-edge\);/);
    expect(sheet).toMatch(/\.autofit-chip \{[^}]*height: 24px;/);
    expect(BOARD_EDGE + 24).toBeLessThan(FIT_MARGIN);
    expect(BOARD_EDGE + 28 + 6 + 8).toBeLessThan(FIT_MARGIN);
  });
});
