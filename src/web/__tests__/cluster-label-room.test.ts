// A session's name on the canvas is drawn whole inside the pane, clear of the
// chrome over it, or not drawn at all.
//
// WHAT WAS OBSERVED, on a board of nine sessions at 1440×900, zoomed out to
// 0.27 and panned up: the top row's pills sat with their upper half above the
// canvas's top edge — cut through the middle of the text by the top bar — and
// still took a Tab stop each, so the keyboard's focus ring went to a pill whose
// ring and half its words were behind the bar. Panned the other way, a pill in
// the first column slid under the category filter bar the same way: covered,
// and still focusable behind it. At 390px a pill ran off the pane's right edge,
// cut mid-word with no ellipsis.
//
// What a pill does now, decided per frame from the camera, the pane's size and
// the chrome measured over the pane:
//
//   - It never moves. It stays where it has always been, on its box's top
//     edge, and a pill that cannot be drawn there is not drawn. Pinning it to
//     the pane's top instead (the sticky label of a design canvas) would carry
//     it down over its own session's cards, which paint above the cluster
//     layer, and it has no plate to be read over them by.
//   - Its width also stops at the pane's right edge and at chrome to its right
//     on its row, so a pill reaching an edge ellipsises — with its whole text
//     in its title — instead of being cut by the edge.
//   - Hidden is `visibility: hidden`: not painted, not hit, no Tab stop, not
//     read. No transition: a pill leaves and comes back with the pan that moved
//     it, and nothing on the canvas animates for it.
//
// Pure functions, the sheet and the component's source, like the rest of this
// suite: no DOM, no layout engine.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clusterLabelStyle, labelMaxWidth, type Cluster } from "../cluster-bounds";
import { clusterHeader, SEP } from "../cluster-header";
import { LABEL_EDGE, LABEL_H, LABEL_MIN_W, PANE_CHROME, labelRoom, sameBoxes, type PaneBox } from "../cluster-label-room";
import { sheetRules } from "./sheet-cascade";

const component = readFileSync(fileURLToPath(new URL("../components/SessionClusters.tsx", import.meta.url)), "utf8");
const room = readFileSync(fileURLToPath(new URL("../cluster-label-room.ts", import.meta.url)), "utf8");
const rules = (sel: string) => sheetRules().filter(r => r.selectors.includes(sel));

/** A one-card cluster: its pill starts at layout x 216 and sits 12px above y 400. */
const C: Cluster = { sessionId: "s1", label: "shop-api", fullLabel: "shop-api", title: "shop-api", x: 200, y: 400, w: 276, h: 210 };
const PANE = { width: 1200, height: 800 };
const Z = 0.5;
/** The camera that puts C's pill at screen `left`, `top` in the pane at zoom Z. */
const at = (left: number, top: number) => ({ x: left - (C.x + 16) * Z, y: top - C.y * Z + 12, zoom: Z });
/** The category filter bar, as it measures at the canvas's top left. */
const BAR: PaneBox = { left: 14, top: 14, right: 231, bottom: 46 };
/** The minimap, bottom right. */
const MAP: PaneBox = { left: 980, top: 640, right: 1180, bottom: 790 };

describe("a pill whole inside the pane", () => {
  it("is drawn, at the width its gutter allows (#977)", () => {
    expect(labelRoom(C, at(108, 188), PANE, [])).toEqual({ hidden: false, maxWidth: labelMaxWidth(C.w, Z) });
  });

  it("never draws wider than its gutter, wherever the camera puts it", () => {
    for (let left = -400; left <= 1400; left += 37) {
      for (let top = -60; top <= 860; top += 41) {
        const r = labelRoom(C, at(left, top), PANE, [BAR, MAP]);
        expect(r.maxWidth, `${left},${top}`).toBeLessThanOrEqual(labelMaxWidth(C.w, Z));
      }
    }
  });
});

describe("under the top bar", () => {
  it("is not drawn once any of it is above the pane's top edge", () => {
    expect(labelRoom(C, at(108, -2), PANE, []).hidden).toBe(true);
    expect(labelRoom(C, at(108, -LABEL_H), PANE, []).hidden).toBe(true);
  });

  it("keeps room for its focus ring: 2px of outline 1px off the pill, and a pixel of air", () => {
    expect(LABEL_EDGE).toBe(4);
    expect(labelRoom(C, at(108, LABEL_EDGE - 1), PANE, []).hidden).toBe(true);
    expect(labelRoom(C, at(108, LABEL_EDGE), PANE, []).hidden).toBe(false);
  });

  it("is measured at its tallest, with the waiting triangle in it", () => {
    // 10px text, line-height 1, 3px of padding and a 1px border each side is
    // 18px; the 10px triangle sits 1px low and opens the line box to 20.
    expect(LABEL_H).toBe(20);
  });
});

describe("under the category filter bar", () => {
  it("is not drawn while the bar covers where it starts", () => {
    expect(labelRoom(C, at(108, 30), PANE, [BAR]).hidden).toBe(true);
    // Just below the bar's reach, by the same ring's room.
    expect(labelRoom(C, at(108, BAR.bottom + LABEL_EDGE - 1), PANE, [BAR]).hidden).toBe(true);
    expect(labelRoom(C, at(108, BAR.bottom + LABEL_EDGE), PANE, [BAR]).hidden).toBe(false);
  });

  it("is drawn as before beside the bar, where nothing covers it", () => {
    expect(labelRoom(C, at(300, 30), PANE, [BAR])).toEqual({ hidden: false, maxWidth: labelMaxWidth(C.w, Z) });
  });
});

describe("at the pane's other edges", () => {
  it("stops at the right edge with an ellipsis rather than being cut by it", () => {
    expect(labelRoom(C, at(1100, 300), PANE, [])).toEqual({ hidden: false, maxWidth: PANE.width - LABEL_EDGE - 1100 });
  });

  it("is not drawn where the room left would hold only a few letters", () => {
    expect(LABEL_MIN_W).toBe(64);
    expect(labelRoom(C, at(PANE.width - LABEL_EDGE - LABEL_MIN_W, 300), PANE, []).hidden).toBe(false);
    expect(labelRoom(C, at(PANE.width - LABEL_EDGE - LABEL_MIN_W + 1, 300), PANE, []).hidden).toBe(true);
  });

  it("is not drawn once its start has gone past the left edge", () => {
    expect(labelRoom(C, at(LABEL_EDGE - 1, 300), PANE, []).hidden).toBe(true);
    expect(labelRoom(C, at(-50, 300), PANE, []).hidden).toBe(true);
    expect(labelRoom(C, at(LABEL_EDGE, 300), PANE, []).hidden).toBe(false);
  });

  it("is not drawn once any of it is below the bottom edge", () => {
    const lowest = PANE.height - LABEL_EDGE - LABEL_H;
    expect(labelRoom(C, at(108, lowest), PANE, []).hidden).toBe(false);
    expect(labelRoom(C, at(108, lowest + 1), PANE, []).hidden).toBe(true);
  });
});

describe("beside the canvas's own controls", () => {
  it("stops short of chrome to its right on its row", () => {
    expect(labelRoom(C, at(900, 700), PANE, [MAP])).toEqual({ hidden: false, maxWidth: MAP.left - LABEL_EDGE - 900 });
  });

  it("is not drawn while chrome covers where it starts", () => {
    expect(labelRoom(C, at(1000, 700), PANE, [MAP]).hidden).toBe(true);
  });

  it("ignores chrome that is not on its row", () => {
    expect(labelRoom(C, at(900, 600), PANE, [MAP])).toEqual({ hidden: false, maxWidth: labelMaxWidth(C.w, Z) });
  });
});

describe("before the pane is measured", () => {
  it("draws every pill as before rather than none", () => {
    // React Flow reports a 0×0 pane until its first measure. Hiding against
    // that would blank every header for a frame.
    expect(labelRoom(C, at(108, -100), { width: 0, height: 0 }, [])).toEqual({ hidden: false, maxWidth: labelMaxWidth(C.w, Z) });
  });
});

describe("the chrome it keeps clear of", () => {
  it("is the furniture drawn over the pane: the filter bar, the control stack and minimap, the auto-fit chip, the floating panels", () => {
    for (const sel of [".cat-filter-bar", ".react-flow__panel", ".autofit-chip", ".usage-panel", ".sysdetail", ".detail"]) {
      expect(PANE_CHROME.split(",").map(s => s.trim()), sel).toContain(sel);
    }
  });

  it("is measured against the pane and clipped to it", () => {
    expect(room).toMatch(/export function paneChrome\(pane: Element\): PaneBox\[\]/);
    expect(room).toContain("querySelectorAll(PANE_CHROME)");
  });

  it("compares by value, so an unchanged measure costs no render", () => {
    expect(sameBoxes([BAR, MAP], [{ ...BAR }, { ...MAP }])).toBe(true);
    expect(sameBoxes([BAR], [BAR, MAP])).toBe(false);
    expect(sameBoxes([BAR], [{ ...BAR, bottom: 78 }])).toBe(false);
  });
});

describe("the layer draws what the room says", () => {
  it("measures the chrome after every render, before paint", () => {
    expect(component).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]{0,300}paneChrome\(/);
    expect(component).toContain("setChrome(prev => (sameBoxes(prev, next) ? prev : next))");
  });

  it("sizes the pill from the room and hides it when there is none", () => {
    expect(component).toContain("const room = labelRoom(c, { x, y, zoom }, pane, chrome);");
    expect(component).toContain("const labelStyle = clusterLabelStyle(c, zoom, hue, room.maxWidth);");
    expect(component).toContain('data-offpane={room.hidden ? "" : undefined}');
    // The width is the room's, and the room never exceeds the gutter's cap.
    expect(clusterLabelStyle(C, Z, 0, 90).maxWidth).toBe(90);
    expect(clusterLabelStyle(C, Z, 0).maxWidth).toBe(labelMaxWidth(C.w, Z));
  });

  it("hides it in the sheet, out of the paint, the hit test, the tab order and the reading order, with no motion", () => {
    const off = rules(".cluster-label[data-offpane]");
    expect(off.length).toBe(1);
    expect(off[0].body).toMatch(/visibility:\s*hidden/);
    expect(off[0].body).not.toMatch(/transition|animation/);
    // And the pill's own rule still eases nothing but its hover.
    const own = rules(".cluster-label").filter(r => r.media == null).map(r => r.body).join("\n");
    expect(own).toMatch(/transition:\s*box-shadow 120ms ease, filter 120ms ease;/);
  });
});

describe("the pill's tooltip", () => {
  it("says everything the pill says, whole and in its order, then what a press does", () => {
    const name = "Make the invoice builder understand every field the agent writes";
    const h = clusterHeader("shop-api-auth", name, "e3200d5a-1f4e", true, ["e3200d5a-1f4e", "498737ff-5b94"], { branch: "→ 1 · 1 live" });
    expect(h.title.split("\n")[0]).toBe(`shop-api-auth${SEP}→ 1 · 1 live${SEP}${name}${SEP}${h.shortId}`);
    expect(h.title.split("\n").slice(1)).toEqual(["Zoom to this session", "drag the wrapper to move the whole session"]);
  });

  it("leads with the words a screen reader hears for a session waiting on you", () => {
    const h = clusterHeader("shop-api-auth", undefined, "e3200d5a-1f4e", false, [], { alarm: true });
    expect(h.title.split("\n")[0]).toBe("waiting on you: shop-api-auth");
    expect(component).toContain('<span className="cluster-label-said">waiting on you: </span>');
  });

  it("is the title the pill wears", () => {
    expect(component).toContain("title={c.title}");
  });
});
