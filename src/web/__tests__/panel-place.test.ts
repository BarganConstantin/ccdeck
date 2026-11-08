// Usage and the machine panel, moved by their header (owner, 2026-10-24).
//
// The owner turned a dock beside the stripe down twice and asked for this
// instead: the panels float over the board as before, and the reader can put
// one where the board is empty. A place is kept from the nearer window edge,
// clamped by the sheet to the owner's room (2026-11-08: the whole view between
// the top bar and the status bar, full width, the header always inside), and
// a double click or a drop near the home slot gives the slot back. The drag
// itself, against a home slot that is no bound, is panel-drag-room.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boxOf, clamp, dragBox, HOME_SNAP, LEAST_SHOWN, nearHome, parsePlace, placeOf, PLACE_KEYS, STACK_GAP, stackCap, type PanelRoom } from "../panel-place";
import { sheetText } from "./sheet-source";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const sheet = sheetText();
// 1440 x 900, a 40px bar, a 24px status bar, a 36px header in a 1px edge.
const room: PanelRoom = { w: 1440, h: 876, top: 40, head: 38 };

describe("where a moved panel is kept", () => {
  it("keeps a panel put down on the right from the right edge", () => {
    expect(placeOf(1000, 300, 280, 1440)).toEqual({ edge: "right", x: 160, y: 300 });
  });

  it("keeps one put down on the left from the left edge", () => {
    expect(placeOf(200, 120, 280, 1440)).toEqual({ edge: "left", x: 200, y: 120 });
  });

  it("stays as far from the right stripe when the window widens", () => {
    const place = placeOf(1000, 300, 280, 1440);
    expect(boxOf(place, 280, { ...room, w: 1920 }).left).toBe(1920 - 160 - 280);
  });

  it("draws a stored place back where it was put", () => {
    expect(boxOf(placeOf(1000, 300, 280, 1440), 280, room)).toEqual({ left: 1000, top: 300 });
    expect(boxOf(placeOf(200, 120, 280, 1440), 280, room)).toEqual({ left: 200, top: 120 });
  });
});

describe("the room a panel moves in", () => {
  // CHANGED ON PURPOSE (owner, 2026-11-08): the room is the whole view between
  // the top bar and the status bar at the window's full width, the header
  // always inside. It was the window less the stripes and 8 at each side, under
  // the bar, with 120 kept above the foot.
  it("goes to the window's edges, never under the top bar", () => {
    expect(boxOf({ edge: "left", x: -50, y: 0 }, 280, room)).toEqual({ left: 0, top: 40 });
    expect(boxOf({ edge: "right", x: -50, y: 300 }, 280, room).left).toBe(1440 - 280);
  });

  it("keeps its header whole above the status bar", () => {
    expect(boxOf({ edge: "left", x: 300, y: 5000 }, 280, room).top).toBe(876 - 38);
  });

  it("pulls a far place in on a smaller window without rewriting it", () => {
    const place = { edge: "left" as const, x: 1100, y: 700 };
    expect(boxOf(place, 280, { ...room, w: 1024, h: 576 })).toEqual({ left: 1024 - 280, top: 576 - 38 });
    expect(boxOf(place, 280, room)).toEqual({ left: 1100, top: 700 });
  });

  it("is the drag's clamp too", () => {
    expect(dragBox(-10, -10, 320, room)).toEqual({ left: 0, top: 40 });
    expect(dragBox(5000, 5000, 320, room)).toEqual({ left: 1120, top: 838 });
  });

  it("lets the least win when the room is smaller than the panel, as CSS clamp does", () => {
    expect(clamp(500, 48, 10)).toBe(48);
  });
});

describe("going home", () => {
  it("counts a drop within the snap distance on both axes as a drop home", () => {
    const home = { left: 1112, top: 52 };
    expect(nearHome({ left: 1112 - HOME_SNAP, top: 52 + HOME_SNAP }, home)).toBe(true);
    expect(nearHome({ left: 1112 - HOME_SNAP - 1, top: 52 }, home)).toBe(false);
    expect(nearHome({ left: 1112, top: 52 + HOME_SNAP + 1 }, home)).toBe(false);
  });
});

describe("one panel put below the other", () => {
  // The owner's case: Usage at home, the machine panel put down under it.
  const usage = { left: 1112, top: 52, width: 280 };

  it("shortens the upper one to end a gap above the lower one", () => {
    expect(stackCap(usage, { left: 1112, top: 270, width: 280 })).toEqual({ upper: "a", cap: 270 - 52 - STACK_GAP });
    expect(stackCap({ left: 1000, top: 400, width: 280 }, usage)).toEqual({ upper: "b", cap: 400 - 52 - STACK_GAP });
  });

  it("counts any shared part of a column", () => {
    expect(stackCap(usage, { left: 1112 - 279, top: 300, width: 280 })?.upper).toBe("a");
    expect(stackCap(usage, { left: 1112 - 280, top: 300, width: 280 })).toBeNull();
    expect(stackCap(usage, { left: 1112 + 280, top: 300, width: 280 })).toBeNull();
  });

  it("leaves two that start too close to overlap, rather than keep a sliver", () => {
    expect(stackCap(usage, { left: 1112, top: 52 + LEAST_SHOWN + STACK_GAP, width: 280 })?.cap).toBe(LEAST_SHOWN);
    expect(stackCap(usage, { left: 1112, top: 52 + LEAST_SHOWN + STACK_GAP - 1, width: 280 })).toBeNull();
    expect(stackCap(usage, { ...usage })).toBeNull();
  });

  it("is fitted while one is dragged, and when either arrives, moves or leaves", () => {
    const hook = source("../panel-place.ts");
    expect(hook).toMatch(/const draw = [\s\S]*?fitStack\(\);\s*\};/);
    expect(hook).toContain("useLayoutEffect(() => { fitStack(); }, [placed?.edge, placed?.x, placed?.y]);");
    expect(hook).toMatch(/return \(\) => \{[\s\S]*?scheduleFit\(\);\s*\};/);
  });
});

describe("a stored place", () => {
  it("reads back what was written", () => {
    expect(parsePlace(JSON.stringify({ edge: "right", x: 160, y: 300 }))).toEqual({ edge: "right", x: 160, y: 300 });
  });

  it("is nothing when it is missing, foreign or broken", () => {
    for (const raw of [null, "", "{", "[]", '{"edge":"top","x":1,"y":2}', '{"edge":"left","x":"1","y":2}', '{"edge":"left","x":1}']) {
      expect(parsePlace(raw)).toBeNull();
    }
  });

  it("has a key of its own for each panel", () => {
    expect(PLACE_KEYS.usage).not.toBe(PLACE_KEYS.machine);
    expect(PLACE_KEYS.usage.startsWith("agent-dag.")).toBe(true);
  });
});

describe("in the panels and the sheet", () => {
  it("moves each panel by its header", () => {
    const usage = source("../components/UsagePanel.tsx");
    const machine = source("../components/MachinePanel.tsx");
    expect(usage).toContain("usePanelPlace(PLACE_KEYS.usage)");
    expect(usage).toMatch(/<div className="up-header" \{\.\.\.place\.grip\}>/);
    expect(machine).toContain("usePanelPlace(PLACE_KEYS.machine)");
    expect(machine).toMatch(/<div className="sd-top" \{\.\.\.place\.grip\}>/);
  });

  it("clamps a placed panel in the sheet, from the edge it is kept from", () => {
    // CHANGED ON PURPOSE (owner, 2026-11-08): the header stays whole above the
    // status bar (it kept 120 above the foot), and both edges go to the
    // window's edge (they kept clear of their stripe, 8 to spare).
    expect(sheet).toMatch(/\[data-place\]\s*\{[^}]*--place-head:\s*calc\(var\(--pane-head-h\) \+ 2px\);/);
    expect(sheet).toMatch(/\[data-place\]\s*\{[^}]*--place-at:\s*clamp\(var\(--place-top\), var\(--place-y\), calc\(100vh - var\(--status-room, 0px\) - var\(--place-head\)\)\);/);
    expect(sheet).toMatch(/\[data-place="right"\]\s*\{[^}]*left:\s*auto;[^}]*right:\s*clamp\(0px, var\(--place-x\), calc\(100vw - var\(--place-w\)\)\)/);
    expect(sheet).toMatch(/\[data-place="left"\]\s*\{[^}]*right:\s*auto;[^}]*left:\s*clamp\(0px, var\(--place-x\), calc\(100vw - var\(--place-w\)\)\)/);
    // The drag never measures the home slot for its room, nor the stripes.
    const hook = source("../panel-place.ts");
    expect(hook).toContain('document.querySelector(".topbar")');
    expect(hook).not.toMatch(/top: home\.top/);
  });

  it("starts the room at the top bar's foot, whatever is under it", () => {
    // CHANGED ON PURPOSE (owner, 2026-11-08): "between the top bar and the
    // status bar"; the least top was under the bar, 8 down, and under the
    // rating row while it was shown.
    expect(sheet).toMatch(/\[data-place\]\s*\{[^}]*--place-top:\s*var\(--topbar-h\);/);
  });

  it("comes after rating.css, whose top for the pair it overrides", () => {
    const index = source("../styles.css");
    expect(index.indexOf('"./styles/panel-place.css"')).toBeGreaterThan(index.indexOf('"./styles/rating.css"'));
  });
});
