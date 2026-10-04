// Space pressed none of the deck's buttons outside the canvas: not the rating
// numbers, not the phone-width ⋯, not Cancel in the feedback dialog, not the
// topbar's toggles. Enter did.
//
// React Flow listens for its pan key on the whole document, and the key it
// listens for unless told otherwise is Space. Its listener cancels a matching
// keydown wherever focus is, unless focus is in a text field or inside a
// `.nokey` element — a <button> is neither — and a cancelled Space keydown is
// a button that never fires its click. The pan key buys the board nothing:
// dragging the pane and scrolling over it already pan it.
//
// So the board hands React Flow no pan key at all. Run, not read: the element
// the board draws is the one React Flow is given.
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("document", { hidden: false });

const { default: BoardFlow } = await import("../components/BoardFlow");

const noop = () => {};
const ref = <T,>(current: T) => ({ current });

/** The board, drawn with nothing on it. */
function board() {
  return BoardFlow({
    graph: { allNodes: [], edges: [], visibleAgentIds: new Set(), spotlightSet: null },
    layout: { positionsRef: ref(new Map()), pinnedRef: ref(new Set()), handleRelayout: noop },
    viewport: { restoredViewport: null, onMoveStart: noop, onMove: noop },
    clicks: { onNodeClick: noop, onPaneClick: noop, onNodeDoubleClick: noop, onNodeMouseEnter: noop, onNodeMouseLeave: noop },
    drag: { onNodeDragStart: noop, onNodeDrag: noop, onNodeDragStop: noop },
    appearance: { palette: {}, minimapNodeFill: noop, characterEnabled: false },
    fm: { customFmStations: [] },
    autoFit: { autoFitDisabled: false, enableAutoFitAndRefit: noop },
    pause: { paused: false, pauseGate: null, togglePause: noop },
    stateRef: ref({ agents: new Map() }),
    measuredRef: ref(new Map()),
    hiddenCats: new Set(),
    now: 0,
    openTool: noop, focusAgent: noop, requestClear: noop, setKeyHelpOpen: noop,
  } as unknown as Parameters<typeof BoardFlow>[0]) as { props: Record<string, unknown> };
}

describe("Space on a focused button", () => {
  it("is left to the button: React Flow is given no pan key, which it would otherwise read as Space", () => {
    const flow = board();
    // An absent prop is React Flow's default, "Space" — null is the only
    // value that turns its listener off.
    expect("panActivationKeyCode" in flow.props).toBe(true);
    expect(flow.props.panActivationKeyCode).toBeNull();
  });

  it("and the pane still pans without it, by dragging and by scrolling", () => {
    const flow = board();
    expect(flow.props.panOnDrag ?? true).toBe(true);
    expect(flow.props.panOnScroll).toBe(true);
  });
});
