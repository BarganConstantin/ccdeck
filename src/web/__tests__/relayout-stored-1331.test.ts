// #1331: R rebuilt the board and never stored it.
//
// handleRelayout empties the stored layout and asks for a render that runs
// dagre from nothing. The save that would record the result is debounced on
// layoutSig — visible agent ids plus the two size versions — and a relayout
// moves none of those, so storage stayed empty and the next load rebuilt the
// board from the replay, which packs it differently. Observed in a browser: R,
// then 2.5s past the 1.5s debounce, and `agent-dag.layout` was not there.
//
// Storing it by hand was not enough on its own. The board is rebuilt inside the
// memo that calls snapshotToFlow, and R's rerender() moved none of its deps, so
// the rebuild waited for the clock's next 250ms tick and the save 80ms later
// usually stored the empty board R had just cleared. Measured in a browser with
// the clock frozen: after R the board never changed at all. The reframe (#995)
// had the same race behind the same rerender(); both now move a counter the memo
// lists, so the render they schedule is the one that rebuilds.
import { describe, it, expect } from "vitest";
import { clientText } from "./client-source";

const app = clientText();

function relayout(): string {
  const start = app.indexOf("const handleRelayout = useCallback(");
  expect(start, "handleRelayout is gone").toBeGreaterThan(-1);
  return app.slice(start, app.indexOf("}, [", start));
}

describe("a relayout is what a reload brings back (#1331)", () => {
  it("stores the board R drew, after the render that draws it", () => {
    const body = relayout();
    // positionsRef holds nothing but the pins until the scheduled render has
    // run, so a save beside the clear would store the empty board.
    const bump = body.indexOf("setLayoutEpoch(e => e + 1);");
    expect(bump).toBeGreaterThan(-1);
    expect(body.slice(bump)).toMatch(/window\.setTimeout\(\(\) => \{[\s\S]*saveLayout\(positionsRef\.current, pinnedRef\.current\)/);
    expect(body.slice(0, bump)).not.toMatch(/saveLayout\(/);
  });

  it("stores the frame it was packed for, which the clear removed", () => {
    expect(relayout()).toMatch(/clearStoredLayout\(\);/);
    expect(relayout()).toMatch(/if \(lastLayoutFrameRef\.current\) saveLayoutFrame\(lastLayoutFrameRef\.current\);/);
  });

  it("rebuilds in the render it schedules, not on the next clock tick", () => {
    // The nodes memo lists the epoch, so moving it is what reruns snapshotToFlow.
    expect(app).toMatch(/snapshotToFlow\([\s\S]*?\[stateRef\.current, stateRef\.current\.revision, now,[^\]]*\blayoutEpoch\b[^\]]*\]/);
    // And both places that throw positions away move it, instead of a bare
    // rerender() the memo answers from its cache.
    const body = relayout();
    expect(body).not.toMatch(/\brerender\(\)/);
    const reframe = /columnsWouldChange\(nodes, edges, opts, prev, frame\)[\s\S]*?\}, \[availableWidth/.exec(app);
    expect(reframe, "the reframe effect is gone").not.toBeNull();
    expect(reframe![0]).toMatch(/setLayoutEpoch\(e => e \+ 1\);/);
    expect(reframe![0]).not.toMatch(/\brerender\(\)/);
  });
});
