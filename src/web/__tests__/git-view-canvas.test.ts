// The canvas beside the open git view keeps framing the selected session
// whatever moves under it: the board re-packing for a new window width, a side
// column opening, a reopen while the camera is still on its way back. And what
// the panel covers leaves the Tab order — cluster names as well as cards.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";

const view = sourceOf("components/GitView.tsx");
const reframe = sourceOf("use-reframe.ts");

describe("a window resize that re-packs the board", () => {
  it("frames for the open view from the new arrangement, before the auto-fit's own answer", () => {
    const at = reframe.indexOf("saveLayout(positionsRef.current, pinnedRef.current);");
    const after = reframe.slice(at, reframe.indexOf("if (autoFitDisabledRef.current)", at));
    expect(after).toMatch(/if \(frameForGitView\(0\)\) return;/);
  });
});

describe("the canvas changing size under the open view", () => {
  it("is watched while the view is open: the box is measured again and the camera frames again", () => {
    const at = view.indexOf("const ro = new ResizeObserver(");
    expect(at).toBeGreaterThan(-1);
    const effect = view.slice(view.lastIndexOf("useEffect(", at), view.indexOf("}, [want]);", at));
    expect(effect).toMatch(/if \(!want \|\| !canvas \|\| typeof ResizeObserver === "undefined"\) return;/);
    expect(effect).toMatch(/setBox\(prev => \(sameBox\(prev, measured\) \? prev : measured\)\);\s*frame\(0\);/);
    expect(effect).toMatch(/return \(\) => \{ ro\.disconnect\(\); cancelAnimationFrame\(raf\); \};/);
  });
});
