// Usage and the machine panel, docked beside the right stripe (2026-10-23).
//
// They were the only panels that floated: the session list, Accounts and the
// detail panel each take a column, and these two lay over the canvas and its
// minimap, so the same stripe press gave a column on one edge and a card over
// the board on the other. They take a column now, beside the stripe their
// buttons are on, side by side when both are open (#910's pair, not #847's
// stack), and the canvas narrows by them. A window that cannot keep the board
// its least canvas beside every open column floats them as before.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOCK_MIN_CANVAS, railDocks } from "../rail-dock";
import { sheetText } from "./sheet-source";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const sheet = sheetText();

describe("whether the right panels dock", () => {
  it("docks Usage beside the canvas on a laptop, with the session list open", () => {
    // 1440 - two stripes - the list's 288 - Usage's 280 leaves 792.
    expect(railDocks({ windowW: 1440, leftW: 288, detailShown: false, dockW: 280 })).toBe(true);
  });

  it("docks both at 1440 beside the detail panel when the left column is shut", () => {
    // 1440 - 80 - 360 - 560 leaves 440.
    expect(railDocks({ windowW: 1440, leftW: 0, detailShown: true, dockW: 560 })).toBe(true);
  });

  it("floats both where the board would keep less than its least canvas", () => {
    // 1440 - 80 - 288 - 360 - 560 leaves 152.
    expect(railDocks({ windowW: 1440, leftW: 288, detailShown: true, dockW: 560 })).toBe(false);
    expect(railDocks({ windowW: 1024, leftW: 288, detailShown: false, dockW: 560 })).toBe(false);
  });

  it("draws the line at exactly the least canvas", () => {
    const windowW = 80 + 280 + DOCK_MIN_CANVAS;
    expect(railDocks({ windowW, leftW: 0, detailShown: false, dockW: 280 })).toBe(true);
    expect(railDocks({ windowW: windowW - 1, leftW: 0, detailShown: false, dockW: 280 })).toBe(false);
  });
});

describe("the dock in the page", () => {
  it("comes after the detail panel in the document, as on screen (#880)", () => {
    const detail = app.indexOf("<DetailAside");
    const dock = app.indexOf('className={railDock.docked ? "rail-dock docked" : "rail-dock"}');
    expect(detail).toBeGreaterThan(0);
    expect(dock).toBeGreaterThan(detail);
    // The machine panel, then Usage against the stripe.
    expect(app.indexOf("<MachinePanel", dock)).toBeLessThan(app.indexOf("<UsagePanel", dock));
  });

  it("is no box while floating, and a column in the grid's last track when docked", () => {
    expect(sheet).toMatch(/\.rail-dock\s*\{\s*display:\s*contents;\s*\}/);
    expect(sheet).toMatch(/\.rail-dock\.docked\s*\{[^}]*grid-column:\s*-2;[^}]*grid-row:\s*2 \/ -1;/);
  });

  it("keeps a last track for it in every desktop grid, and none on a phone", () => {
    for (const template of [
      "grid-template-columns: 1fr 360px auto",
      "grid-template-columns: auto 1fr 360px auto",
      "grid-template-columns: 1fr auto",
      "grid-template-columns: auto 1fr auto",
      "grid-template-columns: auto 1fr minmax(0, 360px) auto",
    ]) expect(sheet).toContain(template);
    // A phone is one column: both panels are sheets over the canvas there.
    expect(sheet).toContain(".app, .app:not(:has(.detail)) { grid-template-columns: minmax(0, 1fr); }");
  });
});
