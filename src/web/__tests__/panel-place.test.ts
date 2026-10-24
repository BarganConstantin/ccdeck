// Usage and the machine panel, moved by their header (owner, 2026-10-24).
//
// The owner turned a dock beside the stripe down twice and asked for this
// instead: the panels float over the board as before, and the reader can put
// one where the board is empty. A place is kept from the nearer window edge,
// clamped between the stripes and below the bar by the sheet, and a double
// click or a drop near the home slot gives the slot back.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boxOf, clamp, HOME_SNAP, LEAST_SHOWN, nearHome, parsePlace, placeOf, PLACE_KEYS, type PanelRoom } from "../panel-place";
import { sheetText } from "./sheet-source";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const sheet = sheetText();
// 1440 x 900, 40px stripes, a 44px bar.
const room: PanelRoom = { w: 1440, h: 900, side: 48, top: 52 };

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
  it("never goes under a stripe or the bar", () => {
    expect(boxOf({ edge: "left", x: 0, y: 0 }, 280, room)).toEqual({ left: 48, top: 52 });
    expect(boxOf({ edge: "right", x: 0, y: 300 }, 280, room).left).toBe(1440 - 48 - 280);
  });

  it("keeps its header and a first reading in the window", () => {
    expect(boxOf({ edge: "left", x: 300, y: 5000 }, 280, room).top).toBe(900 - LEAST_SHOWN);
  });

  it("pulls a far place in on a smaller window without rewriting it", () => {
    const place = { edge: "left" as const, x: 1100, y: 700 };
    expect(boxOf(place, 280, { ...room, w: 1024, h: 600 })).toEqual({ left: 1024 - 48 - 280, top: 600 - LEAST_SHOWN });
    expect(boxOf(place, 280, room)).toEqual({ left: 1100, top: 700 });
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
    expect(sheet).toMatch(/\[data-place\]\s*\{[^}]*--place-at:\s*clamp\(var\(--place-top\), var\(--place-y\), calc\(100vh - 120px\)\);/);
    expect(sheet).toMatch(/\[data-place="right"\]\s*\{[^}]*left:\s*auto;[^}]*right:\s*clamp\(var\(--place-side\), var\(--place-x\)/);
    expect(sheet).toMatch(/\[data-place="left"\]\s*\{[^}]*right:\s*auto;[^}]*left:\s*clamp\(var\(--place-side\), var\(--place-x\)/);
    // The sheet's 120 is the drag's LEAST_SHOWN.
    expect(LEAST_SHOWN).toBe(120);
  });

  it("keeps a placed panel under the rating row while it is shown", () => {
    // The drag measures its least top from the home slot, which rating.css
    // already moves down by the row; the sheet has to agree.
    expect(sheet).toMatch(/\[data-place\]\s*\{[^}]*--place-top:\s*calc\(var\(--topbar-h\) \+ 8px \+ var\(--rating-h, 0px\)\);/);
  });

  it("comes after rating.css, whose top for the pair it overrides", () => {
    const index = source("../styles.css");
    expect(index.indexOf('"./styles/panel-place.css"')).toBeGreaterThan(index.indexOf('"./styles/rating.css"'));
  });
});
