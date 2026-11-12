// The board from a distance (owner's critique, round 3, point 1).
//
// Below the full card neither the bubbles nor the notes are drawn, yet the
// columns stood a card, a 420 lane, a gap and the next column's note apart:
// seven sessions beside one panel were framed at 38%, beside two at 22%, every
// card a pill and half the canvas an empty band. Now the faces draw the board
// packed (packed-board.ts), the auto-fit sizes its zoom on that packed width
// from the board's own places (fit-board.ts), so fitting twice lands twice on
// the same frame, and it never goes below the zoom a face still says its task
// at. Fit all still shows the whole board, however small. The pill a face
// becomes below that zoom says the start of its task, never the folder its tag
// already says.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Edge, Node } from "reactflow";
import { autoLayout } from "../layout";
import { RANK_SEP } from "../layout-geometry";
import { sessionGroupNodes } from "../session-group-nodes";
import { AUTO_FIT_MIN_ZOOM, fitBoard, FIT_MIN_ZOOM, type FitRect } from "../fit-board";
import { anchorShift, boardSqueeze, NO_SQUEEZE, PACKED_GAP, packNodes, squeezeSpans, zoomFocus, type Squeeze, type View } from "../packed-board";
import { DETAIL_EXIT_ZOOM, FAR_ZOOM, nextLod } from "../semantic-zoom";
import { FIT_FILL, FIT_MARGIN } from "../use-layout-frame";
import { LABEL_INDENT, labelMaxWidth, PACKED_LABEL_GUTTER } from "../cluster-bounds";
import { PAD } from "../session-chrome";
import { faceTask } from "../rail-row-copy";
import { initialState } from "../reducer";
import { useNodeDrag } from "../use-node-drag";
import type { AgentNodeData } from "../types";

vi.mock("../layout-storage", () => ({ saveLayout: vi.fn() }));
vi.mock("../components/SessionPeek", () => ({ hidePeek: vi.fn() }));

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

// ── the board the critique's shots show ─────────────────────────────────────

const CARD = { width: 260, height: 100 };
const NOTE = { width: 240, height: 130 };
/** The canvas of a 1440x900 window, the panels' stripes and bars taken off. */
const CANVAS = { width: 1129, height: 836 };
const PANEL = 264;
/** What the Usage panel floating at the canvas's right edge covers of it. */
const USAGE_FLOAT = 328;

/** Seven one-card sessions, five with a note beside them, every card with
 *  three bubbles: laid out for the frame a canvas `width` wide, `rail` of it
 *  under floating panels, gives it (use-layout-frame.ts). */
function board(width: number, rail = 0): Node[] {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const measured = new Map<string, { width: number; height: number }>();
  const lanes = new Map<string, number>();
  for (let i = 0; i < 7; i++) {
    const sid = `s${i}`;
    nodes.push({ id: sid, type: "agent", position: { x: 0, y: 0 }, data: { sessionId: sid } } as Node);
    measured.set(sid, CARD);
    lanes.set(sid, 3);
    if (i < 5) {
      const note = `recap:${sid}`;
      nodes.push({ id: note, type: "recapNote", position: { x: 0, y: 0 }, data: { sessionId: sid, parentId: sid } } as Node);
      edges.push({ id: `e:${note}`, source: note, target: sid });
      measured.set(note, NOTE);
    }
  }
  return autoLayout(nodes, edges, {
    measured, lanes,
    availableWidth: (width - rail - FIT_MARGIN * 2) * FIT_FILL,
    availableHeight: (CANVAS.height - FIT_MARGIN * 2) * FIT_FILL,
  }).map(n => ({ ...n, ...measured.get(n.id) }));
}

/** What fitLeft hands fitBoard: every node at the board's own place, the
 *  sessions' handles included (use-camera.ts). */
const rectsOf = (nodes: Node[]): FitRect[] => [...sessionGroupNodes(nodes), ...nodes].map(n => ({
  left: n.position.x, right: n.position.x + (n.width ?? 0), top: n.position.y, bottom: n.position.y + (n.height ?? 0), type: n.type,
}));

const columns = (nodes: Node[]) => new Set(nodes.filter(n => n.type === "agent").map(n => n.position.x)).size;

// ── the squeeze ─────────────────────────────────────────────────────────────

describe("the board as the faces draw it", () => {
  const spans = [{ left: 400, right: 660 }, { left: 1554, right: 1814 }];

  it("closes a wide band to PACKED_GAP and keeps the first run where it is", () => {
    const s = squeezeSpans(spans);
    expect(PACKED_GAP).toBe(RANK_SEP);
    expect(s.at(400)).toBe(400);
    expect(s.at(660)).toBe(660);
    expect(s.at(1554)).toBe(660 + PACKED_GAP);
    expect(s.at(1814)).toBe(660 + PACKED_GAP + 260);
    // Before the first run and past the last, one to one.
    expect(s.at(0)).toBe(0);
    expect(s.at(2000)).toBe(2000 - 1814 + 1080);
  });

  it("is increasing both ways and each way undoes the other", () => {
    const s = squeezeSpans(spans);
    let last = -Infinity;
    for (let x = -100; x <= 2200; x += 7) {
      expect(s.at(x)).toBeGreaterThan(last);
      last = s.at(x);
      expect(s.back(s.at(x))).toBeCloseTo(x, 6);
    }
  });

  it("keeps a band no wider than the gap, and a board of one run, as it is", () => {
    expect(squeezeSpans([{ left: 0, right: 260 }, { left: 260 + PACKED_GAP, right: 680 }])).toBe(NO_SQUEEZE);
    expect(squeezeSpans([{ left: 0, right: 260 }, { left: 100, right: 400 }])).toBe(NO_SQUEEZE);
    expect(squeezeSpans([])).toBe(NO_SQUEEZE);
  });

  it("folds each note behind its card and hands back what does not move", () => {
    const nodes = board(CANVAS.width);
    const drawn = packNodes(nodes, boardSqueeze(nodes));
    const at = (list: Node[], id: string) => list.find(n => n.id === id)!;
    for (const n of drawn) {
      if (n.type !== "recapNote") continue;
      const parent = (n.data as { parentId: string }).parentId;
      expect(n.position.x).toBe(at(drawn, parent).position.x);
      expect(n.position.y).toBe(at(nodes, n.id).position.y);
    }
    // The first column's cards stay put, and are the very same objects.
    const first = Math.min(...nodes.filter(n => n.type === "agent").map(n => n.position.x));
    for (const n of nodes.filter(m => m.type === "agent" && m.position.x === first)) expect(at(drawn, n.id)).toBe(n);
    // The second column stands PACKED_GAP past the first one's cards.
    const xs = [...new Set(drawn.filter(n => n.type === "agent").map(n => n.position.x))].sort((p, q) => p - q);
    expect(xs).toEqual([first, first + CARD.width + PACKED_GAP]);
  });
});

// ── the switch ──────────────────────────────────────────────────────────────

describe("the switch to and from the packed board holds the card the reader zooms at", () => {
  const nodes = board(CANVAS.width);
  const squeeze = boardSqueeze(nodes);
  const cards = nodes.filter(n => n.type === "agent");
  /** Where a card's left edge is on screen, drawn through `map` (null: as laid out). */
  const onScreen = (n: Node, map: Squeeze | null, view: View) => (map ? map.at(n.position.x) : n.position.x) * view.zoom + view.x;
  const secondColumn = cards.filter(n => n.position.x > Math.min(...cards.map(c => c.position.x)));
  const target = secondColumn[1];
  const firstColumn = cards.find(n => !secondColumn.includes(n))!;

  for (const [name, from, to, zoom] of [
    ["zooming in, packed to laid out", squeeze, null, 0.66],
    ["zooming out, laid out to packed", null, squeeze, 0.6],
  ] as const) {
    it(`keeps the card under the pointer within a pixel, ${name}`, () => {
      const view: View = { x: 40, y: 30, zoom };
      // The pointer on the second column's second card as it is drawn now.
      const focus = { x: onScreen(target, from, view) + 20, y: target.position.y * zoom + view.y + 10 };
      const after = { ...view, x: view.x + anchorShift(nodes, from, to, view, focus) };
      expect(Math.abs(onScreen(target, to, after) - onScreen(target, from, view))).toBeLessThan(1);
      // Its column with it; the other column moves instead.
      for (const n of secondColumn) expect(Math.abs(onScreen(n, to, after) - onScreen(n, from, view))).toBeLessThan(1);
      expect(Math.abs(onScreen(firstColumn, to, after) - onScreen(firstColumn, from, view))).toBeGreaterThan(100);
    });
  }

  it("holds the first column where the reader zooms at it, so nothing moves the camera", () => {
    const view: View = { x: 40, y: 30, zoom: 0.66 };
    const focus = { x: onScreen(firstColumn, squeeze, view), y: firstColumn.position.y * 0.66 + 30 };
    expect(anchorShift(nodes, squeeze, null, view, focus)).toBe(0);
  });

  it("finds the point a zoom held still: the pointer, or the pane's middle for the buttons", () => {
    const prev: View = { x: 100, y: 50, zoom: 0.7 };
    const about = (p: { x: number; y: number }, zoom: number): View =>
      ({ x: p.x - ((p.x - prev.x) * zoom) / prev.zoom, y: p.y - ((p.y - prev.y) * zoom) / prev.zoom, zoom });
    const pointer = { x: 612, y: 388 };
    const held = zoomFocus(prev, about(pointer, 0.62))!;
    expect(held.x).toBeCloseTo(pointer.x, 6);
    expect(held.y).toBeCloseTo(pointer.y, 6);
    // A pan holds no point still.
    expect(zoomFocus(prev, { ...prev, x: 300 })).toBeNull();
  });

  it("takes the cards' travel off for the switch and only for it", () => {
    const css = read("../styles/canvas-motion.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.canvas-wrap\[data-repack\] \.react-flow__node,\s*\.canvas-wrap\[data-repack\] \.react-flow__node\.react-flow__node-sessionGroup \{\s*transition: none;\s*\}/);
    expect(css).toMatch(/\.canvas-wrap\[data-repack\] \.cluster-card \{\s*transition: opacity var\(--dur-base\) var\(--ease\);\s*\}/);
    const app = read("../App.tsx");
    expect(app).toMatch(/useRepackAnchor\(\{\s*packed: zoom\.lod !== "detail", nodes, squeeze: graph\.squeeze, focusRef: zoomFocusRef/);
    expect(read("../use-canvas-viewport.ts")).toContain("zoomFocusRef.current = { ...held, reader: !!e || !deck };");
  });
});

// ── the fit ─────────────────────────────────────────────────────────────────

describe("the auto-fit frames the board as drawn", () => {
  const cases = [
    { name: "no panel", pane: CANVAS, rail: 0, least: 0.59 },
    { name: "one panel (264)", pane: { ...CANVAS, width: CANVAS.width - PANEL }, rail: 0, least: 0.59 },
    { name: "two panels (264 each)", pane: { ...CANVAS, width: CANVAS.width - 2 * PANEL }, rail: 0, least: 0.52 },
    { name: "Sessions, Usage floating", pane: { ...CANVAS, width: CANVAS.width - PANEL }, rail: USAGE_FLOAT, least: 0.45 },
  ];

  // Before: 58% with no panel, 38% beside Sessions, 22% beside Sessions and
  // the floating Usage panel (the critique's shots). Now 0.599, 0.599, 0.530
  // with two panels, 0.453.
  for (const c of cases) {
    it(`shows seven cards in two columns, every card whole, ${c.name}`, () => {
      const nodes = board(c.pane.width, c.rail);
      expect(columns(nodes)).toBe(2);
      const want = fitBoard(rectsOf(nodes), { pane: c.pane, rail: c.rail, floor: AUTO_FIT_MIN_ZOOM })!;
      expect(want.zoom).toBeGreaterThanOrEqual(c.least);
      // Under the full card's threshold, so the board is drawn packed...
      expect(nextLod(null, want.zoom)).not.toBe("detail");
      expect(nextLod("detail", want.zoom)).not.toBe("detail");
      // ...and every packed card lands inside the canvas the panels leave.
      const drawn = packNodes(nodes, boardSqueeze(nodes)).filter(n => n.type === "agent");
      for (const n of drawn) {
        const left = n.position.x * want.zoom + want.x;
        const right = (n.position.x + CARD.width) * want.zoom + want.x;
        const top = n.position.y * want.zoom + want.y;
        const bottom = (n.position.y + CARD.height) * want.zoom + want.y;
        expect(left).toBeGreaterThanOrEqual(FIT_MARGIN);
        expect(right).toBeLessThanOrEqual(c.pane.width - c.rail);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeLessThanOrEqual(c.pane.height);
      }
    });
  }

  it("lands on the same frame when fitted again, from any distance", () => {
    for (const c of cases) {
      const nodes = board(c.pane.width, c.rail);
      const frame = { pane: c.pane, rail: c.rail, floor: AUTO_FIT_MIN_ZOOM };
      const first = fitBoard(rectsOf(nodes), frame)!;
      // The fit reads the board's places, never the drawn ones, so the tier
      // its first answer puts the canvas in cannot change the second.
      expect(fitBoard(rectsOf(nodes), frame)).toEqual(first);
      expect(read("../use-camera.ts")).toContain("const board = boardRef.current;");
      expect(read("../App.tsx")).toContain("camera.boardRef.current = nodes;");
    }
  });

  it("never frames below the face's task line on its own; Fit all goes as far as the board needs", () => {
    // Four columns of six sessions each: no canvas shows that whole at 40%.
    const big: FitRect[] = [];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 6; r++) {
      const left = c * 1200, top = r * 260;
      big.push({ left, right: left + CARD.width, top, bottom: top + CARD.height, type: "agent" });
    }
    const pane = { width: CANVAS.width - PANEL, height: CANVAS.height };
    const auto = fitBoard(big, { pane, rail: USAGE_FLOAT, floor: AUTO_FIT_MIN_ZOOM })!;
    const all = fitBoard(big, { pane, rail: USAGE_FLOAT, floor: FIT_MIN_ZOOM })!;
    expect(AUTO_FIT_MIN_ZOOM).toBe(FAR_ZOOM);
    expect(auto.zoom).toBe(FAR_ZOOM);
    expect(all.zoom).toBeLessThan(FAR_ZOOM);
    expect(all.zoom).toBeGreaterThanOrEqual(FIT_MIN_ZOOM);
    // At the floor the board is shown from its top left, the rest a pan away.
    expect(-PAD * auto.zoom + auto.x).toBeCloseTo(FIT_MARGIN, 6);
    expect(-PAD * auto.zoom + auto.y).toBeCloseTo(FIT_MARGIN, 6);
    // A board that fits above the floor is framed the same by both.
    const nodes = board(CANVAS.width);
    expect(fitBoard(rectsOf(nodes), { pane: CANVAS, rail: 0, floor: AUTO_FIT_MIN_ZOOM }))
      .toEqual(fitBoard(rectsOf(nodes), { pane: CANVAS, rail: 0, floor: FIT_MIN_ZOOM }));
  });

  it("keeps the bubbles' lane where the fit lands on the full card", () => {
    // One session: the full card, drawn as laid out, its lane in the frame.
    const one: FitRect[] = [{ left: 0, right: CARD.width, top: 0, bottom: CARD.height, type: "agent" }];
    const want = fitBoard(one, { pane: CANVAS, rail: 0, floor: AUTO_FIT_MIN_ZOOM })!;
    expect(want.zoom).toBeGreaterThan(DETAIL_EXIT_ZOOM);
    expect(want.zoom).toBeLessThanOrEqual(1);
  });

  it("is asked for by who wants it: the auto-fit floored, Fit all and F the whole board", () => {
    const camera = read("../use-camera.ts");
    expect(camera).toContain('floor: reach === "all" ? FIT_MIN_ZOOM : AUTO_FIT_MIN_ZOOM,');
    const app = read("../App.tsx");
    expect(app).toContain("const autoFit = useAutoFitSwitch(camera.fitAll);");
    expect(app).toContain("const handleFit = camera.fitAll;");
    expect(app).toContain('packed: zoom.lod !== "detail",');
  });
});

// ── the columns ─────────────────────────────────────────────────────────────

describe("the columns are cut for the board as drawn", () => {
  it("cuts seven sessions into two columns beside two panels, not one tall column at the floor", () => {
    const nodes = board(CANVAS.width - PANEL, USAGE_FLOAT);
    expect(columns(nodes)).toBe(2);
    const pane = { width: CANVAS.width - PANEL, height: CANVAS.height };
    expect(fitBoard(rectsOf(nodes), { pane, rail: USAGE_FLOAT, floor: AUTO_FIT_MIN_ZOOM })!.zoom).toBeGreaterThan(FAR_ZOOM);
  });
});

// ── the pill ────────────────────────────────────────────────────────────────

describe("the session's pill where the board is packed", () => {
  it("reaches no further than the next column's box", () => {
    // The pill starts LABEL_INDENT inside its box; the next box starts the
    // packed gap less two paddings past this one.
    expect(LABEL_INDENT + PACKED_LABEL_GUTTER).toBeLessThan(PACKED_GAP - 2 * PAD);
    expect(labelMaxWidth(300, 0.5, PACKED_LABEL_GUTTER)).toBe((300 + PACKED_LABEL_GUTTER) * 0.5);
    expect(labelMaxWidth(300, 0.5)).toBe((300 + 240) * 0.5);
  });
});

// ── what a face says ────────────────────────────────────────────────────────

describe("the face's task line", () => {
  const root = (over: Partial<AgentNodeData>) => ({
    kind: "root", label: "ccdeck", prompts: [], ...over,
  }) as Pick<AgentNodeData, "kind" | "label" | "sessionName" | "sessionTitle" | "prompts" | "firstPrompt" | "spawnCall">;

  it("says the task a person last asked", () => {
    expect(faceTask(root({ prompts: [{ at: 1, text: "Add rate limiting\nand tests" }] }))).toBe("Add rate limiting");
  });

  it("says the session's name, else its title, where nothing was asked", () => {
    expect(faceTask(root({ sessionName: "Billing rewrite", sessionTitle: "Rate limits" }))).toBe("Billing rewrite");
    expect(faceTask(root({ sessionTitle: "Rate limits" }))).toBe("Rate limits");
  });

  it("never says the folder the session's tag already says", () => {
    expect(faceTask(root({}))).toBe("");
    expect(faceTask(root({ sessionTitle: "ccdeck" }))).toBe("");
    expect(faceTask(root({ prompts: [{ at: 1, text: "CCDECK" }] }))).toBe("");
  });

  it("says a subagent's own task, else its name", () => {
    expect(faceTask({ kind: "subagent", label: "Explore", prompts: [], spawnCall: { id: "t", description: "Find every route" } } as never)).toBe("Find every route");
    expect(faceTask({ kind: "subagent", label: "Explore", prompts: [] } as never)).toBe("Explore");
  });
});

// ── a drag on the packed board ──────────────────────────────────────────────

describe("a drag on the board as drawn", () => {
  const squeeze = squeezeSpans([{ left: 400, right: 660 }, { left: 1554, right: 1814 }]);
  const card = (id: string, sid: string, x: number, type = "agent"): Node => ({ id, type, position: { x, y: 0 }, data: { sessionId: sid } });

  function mount(nodes: Node[], shown: Node[]) {
    const input = {
      nodes, shown, squeeze, stateRef: { current: initialState() },
      pinnedRef: { current: new Map<string, { x: number; y: number }>() },
      positionsRef: { current: new Map(nodes.map(n => [n.id, { ...n.position }])) },
      draggingRef: { current: false },
      dragPatchRef: { current: null as Map<string, { x: number; y: number }> | null },
      setDragging: vi.fn(), setDragMoveTick: vi.fn(), setDragTick: vi.fn(),
      endBubble: vi.fn(), markInteract: vi.fn(), disableAutoFit: vi.fn(),
      beginTrashDrag: vi.fn(), trackTrashDrag: vi.fn(), endTrashDrag: vi.fn(() => false), removeNode: vi.fn(),
    };
    let drag!: ReturnType<typeof useNodeDrag>;
    function Harness() { drag = useNodeDrag(input); return null; }
    renderToStaticMarkup(createElement(Harness));
    const call = (phase: keyof typeof drag, value: Node) => Reflect.apply(drag[phase], undefined, [{ clientX: 0, clientY: 0 }, value, []]);
    return { input, call };
  }

  it("pins a card at the board's place for where it was dropped", () => {
    const nodes = [card("a", "s0", 400), card("b", "s1", 1554)];
    const shown = packNodes(nodes, squeeze);
    const { input, call } = mount(nodes, shown);
    call("onNodeDragStart", card("b", "s1", 820));
    call("onNodeDragStop", card("b", "s1", 830));
    expect(input.pinnedRef.current.get("b")).toEqual({ x: squeeze.back(830), y: 0 });
    expect(squeeze.back(830)).toBe(1564);
  });

  it("moves a session by its box across a closed band as far on the board as it went as drawn", () => {
    const nodes = [card("a", "s0", 400), card("b", "s1", 1554)];
    const shown = packNodes(nodes, squeeze);
    const { input, call } = mount(nodes, shown);
    // The session's box is drawn round its packed cards (use-board-graph.ts).
    const box = card("group:s1", "s1", 820 - PAD, "sessionGroup");
    call("onNodeDragStart", box);
    // 100 left as drawn: into the band that closed, so further on the board.
    call("onNodeDrag", { ...box, position: { x: box.position.x - 100, y: 0 } });
    expect(input.dragPatchRef.current!.get("b")).toEqual({ x: 720, y: 0 });
    call("onNodeDragStop", { ...box, position: { x: box.position.x - 100, y: 0 } });
    expect(input.positionsRef.current.get("b")!.x).toBeCloseTo(squeeze.back(720), 6);
    expect(input.positionsRef.current.get("a")).toEqual({ x: 400, y: 0 });
  });
});
