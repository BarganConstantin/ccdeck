// The minimap follows the board's answer (minimap-place.ts) only once it has
// held past a camera move, so a fit that passes through "part of the board is
// out of view" on its way to framing it all does not flash the map; a board
// brought wholly into view takes the map away at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentNodeData } from "../types";

// ToolBursts' Bubble is memoised at load: this React draws no child, so a memo
// is the component itself.
vi.mock("react", async () => {
  const { react } = await import("./fake-react");
  return { ...react, default: react, memo: (component: unknown) => component };
});
const store = vi.hoisted(() => ({ cards: [] as { x: number }[] }));
vi.mock("reactflow", () => ({
  useStore: (select: (s: unknown) => unknown) => select({
    nodeInternals: new Map(store.cards.map((c, i) => [String(i), {
      id: String(i), type: "agent", position: { x: c.x, y: 40 }, positionAbsolute: { x: c.x, y: 40 }, width: 240, height: 130,
    }])),
    transform: [0, 0, 1], width: 1000, height: 700,
  }),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

const { mount } = await import("./fake-react");
const { useMinimapPlace } = await import("../use-minimap-place");
const { MINIMAP_HOLD_MS } = await import("../minimap-place");
const { publishBubbleBoxes, useBubbleBoxes } = await import("../bubble-boxes");
const { burstBox, collectBursts } = await import("../burst-layout");
const { default: ToolBursts } = await import("../components/ToolBursts");

/** The document's pointer listeners, so a test can press on the map. */
let heard = new Map<string, (e: unknown) => void>();
class FakeElement { constructor(private onMap: boolean) {} closest(sel: string) { return this.onMap && sel === ".react-flow__minimap" ? this : null; } }
beforeEach(() => {
  heard = new Map();
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("document", {
    addEventListener: (type: string, fn: (e: unknown) => void) => { heard.set(type, fn); },
    removeEventListener: (type: string) => { heard.delete(type); },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); store.cards = []; publishBubbleBoxes([]); });

describe("the minimap's hold", () => {
  it("comes after the answer has held, and goes at once", () => {
    vi.useFakeTimers();
    store.cards = [{ x: 40 }];
    let place: ReturnType<typeof useMinimapPlace> = null;
    const m = mount(() => { place = useMinimapPlace(); return null; }, {});
    expect(place).toBeNull();

    // A card goes past the right edge: not yet.
    store.cards = [{ x: 40 }, { x: 900 }];
    m.rerender();
    expect(place).toBeNull();
    vi.advanceTimersByTime(MINIMAP_HOLD_MS - 50);
    expect(place).toBeNull();
    vi.advanceTimersByTime(60);
    m.rerender();
    expect(place).toBe("left");

    // The board is framed again: gone in the same render.
    store.cards = [{ x: 40 }];
    m.rerender();
    expect(place).toBeNull();
    m.unmount();
  });

  it("does not show for an answer that changes back inside the hold", () => {
    vi.useFakeTimers();
    store.cards = [{ x: 40 }];
    let place: ReturnType<typeof useMinimapPlace> = null;
    const m = mount(() => { place = useMinimapPlace(); return null; }, {});
    store.cards = [{ x: 40 }, { x: 900 }];
    m.rerender();
    vi.advanceTimersByTime(MINIMAP_HOLD_MS / 2);
    store.cards = [{ x: 40 }];
    m.rerender();
    vi.advanceTimersByTime(MINIMAP_HOLD_MS);
    m.rerender();
    expect(place).toBeNull();
    m.unmount();
  });

  it("stays under a press on the map that brings the board into view, and goes on release", () => {
    vi.useFakeTimers();
    store.cards = [{ x: 40 }, { x: 900 }];
    let place: ReturnType<typeof useMinimapPlace> = null;
    const m = mount(() => { place = useMinimapPlace(); return null; }, {});
    vi.advanceTimersByTime(MINIMAP_HOLD_MS + 10);
    expect(place).toBe("left");
    // A press elsewhere is not a press on the map.
    heard.get("pointerdown")!({ target: new FakeElement(false) });
    store.cards = [{ x: 40 }];
    m.rerender();
    expect(place).toBeNull();

    store.cards = [{ x: 40 }, { x: 900 }];
    m.rerender();
    vi.advanceTimersByTime(MINIMAP_HOLD_MS + 10);
    expect(place).toBe("left");
    heard.get("pointerdown")!({ target: new FakeElement(true) });
    store.cards = [{ x: 40 }];
    m.rerender();
    vi.advanceTimersByTime(MINIMAP_HOLD_MS * 2);
    expect(place).toBe("left");
    heard.get("pointerup")!({});
    expect(place).toBeNull();
    m.unmount();
  });
});

describe("the tool bubbles reach the minimap", () => {
  const NOW = 1_700_000_000_000;
  /** One session whose card stands low on the left, with a Read and its file
   *  beside it: the bubbles fall in the bottom left corner of a 1000x700 pane
   *  (the corner's box is 12..154 across, 543..650 down). */
  const agent = {
    id: "a", sessionId: "a", label: "a", kind: "root", state: "active", startedAt: NOW - 60_000,
    tools: [{ id: "t1", name: "Read", inputPreview: "", input: { file_path: "/repo/a.ts" },
      startedAt: NOW - 30_000, endedAt: NOW - 29_000, ok: true, agentId: "a" }],
    prompts: [], toolCount: 1, childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  } as unknown as AgentNodeData;
  const props = {
    agents: new Map([["a", agent]]), visibleAgentIds: new Set(["a"]),
    positions: new Map([["a", { x: -300, y: 540 }]]), pinned: new Map<string, { x: number; y: number }>(),
    measured: new Map([["a", { width: 240, height: 130 }]]), now: NOW,
  };

  it("hears the boxes of the bubbles ToolBursts draws, and none once the layer is gone", () => {
    let boxes: ReturnType<typeof useBubbleBoxes> = [];
    const ear = mount(() => { boxes = useBubbleBoxes(); return null; }, {});
    const layer = mount(ToolBursts, props);
    const drawn = collectBursts(props.agents, props.visibleAgentIds, props.positions, props.pinned, props.measured, NOW);
    expect(drawn.length).toBe(2);
    expect(boxes).toEqual(drawn.map(burstBox));
    // The same bubbles again tell nobody: the list the minimap holds is the one it had.
    const held = boxes;
    layer.rerender({ ...props });
    expect(boxes).toBe(held);
    layer.unmount();
    expect(boxes).toEqual([]);
    ear.unmount();
  });

  it("moves the map right, after the hold, when the bubbles stand in the left corner", () => {
    vi.useFakeTimers();
    store.cards = [{ x: 400 }, { x: 900 }];
    let place: ReturnType<typeof useMinimapPlace> = null;
    const m = mount(() => { place = useMinimapPlace(); return null; }, {});
    vi.advanceTimersByTime(MINIMAP_HOLD_MS + 10);
    expect(place).toBe("left");

    const layer = mount(ToolBursts, props);
    expect(place).toBe("left");
    vi.advanceTimersByTime(MINIMAP_HOLD_MS + 10);
    expect(place).toBe("right");

    // The bubbles go with their layer: the left corner is free again.
    layer.unmount();
    vi.advanceTimersByTime(MINIMAP_HOLD_MS + 10);
    expect(place).toBe("left");
    m.unmount();
  });
});
