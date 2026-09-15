// autoLayout has chosen the board's column count by scoring each arrangement
// against the frame a fit will show it in ever since #869's fit scoring landed.
// The key that decides whether it runs again never mentioned the frame — it is
// visible agent ids plus `sizeVersion` and `domSizeVersion` — and the only
// three places that cleared it are a node with no position, Clear, and R.
//
// WHAT WAS OBSERVED, in Firefox against src/web/styles.css, running App.tsx's
// own `railCover` and the `(canvas - rail - 160) * 0.86` beside it, on a
// 1280x900 window:
//
//   panels open                       canvas   rail cover   frame (w x h)
//   nothing                            1280         0       963.2 x 503.1
//   usage only                         1280       288       715.5 x 503.1
//   machine only                       1280       288       715.5 x 503.1
//   usage + machine                    1280       588       457.5 x 503.1
//   accounts + usage + machine          980       588       199.5 x 503.1
//   accounts only                       980         0       705.2 x 503.1
//
// so opening the accounts panel and the usage panel and then closing both —
// A then U, the case in the report — takes the frame from 457.5 to 963.2, and
// the same board is packed differently at the two ends:
//
//   sessions   457.5 frame   963.2 frame
//      2          1 col         1 col
//      4          1 col         2 cols     <- the reported strip
//      6          1 col         2 cols
//      8          2 cols        2 cols
//     11          2 cols        3 cols
//
// Nothing recomputed it, so the board stayed a one-column strip beside empty
// canvas until R. The fit was NOT stale — fitLeft measures railCover live — and
// new sessions did self-heal, because fillGapsWithNewSessions is handed the
// frame; only the column assignment for the sessions already on the board was
// stuck.
//
// Adding the frame to the layout signature would not have fixed it: the branch
// that re-columns lives inside `if (missing.length > 0)`, so a signature change
// with every node already placed reaches only separateOverlaps. What is pinned
// here is the question the reframe effect asks instead — would the packing
// differ — and the answer for the frames above.
//
// No DOM: the numbers are the measurement, the rule is the test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Node } from "reactflow";
import { autoLayout, columnsWouldChange } from "../layout";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

const W = 240, H = 130;
const agent = (id: string, sessionId: string): Node =>
  ({ id, position: { x: 0, y: 0 }, data: { sessionId }, width: W, height: H }) as Node;
const sizes = (nodes: Node[]) => new Map(nodes.map(n => [n.id, { width: W, height: H }]));
const sessions = (n: number) => Array.from({ length: n }, (_, i) => agent(`s${i}n0`, `s${i}`));

/** The two frames measured above, either side of closing the accounts and usage panels. */
const NARROW = { width: 457.5, height: 503.1 };
const WIDE = { width: 963.2, height: 503.1 };

const opts = (nodes: Node[]) => ({ direction: "LR" as const, measured: sizes(nodes) });

/**
 * The body of the reframe effect in App.tsx.
 *
 * Read as text rather than run, because what it does is mutate four refs and
 * schedule a fit, and none of that is reachable without React and a canvas.
 * Named so a run against a tree that has lost the effect says so, instead of
 * failing on a null match.
 */
function reframeEffect(): string {
  const m = /columnsWouldChange\(nodes, edges, opts, prev, frame\)[\s\S]*?\}, \[availableWidth/.exec(app);
  expect(m, "App.tsx has no effect asking columnsWouldChange about the frame").not.toBeNull();
  return m![0];
}

/** `needle` is somewhere in App.tsx — asserted without printing the whole file. */
function appHas(needle: string | RegExp, why: string): void {
  const found = typeof needle === "string" ? app.includes(needle) : needle.test(app);
  expect(found, why).toBe(true);
}

/** Columns the board is actually laid out in, read off the roots' x. */
function columns(nodes: Node[], frame: { width: number; height: number }): number {
  const out = autoLayout(nodes, [], {
    ...opts(nodes), availableWidth: frame.width, availableHeight: frame.height,
  });
  return new Set(out.map(n => n.position.x)).size;
}

describe("the column count is a function of the frame (#995)", () => {
  it("packs the reported board one way at 457.5 and another at 963.2", () => {
    // The observation the whole fix rests on, asserted rather than described.
    const board = sessions(5);
    expect(columns(board, NARROW)).toBe(1);
    expect(columns(board, WIDE)).toBe(2);
  });
});

describe("columnsWouldChange asks whether the packing differs, not whether the frame moved (#995)", () => {
  it("says yes across the frame the rail panels take and give back", () => {
    const board = sessions(5);
    expect(columnsWouldChange(board, [], opts(board), NARROW, WIDE)).toBe(true);
    // Symmetric: opening the panels is as much a reframe as closing them.
    expect(columnsWouldChange(board, [], opts(board), WIDE, NARROW)).toBe(true);
  });

  it("says no for a board both frames pack the same way", () => {
    // Two sessions are one column at either end of the measurement, so nothing
    // about the panels is worth moving a card for.
    const board = sessions(2);
    expect(columnsWouldChange(board, [], opts(board), NARROW, WIDE)).toBe(false);
  });

  it("says no for a frame that moved without changing the answer", () => {
    // This is the half that keeps the fix from being churn. `availableWidth` is
    // derived from two readings that are already quantised at 40px, so dragging
    // a window steps it repeatedly; re-laying out on each of those steps would
    // throw away the arrangement fillGapsWithNewSessions built, for a change
    // that moves no card. 963.2 -> 900 is two columns at both ends.
    const board = sessions(5);
    expect(columns(board, { ...WIDE, width: 900 })).toBe(2);
    expect(columnsWouldChange(board, [], opts(board), WIDE, { ...WIDE, width: 900 })).toBe(false);
  });

  it("reads an unmeasured frame as no evidence rather than as a narrow one", () => {
    // canvasSize starts at {0,0} and the effect runs before the ResizeObserver
    // has reported. A zero frame keeps everything in one column inside
    // autoLayout, so comparing against it would relayout the whole board on the
    // first measurement of every mount.
    const board = sessions(5);
    const zero = { width: 0, height: 0 };
    expect(columnsWouldChange(board, [], opts(board), zero, WIDE)).toBe(false);
    expect(columnsWouldChange(board, [], opts(board), NARROW, zero)).toBe(false);
  });

  it("is quiet about a board too small to have a second column", () => {
    const one = sessions(1);
    expect(columnsWouldChange(one, [], opts(one), NARROW, WIDE)).toBe(false);
    expect(columnsWouldChange([], [], opts([]), NARROW, WIDE)).toBe(false);
  });
});

describe("the deck acts on that answer, and keeps what the user placed (#995)", () => {
  it("drops the cached positions, because a signature change alone cannot re-column", () => {
    // `lastLayoutSigRef.current = ""` on its own reaches separateOverlaps and
    // nothing else — the re-columning branch is gated on an unplaced node. The
    // positions have to go, which is what R already does.
    const effect = reframeEffect();
    expect(effect).toMatch(/positionsRef\.current\.delete\(id\)/);
    expect(effect).toMatch(/lastLayoutSigRef\.current = ""/);
  });

  it("keeps the pins, which R does not", () => {
    // R is an explicit "throw it all away"; this fires on its own when a panel
    // closes, so a card the user dragged somewhere stays where they put it.
    const effect = reframeEffect();
    expect(effect).toMatch(/if \(!pinnedRef\.current\.has\(id\)\) positionsRef\.current\.delete\(id\)/);
    expect(effect).not.toMatch(/pinnedRef\.current\.clear\(\)/);
  });

  it("remembers the frame across a reload, which is the monitor-change case", () => {
    // A layout restored from localStorage is a set of coordinates packed for
    // whatever window wrote them. Without a stored frame there is nothing for
    // the first measurement to be compared against, and the board comes back in
    // the old window's column count and stays there.
    appHas('const LAYOUT_FRAME_KEY = "agent-dag.layoutFrame"', "the frame the layout was packed for is not persisted");
    appHas(/useRef<Frame \| null>\(restoredLayoutFrame\)/, "the restored frame does not seed the reframe comparison");
    appHas(/const restoredLayoutFrame = useState\(loadLayoutFrame\)\[0\]/, "the stored frame is not read through a lazy initialiser (#612)");
    // And it goes when the layout it describes goes, or Clear and R leave a
    // frame record pointing at a board that no longer exists.
    const cleared = /function clearStoredLayout\(\): void \{[\s\S]*?\n\}/.exec(app);
    expect(cleared, "clearStoredLayout is gone from App.tsx").not.toBeNull();
    expect(cleared![0]).toMatch(/removeItem\(LAYOUT_FRAME_KEY\)/);
  });

  it("stores the new board rather than the one it replaced", () => {
    // The debounced save is keyed on layoutSig, which a frame change does not
    // move, and positionsRef holds nothing but the pins until the render the
    // reframe schedules has run — so the save has to be after that, not beside
    // the delete.
    const effect = reframeEffect();
    const afterRerender = effect.slice(effect.indexOf("rerender()"));
    expect(afterRerender).toMatch(/saveLayout\(positionsRef\.current, pinnedRef\.current\)/);
    expect(effect.slice(0, effect.indexOf("rerender()"))).not.toMatch(/saveLayout\(/);
  });
});
