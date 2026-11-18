// The minimap and the character stay off the work (V4 critique, round 3,
// point 6). The minimap is drawn only while part of the board is out of view,
// judged on the cards where React Flow draws them (packed below the full card
// or not); it takes the bottom left corner unless the right one covers fewer
// of the pixels the board draws, tool bubbles and notes included; never on a
// phone, never on an empty board. The character
// stands on the control bar's left end, its feet on the bar's top edge, with
// the minimap shown or hidden, and its fishing line stays inside the canvas.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type Node, type ReactFlowState } from "reactflow";
import { BoardEmptyContext } from "../board-empty";
import {
  boardOffScreen, cornerBox, coveredPixels, drawnCards, drawnWork, MINIMAP_BOX, MINIMAP_EDGE, MINIMAP_HOLD_MS,
  minimapCorner, minimapPlace, onPane, type MinimapCorner, type PaneRect, type WorldRect,
} from "../minimap-place";
import { selectMinimapPlace } from "../use-minimap-place";
import { BUBBLE_HALF_H, burstBox } from "../burst-layout";
import { packNodes, squeezeSpans } from "../packed-board";
import { NODE_H, NODE_W } from "../layout-geometry";
import { CAMERA_SLOW_MS } from "../viewport-motion";
import { barLedge, FLOOR_EDGE, FM_SPRITE_PX, LEDGE_GAP } from "../fm-ledge";
import { BOARD_EDGE } from "../panel-place";
import {
  fallMsFor, fishSteps, leaveLedgeSteps, nextActivity, STEP_UP_PX,
} from "../claude-fm";
import { SPRITE_H } from "../claude-fm-sprite";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";

const shown = vi.hoisted(() => ({ place: null as "left" | "right" | null }));
vi.mock("../use-minimap-place", async importOriginal => ({
  ...(await importOriginal<typeof import("../use-minimap-place")>()),
  useMinimapPlace: () => shown.place,
}));
const { BoardMinimap } = await import("../components/BoardFlow");

const PANE = { width: 1000, height: 700 };
const card = (left: number, top: number, w = NODE_W, h = NODE_H): PaneRect => ({ left, top, right: left + w, bottom: top + h });

describe("the minimap is drawn only while part of the board is out of view", () => {
  it("is not drawn when every card is inside the canvas", () => {
    const cards = [card(40, 40), card(400, 40), card(40, 300)];
    expect(boardOffScreen(cards, PANE)).toBe(false);
    expect(minimapPlace(cards, PANE)).toBeNull();
  });

  it("is drawn when one card reaches past any edge, even by part of itself", () => {
    for (const out of [card(900, 40), card(-60, 40), card(400, -20), card(400, 650)]) {
      expect(minimapPlace([card(40, 40), out], PANE), JSON.stringify(out)).not.toBeNull();
    }
  });

  it("forgives a pixel of rounding at the edge", () => {
    expect(minimapPlace([card(0.5 - 1, 0, 1000.5, 699.5)], PANE)).toBeNull();
  });

  it("draws nothing for a pane not measured yet, or a board with no card", () => {
    expect(minimapPlace([card(900, 40)], { width: 0, height: 0 })).toBeNull();
    expect(minimapPlace([], PANE)).toBeNull();
  });
});

describe("it judges the cards where React Flow draws them", () => {
  const node = (id: string, x: number, y = 0, extra: object = {}) =>
    ({ id, type: "agent", position: { x, y }, positionAbsolute: { x, y }, width: NODE_W, height: NODE_H, data: {}, ...extra });

  it("reads the drawn place and the camera, not a stored place", () => {
    const at = drawnCards([node("a", 100, 50)], [10, 20, 0.5]);
    expect(at).toEqual([{ left: 60, top: 45, right: 60 + NODE_W / 2, bottom: 45 + NODE_H / 2 }]);
  });

  it("counts only the cards that are drawn", () => {
    const nodes = [
      node("a", 0), node("h", 9000, 0, { type: "sessionGroup" }),
      node("n", 9000, 0, { type: "recapNote" }), node("x", 9000, 0, { hidden: true }),
    ];
    expect(drawnCards(nodes, [0, 0, 1])).toHaveLength(1);
  });

  it("does not show a map of a packed board that fits, though its places would not", () => {
    // Two columns 2,400 units apart: at 25% the second stands past a 600px
    // pane as laid out, and well inside it once the board is drawn packed.
    const laid = [node("a", 0), node("b", 2400)] as unknown as Node[];
    const view: [number, number, number] = [10, 10, 0.25];
    const pane = { width: 600, height: 400 };
    expect(minimapPlace(drawnCards(laid, view), pane)).toBe("left");
    const squeeze = squeezeSpans(laid.map(n => ({ left: n.position.x, right: n.position.x + NODE_W })));
    // React Flow places what it is handed: the drawn place is the absolute one.
    const packed = packNodes(laid, squeeze).map(n => ({ ...n, positionAbsolute: n.position }));
    expect(minimapPlace(drawnCards(packed, view), pane)).toBeNull();
  });

  it("is read from React Flow's store as one string", () => {
    const state = (x: number) => ({
      nodeInternals: new Map([["a", node("a", x, 40)]]), transform: [0, 0, 1], width: PANE.width, height: PANE.height,
    }) as unknown as ReactFlowState;
    expect(selectMinimapPlace(state(40))).toBeNull();
    expect(selectMinimapPlace(state(900))).toBe("left");
  });
});

describe("it takes a free bottom corner", () => {
  const left = cornerBox("left", PANE);
  const right = cornerBox("right", PANE);

  it("stands a row up in either bottom corner, clear of the bar and the notices", () => {
    expect(left).toEqual({ left: MINIMAP_EDGE, right: MINIMAP_EDGE + MINIMAP_BOX.width, top: 700 - 50 - 107, bottom: 650 });
    expect(right.right).toBe(PANE.width - MINIMAP_EDGE);
    expect(MINIMAP_EDGE).toBe(BOARD_EDGE);
  });

  it("is bottom left by default", () => {
    expect(minimapCorner([card(900, 40)], PANE)).toBe("left");
  });

  it("moves right when a card stands in the left corner and the right one is free", () => {
    const under = card(20, 520);
    expect(coveredPixels([under], left)).toBeGreaterThan(0);
    expect(minimapCorner([under, card(900, 40)], PANE)).toBe("right");
  });

  it("takes the corner with fewer card pixels, and the left one on a tie", () => {
    const bigLeft = card(0, 450, 300, 250);
    const smallRight = card(PANE.width - 60, 600, 60, 30);
    expect(minimapCorner([bigLeft, smallRight], PANE)).toBe("right");
    const smallLeft = card(0, 600, 60, 30);
    const bigRight = card(PANE.width - 300, 450, 300, 250);
    expect(minimapCorner([smallLeft, bigRight], PANE)).toBe("left");
    const mirror = card(PANE.width - 60, 600, 60, 30);
    expect(minimapCorner([smallLeft, mirror], PANE)).toBe("left");
  });

  it("waits past a camera move before it follows a new answer", () => {
    expect(MINIMAP_HOLD_MS).toBeGreaterThan(CAMERA_SLOW_MS);
  });
});

describe("it counts everything the board draws, the tool bubbles too", () => {
  const node = (id: string, x: number, y: number, extra: object = {}) =>
    ({ id, type: "agent", position: { x, y }, positionAbsolute: { x, y }, width: NODE_W, height: NODE_H, data: {}, ...extra });
  const bubble = (left: number, top: number, w = 120): WorldRect => ({ left, top, right: left + w, bottom: top + 2 * BUBBLE_HALF_H });
  /** React Flow's store for these nodes, at a camera that leaves world and pane alike. */
  const state = (nodes: object[]) => ({
    nodeInternals: new Map(nodes.map((n, i) => [String(i), n])), transform: [0, 0, 1], width: PANE.width, height: PANE.height,
  }) as unknown as ReactFlowState;

  it("reads every node drawn but the sessions' drag handles, and the bubbles through the camera", () => {
    const nodes = [
      node("a", 0, 0), node("a::sub", 300, 0),
      node("n", 0, 300, { type: "recapNote", width: 200, height: 90 }),
      node("h", 0, 0, { type: "sessionGroup", width: 900, height: 600 }),
      node("x", 0, 0, { hidden: true }),
      node("u", 0, 0, { type: "recapNote", width: null, height: null }),
    ];
    const camera = [10, 20, 0.5] as const;
    expect(drawnWork(nodes, camera, [bubble(600, 40)])).toEqual([
      { left: 10, top: 20, right: 10 + NODE_W / 2, bottom: 20 + NODE_H / 2 },
      { left: 160, top: 20, right: 160 + NODE_W / 2, bottom: 20 + NODE_H / 2 },
      { left: 10, top: 170, right: 110, bottom: 215 },
      { left: 310, top: 40, right: 370, bottom: 54 },
    ]);
    expect(onPane(bubble(600, 40), camera)).toEqual({ left: 310, top: 40, right: 370, bottom: 54 });
  });

  it("moves right when a tool bubble stands in the bottom left corner and the right one is free", () => {
    // A card past the right edge brings the map; nothing of the board stands
    // in either bottom corner but the bubble.
    const nodes = [node("a", 40, 40), node("b", 900, 40)];
    const inLeft = bubble(30, 580);
    expect(coveredPixels([inLeft], cornerBox("left", PANE))).toBeGreaterThan(0);
    expect(selectMinimapPlace(state(nodes))).toBe("left");
    expect(selectMinimapPlace(state(nodes), [inLeft])).toBe("right");
    const cards = drawnCards(nodes, [0, 0, 1]);
    expect(minimapPlace(cards, PANE, [...cards, inLeft])).toBe("right");
  });

  it("moves right for a note in the left corner, and keeps left when both corners hold as much", () => {
    const off = node("b", 900, 40);
    const note = node("n", 20, 560, { type: "recapNote", width: 200, height: 90 });
    expect(selectMinimapPlace(state([off, note]))).toBe("right");
    const left = bubble(30, 580), right = bubble(PANE.width - 150, 580);
    expect(selectMinimapPlace(state([off]), [left, right])).toBe("left");
  });

  it("does not bring the map for a bubble or a note out of view: the cards say whether", () => {
    const nodes = [node("a", 40, 40), node("n", 900, 40, { type: "recapNote", width: 200, height: 90 })];
    expect(selectMinimapPlace(state(nodes), [bubble(950, 300)])).toBeNull();
  });

  it("sizes a bubble's box as its label was given room, no wider than the sheet lets the pill grow", () => {
    const at = { worldX: 100, worldY: 200, toolName: "Read" };
    expect(burstBox({ ...at, name: "Read" })).toEqual({ left: 100, top: 200, right: 196, bottom: 200 + 2 * BUBBLE_HALF_H });
    expect(burstBox({ ...at, name: "x".repeat(40) }).right).toBe(100 + 190);
    expect(burstBox({ ...at, name: "x".repeat(13), isSub: true }).right).toBe(100 + 140);
    const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sheet).toMatch(/\.tool-burst \{[^}]*max-width: 190px;/);
    expect(sheet).toMatch(/\.tool-burst\.sub \{[^}]*max-width: 140px;/);
  });
});

describe("BoardMinimap", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => { shown.place = null; delete g.window; });
  const draw = (place: MinimapCorner | null, { empty = false, phone = false } = {}) => {
    shown.place = place;
    if (phone) g.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) };
    const map = createElement(BoardMinimap, {
      nodeColor: () => "#000",
      palette: { "--minimap-mask": "rgba(0,0,0,.5)", "--line": "#333" } as never,
    });
    return renderToStaticMarkup(createElement(ReactFlowProvider, null,
      createElement(BoardEmptyContext.Provider, { value: empty }, map)));
  };

  it("is drawn in the corner it is given", () => {
    expect(draw("left")).toMatch(/class="react-flow__panel react-flow__minimap bottom left"/);
    expect(draw("right")).toMatch(/class="react-flow__panel react-flow__minimap bottom right"/);
  });

  it("is not drawn while the board is all in view", () => {
    expect(draw(null)).toBe("");
  });

  it("is never drawn on a phone or on an empty board", () => {
    expect(draw("left", { phone: true })).toBe("");
    expect(draw("left", { empty: true })).toBe("");
  });

  it("keeps the user's minimap switch as the final say: there is none to keep", () => {
    // Settings has no minimap switch today; this pins that the place is the
    // only thing deciding, so a switch added later has one door to close.
    const board = sourceOf("components/BoardFlow.tsx");
    expect(board).toContain("if (empty || phone || !place) return null;");
  });
});

describe("the sheet", () => {
  const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const at = sheet.indexOf(`${selector} {`);
    return at < 0 ? "" : sheet.slice(at, sheet.indexOf("}", at));
  };

  it("keeps the left corner on the edge and the right one past a panel", () => {
    expect(rule(".react-flow__panel.react-flow__minimap.left")).toContain("margin-left: var(--board-controls-edge);");
    expect(rule(".react-flow__panel.react-flow__minimap.right")).toContain("--minimap-in");
    expect(rule(".react-flow__panel.react-flow__minimap")).toContain("margin-bottom: var(--board-controls-room);");
  });

  it("stands the character on the bar whether or not the minimap is drawn, at every zoom", () => {
    // Nothing that places it asks about the minimap, a panel's inset or the zoom.
    for (const sel of ["\n.fm", '\n.fm[data-ledge="bar"]']) {
      expect(rule(sel), sel).not.toMatch(/minimap-in|data-lod|react-flow__minimap/);
    }
    expect(sheet).not.toMatch(/react-flow__minimap[^{}]*\.fm\b/);
    expect(sheet).not.toMatch(/data-lod[^{}]*\.fm\b/);
  });
});

describe("the character's ledge: the bar's left end", () => {
  const canvasRight = 1400;
  const barAt = (width: number) => ({ left: canvasRight - BOARD_EDGE - width, width });

  it("starts at the bar's left end", () => {
    for (const w of [200, 252, 400]) {
      const ledge = barLedge(canvasRight, barAt(w))!;
      expect(canvasRight - ledge.right - ledge.width, `${w}`).toBe(barAt(w).left);
      expect(ledge.width).toBeGreaterThanOrEqual(FM_SPRITE_PX);
    }
  });

  it("never reaches the part of the bar a minimap in the right corner stands over", () => {
    for (const w of [252, 300, 600]) {
      const ledge = barLedge(canvasRight, barAt(w))!;
      const mapLeft = canvasRight - BOARD_EDGE - MINIMAP_BOX.width;
      expect(canvasRight - ledge.right, `${w}`).toBeLessThanOrEqual(mapLeft - LEDGE_GAP);
      expect(ledge.width).toBeLessThanOrEqual(MINIMAP_BOX.width);
    }
  });

  it("has no ledge on a bar shorter than the character", () => {
    expect(barLedge(canvasRight, barAt(30))).toBeNull();
  });

  it("is the sheet's numbers", () => {
    expect(rule(".fm-sprite")).toContain(`width: ${FM_SPRITE_PX}px;`);
    expect(FLOOR_EDGE).toBe(BOARD_EDGE);
    expect(sheet).toMatch(/--board-controls-gap: 8px;/);
    expect(LEDGE_GAP).toBe(8);
  });

  const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  function rule(selector: string) {
    const at = sheet.indexOf(`\n${selector} {`);
    return at < 0 ? "" : sheet.slice(at, sheet.indexOf("}", at));
  }
});

describe("off the bar and back", () => {
  // The bar's top over the floor at the default density: 12 + 24 + 4 - 15.
  const BAR_LEDGE = 25;

  it("steps back up onto a ledge no taller than itself, rather than roping up", () => {
    expect(STEP_UP_PX).toBe(SPRITE_H * 3);
    const steps = leaveLedgeSteps(0, { ledgeH: BAR_LEDGE, floorSpan: 900, ledgeSpan: 48 }, () => 0.5);
    const acts = steps.map(s => s.act);
    expect(acts).toEqual(["walk", "peer", "fall", "land", "walk", "walk", "walk", "mount"]);
    expect(acts).not.toContain("climb");
    // It ends on the ledge, where it went down.
    expect(steps.at(-1)!.place).toBeUndefined();
    expect(steps.at(-1)!.x).toBe(steps[2].x);
    expect(steps[2].ms).toBe(fallMsFor(BAR_LEDGE));
  });

  it("still ropes up a tall ledge", () => {
    expect(leaveLedgeSteps(0, { ledgeH: 152, floorSpan: 900 }, () => 0.5).map(s => s.act)).toContain("climb");
  });
});

describe("the fishing line stays inside the canvas", () => {
  const roll = 117.5 / 135; // the fish band of ACTIVITIES

  it("fishes from the ledge's far end, so the line drops past the bar's end", () => {
    const steps = nextActivity(0, () => roll, { ledgeH: 25, floorSpan: 900, ledgeSpan: 48 });
    expect(steps.map(s => s.act)).toContain("cast");
    expect(steps[0].x).toBe(-48);
    expect(fishSteps(0, -48, () => roll)[0].x).toBe(-48);
  });

  it("does not fish from the floor line, where the line would hang through the canvas's foot", () => {
    expect(nextActivity(0, () => roll).map(s => s.act)).not.toContain("cast");
    expect(nextActivity(0, () => roll, { ledgeH: 0, floorSpan: 900 }).map(s => s.act)).not.toContain("cast");
  });

  it("ends above the canvas's foot, which is at least the bar's top below its feet", () => {
    const src = sourceOf("components/ClaudeFm.tsx");
    const svg = /<svg className="fm-fishing"[\s\S]*?<\/svg>/.exec(src)![0];
    const ys: number[] = [];
    for (const m of svg.matchAll(/y="(\d+)" width="\d+" height="(\d+)"/g)) ys.push(+m[1] + +m[2]);
    for (const m of svg.matchAll(/d="([^"]+)"/g)) {
      for (const v of m[1].matchAll(/V(\d+)/g)) ys.push(+v[1] + 0.5);
      for (const p of m[1].matchAll(/M\d+ (\d+)/g)) ys.push(+p[1] + 0.5);
    }
    // The svg is 24×32 drawn 72×96, its bottom 57px under the feet.
    const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sheet).toMatch(/\.fm-fishing \{\s*position: absolute; right: 36px; bottom: -57px;\s*width: 72px; height: 96px;/);
    const below = Math.max(...ys) * 3 - (96 - 57);
    // The bar's top is 12 + its 24px button + 4 over the canvas's foot.
    expect(below).toBeLessThan(12 + 24 + 4);
  });
});
