// The board is framed where the reader looks, and nothing covers the card being
// read (V4 top-10, design review point 3).
//
// 1. The fit centres the board across the canvas the panels leave, when the
//    board is narrower than it: anchored on the left margin, a board held by
//    its height stood in the left half of a 1440x900 canvas with ~600px of
//    nothing beside it. A board wider than the canvas at the floor still starts
//    at the margin.
// 2. A selection pans, never zooms (Figma/tldraw): the zoom is kept unless the
//    card's face cannot be read at it, then raised to exactly that zoom; the
//    camera slides the least distance that puts the card, with its note when
//    the note is drawn and the pair fits, clear of the panels; and it does not
//    move at all when the card is already there. Double-click and Z still frame
//    the session (focusViewport, adaptive-graph.test.ts).
// 3. The minimap never stands over the selected card or its note: it takes the
//    other corner, or is not drawn.
// 4. One fit control: the canvas's Fit all chip went (autofit-visible-820.test.ts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactFlowState } from "reactflow";
import { AUTO_FIT_MIN_ZOOM, fitBoard, FIT_MIN_ZOOM, type FitRect } from "../fit-board";
import { revealViewport, type FlowBox } from "../focus-camera";
import {
  clearOfKept, cornerBox, coversKept, drawnCards, drawnSelection, minimapPlace, SELECTED_CLASS, type PaneRect,
} from "../minimap-place";
import { DETAIL_EXIT_ZOOM, FAR_ZOOM } from "../semantic-zoom";
import { PAD } from "../session-chrome";
import { TOOL_LANE_W } from "../layout-geometry";
import { FIT_MARGIN } from "../use-layout-frame";
import { selectMinimapPlace } from "../use-minimap-place";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const agent = (left: number, top: number, w = 260, h = 100): FitRect => ({ left, right: left + w, top, bottom: top + h, type: "agent" });

// ── 1. the fit ──────────────────────────────────────────────────────────────

describe("the fit centres a board narrower than the canvas the panels leave", () => {
  // Two cards in one column, 900 apart: held by its height, below the full
  // card, so drawn packed — the cards in their sessions' 18px padding.
  const tall = [agent(0, 0), agent(0, 900)];
  const pane = { width: 1200, height: 600 };

  it("puts the drawn board's middle on the middle of pane - rail - 2*margin", () => {
    const want = fitBoard(tall, { pane, rail: 0 })!;
    // The zoom is the height's: (600 - 2*80) / 1000 * 0.86.
    expect(want.zoom).toBeCloseTo(0.3784, 10);
    expect(want.zoom).toBeLessThan(DETAIL_EXIT_ZOOM);
    // Drawn: the cards' box, 260 + 2*18 = 296 wide from -18. The room across is
    // 1200 - 2*80 = 1040; the board takes 296 * 0.3784 = 112.0064 of it, and
    // half of the 927.9936 left goes on its left:
    // x = 80 + 463.9968 + 18 * 0.3784 = 550.808 (it was 80 + 6.8112 = 86.8112).
    expect(want.x).toBeCloseTo(550.808, 6);
    const left = -PAD * want.zoom + want.x;
    const right = (260 + PAD) * want.zoom + want.x;
    expect((left + right) / 2).toBeCloseTo(FIT_MARGIN + (1200 - 2 * FIT_MARGIN) / 2, 6);
    // The vertical rule is the same: centred on a landscape canvas.
    expect(want.y).toBeCloseTo((600 - 1036 * want.zoom) / 2 + PAD * want.zoom, 6);
  });

  it("centres in what the rail leaves, not in the whole pane", () => {
    const want = fitBoard(tall, { pane, rail: 200 })!;
    const left = -PAD * want.zoom + want.x;
    const right = (260 + PAD) * want.zoom + want.x;
    expect((left + right) / 2).toBeCloseTo(FIT_MARGIN + (1200 - 200 - 2 * FIT_MARGIN) / 2, 6);
  });

  it("at the full card centres the board with the bubbles' lane its zoom made room for", () => {
    // One card at 1: 260 + the 420 lane = 680 of the 1040 across, 180 either side.
    const want = fitBoard([agent(0, 0)], { pane: { width: 1200, height: 836 }, rail: 0 })!;
    expect(want.zoom).toBe(1);
    expect(want.x).toBeCloseTo(80 + (1040 - (260 + TOOL_LANE_W)) / 2, 10);
    expect(want.x).toBeCloseTo(260, 10);
    // The lane's far edge is as far from the room's right as the card is from its left.
    expect(1200 - FIT_MARGIN - (want.x + 260 + TOOL_LANE_W)).toBeCloseTo(want.x - FIT_MARGIN, 10);
    expect(want.y).toBeCloseTo((836 - 100) / 2, 10);
  });

  it("keeps a board wider than the canvas at the floor on the left margin, its top left first", () => {
    // Ten columns 1200 apart: even packed, wider than the room at the auto-fit's floor.
    const wide = Array.from({ length: 10 }, (_, c) => agent(c * 1200, 0));
    const want = fitBoard(wide, { pane, rail: 0, floor: AUTO_FIT_MIN_ZOOM })!;
    expect(want.zoom).toBe(FAR_ZOOM);
    expect(-PAD * want.zoom + want.x).toBeCloseTo(FIT_MARGIN, 10);
  });

  it("lands on the same frame when fitted twice", () => {
    for (const [rects, frame] of [
      [tall, { pane, rail: 0 }],
      [tall, { pane, rail: 200, floor: FIT_MIN_ZOOM }],
      [[agent(0, 0)], { pane: { width: 1200, height: 836 }, rail: 0 }],
    ] as const) {
      expect(fitBoard(rects, frame)).toEqual(fitBoard(rects, frame));
    }
  });
});

// ── 2. a selection ──────────────────────────────────────────────────────────

describe("a selection brings its card into view and does not zoom in", () => {
  const pane = { width: 1000, height: 700 };
  const insets = { top: 56, left: 32, bottom: 56, right: 32 };
  // The free area: x 32..968, y 56..644.
  const at1 = { x: 0, y: 0, zoom: 1 };
  const card = (x: number, y: number, width = 260, height = 100): FlowBox => ({ x, y, width, height });

  it("does not move a card that is already inside the free area", () => {
    expect(revealViewport({ view: at1, pane, insets, card: card(100, 100) })).toBeNull();
    // Edge to edge is inside.
    expect(revealViewport({ view: at1, pane, insets, card: card(32, 56) })).toBeNull();
    expect(revealViewport({ view: at1, pane, insets, card: card(968 - 260, 644 - 100) })).toBeNull();
  });

  it("slides the least distance, at the zoom it is at", () => {
    // 900..1160 runs 192 past 968: the camera slides 192 left, no further.
    expect(revealViewport({ view: at1, pane, insets, card: card(900, 100) })).toEqual({ x: -192, y: 0, zoom: 1 });
    // -50 is 82 short of 32.
    expect(revealViewport({ view: at1, pane, insets, card: card(-50, 100) })).toEqual({ x: 82, y: 0, zoom: 1 });
    // 650..750 runs 106 past 644.
    expect(revealViewport({ view: at1, pane, insets, card: card(100, 650) })).toEqual({ x: 0, y: -106, zoom: 1 });
    // At 0.5 the zoom stays 0.5: 1800..2060 is 900..1030 on screen, 62 past 968.
    expect(revealViewport({ view: { x: 0, y: 0, zoom: 0.5 }, pane, insets, card: card(1800, 200) }))
      .toEqual({ x: -62, y: 0, zoom: 0.5 });
  });

  it("brings the card's note in with it when the note is drawn and the pair fits", () => {
    // The note sits left of the card. At x = -120 the note is 100..340 → -20..220
    // on screen, 52 short of 32; the card, 280..540, is inside.
    const view = { x: -120, y: 0, zoom: 1 };
    const note: FlowBox = { x: 100, y: 180, width: 240, height: 130 };
    const c = card(400, 200);
    expect(revealViewport({ view, pane, insets, card: c })).toBeNull();
    expect(revealViewport({ view, pane, insets, card: c, note })).toEqual({ x: -68, y: 0, zoom: 1 });
  });

  it("lets the note go when the pair does not fit: the card wins, and is not moved if it is in view", () => {
    // 560 across for the pair, 536 of room in a 600 pane.
    const narrow = { width: 600, height: 700 };
    const view = { x: -120, y: 0, zoom: 1 };
    const note: FlowBox = { x: 100, y: 180, width: 240, height: 130 };
    expect(revealViewport({ view, pane: narrow, insets, card: card(400, 200), note })).toBeNull();
    // Out of view, the card alone is slid in: 600..860 → 480..740, 172 past 568.
    expect(revealViewport({ view, pane: narrow, insets, card: card(600, 200), note })).toEqual({ x: -292, y: 0, zoom: 1 });
  });

  it("raises a zoom the face cannot be read at to exactly FAR_ZOOM, about the card's centre", () => {
    // At 0.25 the card's centre (1130, 1050) is at (282.5, 262.5) on screen;
    // at 0.4 it stays there: x = 282.5 - 1130 * 0.4, y = 262.5 - 1050 * 0.4.
    const view = { x: 0, y: 0, zoom: 0.25 };
    const want = revealViewport({ view, pane, insets, card: card(1000, 1000), minZoom: FAR_ZOOM })!;
    expect(want.zoom).toBe(FAR_ZOOM);
    expect(want.x).toBeCloseTo(-169.5, 10);
    expect(want.y).toBeCloseTo(-157.5, 10);
    // No note is framed there: the note is drawn only at the full card.
    const farNote: FlowBox = { x: -5000, y: 1000, width: 240, height: 130 };
    expect(revealViewport({ view, pane, insets, card: card(1000, 1000), note: farNote, minZoom: FAR_ZOOM })).toEqual(want);
  });

  it("never zooms at or above the face's zoom", () => {
    expect(revealViewport({ view: { x: 0, y: 0, zoom: FAR_ZOOM }, pane, insets, card: card(200, 200) })).toBeNull();
    expect(revealViewport({ view: { x: 0, y: 0, zoom: 0.3 }, pane, insets, card: card(100, 100) })!.zoom).toBe(FAR_ZOOM);
  });

  it("shows the start edge of a card larger than the room", () => {
    // 236 of room across a 300 pane; the card is 260.
    expect(revealViewport({ view: at1, pane: { width: 300, height: 700 }, insets, card: card(100, 100) }))
      .toEqual({ x: -68, y: 0, zoom: 1 });
  });

  it("is what a click, j and k, and the session list do; double-click and Z still frame the session", () => {
    const clicks = read("../use-canvas-clicks.ts");
    const focus = read("../use-agent-focus.ts");
    expect(clicks).toMatch(/\} else \{\s*revealAgent\(id\);\s*\}/);
    expect(clicks).toMatch(/selectAgent\(id, false\);\s*window\.setTimeout\(\(\) => \{ try \{ focusAgent\(id\); \} catch \{\} \}, 80\);/);
    expect(focus).toMatch(/try \{ revealAgent\(target\.id\); \} catch \{\}/);
    expect(focus).toMatch(/try \{ revealAgent\(sessionId\); \} catch \{\}/);
    expect(read("../use-deck-shortcuts.ts")).toMatch(/if \(primarySelectedIdRef\.current\) focusAgent\(primarySelectedIdRef\.current\);/);
    // Kept at the reader's zoom, raised only to the face's, and against the board as drawn.
    expect(focus).toContain("view: currentViewport(),");
    expect(focus).toContain("minZoom: FAR_ZOOM,");
    expect(focus).toContain("const drawn = shownRef.current;");
    expect(read("../App.tsx")).toContain("const shownRef = useMirroredRef(graph.shown);");
    // The note only where the full card draws it.
    expect(focus).toMatch(/lodRef\.current === "detail"\s*\? drawn\.find\(n => n\.type === "recapNote"/);
    // No move, no wheel taken: the auto-fit is left as it was.
    expect(focus).toMatch(/if \(!want\) return;\s*disableAutoFit\(\);\s*moveCamera\(want, FOCUS_MS\);/);
    // The reframe makes the last jump again the way it was made.
    expect(focus).toContain("focusAgentRef.current = (id: string) => (lastFocusRef.current?.reveal ? revealAgent : focusAgent)(id);");
  });
});

// ── 3. the minimap ──────────────────────────────────────────────────────────

describe("the minimap never stands over the card being read", () => {
  const PANE = { width: 1000, height: 700 };
  // The left corner's box is 12..154 across, 543..650 down; the right one 846..988.
  const rect = (left: number, top: number, w = 240, h = 130): PaneRect => ({ left, top, right: left + w, bottom: top + h });
  const underLeft = rect(20, 560);
  const underRight = rect(860, 560);

  it("keeps its corner when the selection is clear of it", () => {
    expect(cornerBox("left", PANE)).toEqual({ left: 12, top: 543, right: 154, bottom: 650 });
    expect(clearOfKept("left", PANE, [])).toBe("left");
    expect(clearOfKept("left", PANE, [rect(400, 100)])).toBe("left");
  });

  it("takes the other corner when its own would cover the selection, and none when both would", () => {
    expect(coversKept("left", PANE, [underLeft])).toBe(true);
    expect(clearOfKept("left", PANE, [underLeft])).toBe("right");
    expect(clearOfKept("right", PANE, [underRight])).toBe("left");
    expect(clearOfKept("left", PANE, [underLeft, underRight])).toBeNull();
  });

  it("decides it after the corner rule: wanted, the freer corner, then clear of the selection", () => {
    const cards = [rect(40, 40), rect(900, 40)]; // one card out past the right edge
    expect(minimapPlace(cards, PANE)).toBe("left");
    expect(minimapPlace(cards, PANE, cards, [underLeft])).toBe("right");
    // A board wholly in view has no map, selection or not.
    expect(minimapPlace([rect(40, 40)], PANE, undefined, [underLeft])).toBeNull();
  });

  const node = (id: string, x: number, y: number, extra: object = {}) => ({
    id, type: "agent", position: { x, y }, positionAbsolute: { x, y }, width: 240, height: 130, data: { sessionId: id.split("::")[0] }, ...extra,
  });

  it("reads the selection off the cards' class, with the note of its session while notes are drawn", () => {
    const nodes = [
      node("a", 0, 0, { className: `rf-spotlit-out ${SELECTED_CLASS}` }),
      node("a::sub", 300, 0),
      node("b", 600, 0),
      node("recap:a", -300, 0, { type: "recapNote", width: 200, height: 90, data: { sessionId: "a", parentId: "a" } }),
      node("recap:b", 300, 300, { type: "recapNote", width: 200, height: 90, data: { sessionId: "b", parentId: "b" } }),
    ];
    const camera = [10, 20, 0.5] as const;
    expect(drawnSelection(nodes, camera, true)).toEqual([
      { left: 10, top: 20, right: 130, bottom: 85 },
      { left: -140, top: 20, right: -40, bottom: 65 },
    ]);
    expect(drawnSelection(nodes, camera, false)).toEqual([{ left: 10, top: 20, right: 130, bottom: 85 }]);
    expect(drawnSelection(nodes.map(n => ({ ...n, className: undefined })), camera, true)).toEqual([]);
  });

  it("is read from the store with the selection in it", () => {
    const state = (nodes: object[]) => ({
      nodeInternals: new Map(nodes.map((n, i) => [String(i), n])), transform: [0, 0, 1], width: PANE.width, height: PANE.height,
    }) as unknown as ReactFlowState;
    const out = node("o", 900, 40);
    expect(selectMinimapPlace(state([out, node("s", 20, 560)]))).toBe("right");
    expect(selectMinimapPlace(state([out, node("s", 20, 560, { className: SELECTED_CLASS })]))).toBe("right");
    // Selected under the left corner while the right is the freer one: still right.
    // Selected under both: no map.
    expect(selectMinimapPlace(state([
      out, node("s", 20, 560, { className: SELECTED_CLASS }), node("t", 860, 560, { className: SELECTED_CLASS }),
    ]))).toBeNull();
    // The cards alone decide whether there is a map at all.
    expect(drawnCards([node("s", 20, 560)], [0, 0, 1])).toHaveLength(1);
  });

  it("is told by the board whether the notes are drawn", () => {
    expect(read("../components/BoardFlow.tsx")).toContain("<BoardMinimap nodeColor={minimapNodeFill} palette={palette} notes={notesDrawn} />");
    expect(read("../components/BoardFlow.tsx")).toContain("const place = useMinimapPlace(notes);");
  });
});
